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
// zip / zip64 预览。
//
// 目录树逻辑在 useArchiveTree、界面在 ArchiveBrowser（两者都与 7z 预览共用），
// 这里只负责「用 zip.js 把 blob 读成记录」。
import { onBeforeUnmount, watch } from 'vue'
import ArchiveBrowser from '~/components/ArchiveBrowser.vue'
import type { FileListFile } from '~~/types/file-list'
import type { ArchiveFileItem } from '~~/types/zip'

interface ZipReaderLike {
  getEntries: () => Promise<any[]>
  close: () => Promise<void>
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
} = useArchiveTree({ rootId: 'zip-root', maxEntries: MAX_ENTRIES })

let reader: ZipReaderLike | null = null
let loadId = 0

const formatDate = (date: Date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

const closeReader = async () => {
  const current = reader
  reader = null
  if (current) {
    try {
      await current.close()
    } catch {
      return
    }
  }
}

const load = async () => {
  if (typeof window === 'undefined') return
  const requestId = ++loadId
  await closeReader()
  if (requestId !== loadId) return

  // 先清空旧树再解析：换包时界面立刻反映「正在加载新内容」
  beginLoad()

  try {
    const zip = await import('@zip.js/zip.js')
    const nextReader = new zip.ZipReader(new zip.BlobReader(props.archive), { useWebWorkers: false } as any) as unknown as ZipReaderLike
    reader = nextReader
    const entries = await nextReader.getEntries()
    if (requestId !== loadId) {
      await nextReader.close()
      return
    }

    ingest(
      entries.map((entry: any) => {
        const rawName = String(entry.filename || '')
        return {
          path: rawName,
          // 末尾带分隔符的条目是目录，zip.js 有些版本不给 directory 标志
          directory: !!entry.directory || /[\\/]$/.test(rawName),
          fileSize: Math.max(0, Number(entry.uncompressedSize) || 0),
          compressedSize: Math.max(0, Number(entry.compressedSize) || 0),
          modifiedAt: formatDate(entry.lastModDate) || '',
          encrypted: !!entry.encrypted,
          read: async ({ password, signal }: { password?: string; signal?: AbortSignal } = {}) => {
            const options: Record<string, unknown> = {
              checkSignature: true,
              useWebWorkers: false
            }
            if (signal) options.signal = signal
            if (password !== undefined) options.password = password
            return entry.getData(new zip.BlobWriter(), options)
          }
        }
      }),
      'zip'
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
  void closeReader()
})
</script>
