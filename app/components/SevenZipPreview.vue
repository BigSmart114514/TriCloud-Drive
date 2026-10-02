<template>
  <ArchiveBrowser
    v-model:search="search"
    :archive-name="archiveName"
    :breadcrumbs="breadcrumbs"
    :total-count="totalCount"
    :visible-count="visibleCount"
    :error="error"
    :skipped-count="skippedCount"
    :loading="loading"
    :visible-folders="visibleFolders"
    :visible-files="visibleFiles"
    @go-to-path="goToPath"
    @navigate-folder="navigateFolder"
    @preview-file="openFile"
  />
</template>

<script setup lang="ts">
// 7z / rar / tar 等走 7z-wasm。
//
// 目录树逻辑在 useArchiveTree、界面在 ArchiveBrowser（两者都与 zip 预览共用），
// 这里只负责「用 7z 引擎把 blob 读成记录」—— 包括 `l -slt` 文本的解析，
// 那部分与 zip.js 没有交集，留在本文件。
import { onBeforeUnmount, watch } from 'vue'
import ArchiveBrowser from '~/components/ArchiveBrowser.vue'
import type { FileListFile } from '~~/types/file-list'
import type { ArchiveFileItem } from '~~/types/zip'
import type { SevenZipModule } from '7z-wasm'

interface ListingRecord {
  path: string
  size: number
  packedSize: number
  modified: string
  encrypted: boolean
  directory: boolean
}

const props = defineProps<{
  archive: Blob
  archiveName: string
}>()

const emit = defineEmits<{
  'open-entry': [item: ArchiveFileItem]
}>()

const MAX_ENTRIES = 50000

// 这份解构**不能**改成 `const tree = useArchiveTree(...)` 然后 `:tree="tree"`：
// setupState 只对顶层绑定解包 Ref，嵌套在普通对象里的 Ref 在模板里不解包，
// `tree.search` 会渲染成 [object Object]，v-model 还会把 Ref 整个替换掉。
// ArchiveBrowser.vue 那边有同样这段说明。
const {
  loading,
  error,
  search,
  totalCount,
  skippedCount,
  visibleFolders,
  visibleFiles,
  visibleCount,
  breadcrumbs,
  beginLoad,
  ingest,
  failTree,
  endLoad,
  goToPath,
  navigateFolder,
  findFile
} = useArchiveTree({ rootId: 'sevenzip-root', maxEntries: MAX_ENTRIES })

let sevenZip: SevenZipModule | null = null
let archivePath = '/archive.7z'
let output = ''
let extractId = 0
let loadId = 0

/** 7z 的 `l -slt` 里时间是 `YYYY-MM-DD hh:mm:ss`，Date 解析不了那个空格 */
const formatDate = (value?: string) => {
  if (!value) return null
  const date = new Date(value.replace(' ', 'T'))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const run = (args: string[]) => {
  if (!sevenZip) throw new Error('7z 引擎尚未初始化')
  output = ''
  try {
    sevenZip.callMain(args)
  } catch (e) {
    const message = output.trim()
    if (message) throw new Error(message)
    throw e
  }
  return output
}

const runOnModule = (module: SevenZipModule, args: string[]) => {
  if (sevenZip !== module) throw new Error('7z 会话已结束')
  output = ''
  try {
    module.callMain(args)
  } catch (e) {
    const message = output.trim()
    if (message) throw new Error(message)
    throw e
  }
  return output
}

/** 解析 `7z l -slt` 的输出：每条记录是若干 `Key = value`，Path 开头 */
const parseListing = (value: string): ListingRecord[] => {
  const text = value.includes('\n') ? value : value.replace(/\\n/g, '\n')
  const records: ListingRecord[] = []
  let fields = new Map<string, string>()
  const flush = () => {
    const path = fields.get('Path')
    if (path && (fields.has('Size') || fields.has('Folder'))) {
      const attributes = fields.get('Attributes') || ''
      records.push({
        path,
        size: Math.max(0, Number(fields.get('Size')) || 0),
        packedSize: Math.max(0, Number(fields.get('Packed Size')) || 0),
        modified: formatDate(fields.get('Modified')) || '',
        encrypted: fields.get('Encrypted') === '+' || /^(yes|true)$/i.test(fields.get('Encrypted') || ''),
        directory: fields.get('Folder') === '+' || /[\\/]$/.test(path) || /^D(?:\s|$)/.test(attributes)
      })
    }
    fields = new Map<string, string>()
  }

  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf(' = ')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    if (key === 'Path') flush()
    fields.set(key, line.slice(separator + 3).trim())
  }
  flush()
  return records
}

/** 解压到一个临时目录，读完删掉。递归删除，失败就放弃（引擎有自己的沙箱） */
const removeTree = (module: SevenZipModule, path: string) => {
  try {
    const entries = module.FS.readdir(path)
    for (const entry of entries) {
      if (entry === '.' || entry === '..') continue
      const child = `${path}/${entry}`
      const stat = module.FS.stat(child)
      if (module.FS.isDir(stat.mode)) removeTree(module, child)
      else module.FS.unlink(child)
    }
    module.FS.rmdir(path)
  } catch {
    return
  }
}

const closeEngine = () => {
  const current = sevenZip
  sevenZip = null
  if (!current) return
  try {
    current.FS.unlink(archivePath)
  } catch {
    return
  }
}

/** 单条解压。整个包已经在引擎里了，按路径取出其中一个文件 */
const createRead = (module: SevenZipModule, path: string) => async ({ password, signal }: { password?: string; signal?: AbortSignal } = {}) => {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const destination = `/__extract_${++extractId}`
  const args = ['x', archivePath, `-o${destination}`, '-y']
  if (password !== undefined) args.push(`-p${password}`)
  args.push(path)
  try {
    runOnModule(module, args)
    const data = module.FS.readFile(`${destination}/${path}`)
    return new Blob([data], { type: 'application/octet-stream' })
  } finally {
    removeTree(module, destination)
  }
}

const load = async () => {
  if (typeof window === 'undefined') return
  const requestId = ++loadId
  closeEngine()
  if (requestId !== loadId) return

  beginLoad()

  try {
    const factory = (await import('7z-wasm')).default
    const module = await factory({
      noExitRuntime: true,
      print: (value: string) => { output += `${value}\n` },
      printErr: (value: string) => { output += `${value}\n` }
    })
    if (requestId !== loadId) return
    sevenZip = module
    module.FS.writeFile(archivePath, new Uint8Array(await props.archive.arrayBuffer()))
    const listingOutput = run(['l', '-slt', archivePath])
    const records = parseListing(listingOutput)
    if (!listingOutput.includes('Type =')) throw new Error('7z 引擎未返回有效的目录信息')

    ingest(
      records.map(record => ({
        path: record.path,
        directory: record.directory,
        fileSize: record.size,
        compressedSize: record.packedSize,
        modifiedAt: record.modified,
        encrypted: record.encrypted,
        read: createRead(module, record.path)
      })),
      '7z'
    )
  } catch (e: any) {
    failTree(e?.message || '无法读取压缩包内容')
  } finally {
    if (requestId === loadId) endLoad()
  }
}

const openFile = (file: FileListFile) => {
  const item = findFile(file)
  if (item) emit('open-entry', item)
}

watch(() => props.archive, () => {
  void load()
}, { immediate: true })

onBeforeUnmount(() => {
  loadId += 1
  closeEngine()
})
</script>
