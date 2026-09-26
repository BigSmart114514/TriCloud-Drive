<template>
  <div class="flex h-full min-h-0 flex-col bg-gray-50">
    <div class="border-b bg-white px-4 py-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="text-xs text-gray-500">压缩包内容</p>
          <p class="truncate text-sm font-medium text-gray-900">{{ archiveName }}</p>
        </div>
        <input
          v-model="search"
          class="w-full rounded-md border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-500 sm:w-56"
          placeholder="搜索当前目录"
          type="search"
        />
      </div>
      <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
        <nav class="flex min-w-0 flex-wrap items-center gap-1">
          <template v-for="(crumb, index) in breadcrumbs" :key="crumb.path">
            <span v-if="index > 0" class="text-gray-300">/</span>
            <button class="max-w-[12rem] truncate hover:text-indigo-600" :class="{ 'font-medium text-indigo-600': index === breadcrumbs.length - 1 }" @click="goToPath(crumb.path)">
              {{ crumb.name }}
            </button>
          </template>
        </nav>
        <span>{{ totalCount }} 项<span v-if="visibleCount !== totalCount"> · 当前显示 {{ visibleCount }} 项</span></span>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
      <div v-if="error" class="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{{ error }}</div>
      <div v-if="skippedCount > 0" class="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
        已跳过 {{ skippedCount }} 个路径不安全或超出限制的条目。
      </div>
      <FileList
        v-if="!error"
        :folders="visibleFolders"
        :files="visibleFiles"
        :loading="loading"
        :selectable="false"
        :show-actions="false"
        :empty-title="search.trim() ? '没有匹配项' : '压缩包为空'"
        :empty-description="search.trim() ? '试试其他关键词。' : '当前目录没有文件或文件夹。'"
        @navigate-folder="navigateFolder"
        @preview-file="openFile"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, triggerRef, watch } from 'vue'
import FileList from '~/components/FileList.vue'
import type { FileListFile, FileListFolder } from '~~/types/file-list'
import type { ArchiveFileItem } from '~~/types/zip'
import type { SevenZipModule } from '7z-wasm'

interface DirectoryNode extends FileListFolder {
  path: string
  children: DirectoryNode[]
  files: ArchiveFileItem[]
}

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
const loading = ref(false)
const error = ref('')
const search = ref('')
const totalCount = ref(0)
const skippedCount = ref(0)
const currentPath = ref('')
const treeRevision = ref(0)
const root = shallowRef<DirectoryNode | null>(null)
const directoryLookup = new Map<string, DirectoryNode>()
const fileLookup = new Map<string, ArchiveFileItem>()
let sevenZip: SevenZipModule | null = null
let archivePath = '/archive.7z'
let output = ''
let extractId = 0
let loadId = 0

const createRoot = (): DirectoryNode => ({
  id: 'sevenzip-root',
  name: '压缩包',
  path: '',
  createdAt: null,
  children: [],
  files: []
})

const normalizePath = (value: string): string | null => {
  const raw = value.replace(/\\/g, '/')
  if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null
  const normalized = raw.replace(/^\.\/+/, '').replace(/\/+/g, '/').replace(/\/+$/, '')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.some(part => part === '.' || part === '..')) return null
  return parts.join('/')
}

const formatDate = (value?: string) => {
  if (!value) return null
  const date = new Date(value.replace(' ', 'T'))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const ensureDirectory = (path: string, createdAt: string | null): DirectoryNode => {
  const existing = directoryLookup.get(path)
  if (existing) {
    if (!existing.createdAt && createdAt) existing.createdAt = createdAt
    return existing
  }

  let current = root.value!
  let currentPath = ''
  for (const name of path ? path.split('/') : []) {
    currentPath = currentPath ? `${currentPath}/${name}` : name
    let child = current.children.find(item => item.name === name)
    if (!child) {
      child = {
        id: `folder:${currentPath}`,
        name,
        path: currentPath,
        createdAt,
        children: [],
        files: []
      }
      current.children.push(child)
      directoryLookup.set(currentPath, child)
    } else if (!child.createdAt && createdAt) {
      child.createdAt = createdAt
    }
    current = child
  }
  return current
}

const sortNode = (node: DirectoryNode) => {
  node.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  node.files.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' }))
  node.children.forEach(sortNode)
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

const load = async () => {
  if (typeof window === 'undefined') return
  const requestId = ++loadId
  loading.value = true
  error.value = ''
  closeEngine()
  if (requestId !== loadId) return

  search.value = ''
  currentPath.value = ''
  totalCount.value = 0
  skippedCount.value = 0
  directoryLookup.clear()
  fileLookup.clear()
  root.value = createRoot()
  directoryLookup.set('', root.value)
  treeRevision.value += 1

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
    const availableRecords = records.slice(0, MAX_ENTRIES)
    skippedCount.value = Math.max(0, records.length - availableRecords.length)
    totalCount.value = records.length

    availableRecords.forEach((record, index) => {
      const normalized = normalizePath(record.path)
      if (normalized === null) {
        skippedCount.value += 1
        return
      }
      const segments = normalized ? normalized.split('/') : []
      if (record.directory) {
        for (let i = 0; i < segments.length; i += 1) {
          ensureDirectory(segments.slice(0, i + 1).join('/'), record.modified || null)
        }
        return
      }
      if (segments.length === 0) return
      const filename = segments.pop()!
      const parent = ensureDirectory(segments.join('/'), record.modified || null)
      const key = `entry:${index}`
      const item: ArchiveFileItem = {
        id: key,
        key,
        path: normalized,
        filename,
        fileSize: record.size,
        compressedSize: record.packedSize,
        modifiedAt: record.modified,
        encrypted: record.encrypted,
        format: '7z',
        read: createRead(module, normalized)
      }
      parent.files.push(item)
      fileLookup.set(key, item)
    })

    sortNode(root.value)
    treeRevision.value += 1
    triggerRef(root)
  } catch (e: any) {
    error.value = e?.message || '无法读取压缩包内容'
    root.value = createRoot()
    treeRevision.value += 1
  } finally {
    if (requestId === loadId) loading.value = false
  }
}

const currentDirectory = computed(() => {
  const tree = root.value
  return directoryLookup.get(currentPath.value) || tree || createRoot()
})
const filteredChildren = computed(() => {
  treeRevision.value
  const query = search.value.trim().toLocaleLowerCase()
  const children = currentDirectory.value.children
  const files = currentDirectory.value.files
  if (!query) return { folders: children, files }
  return {
    folders: children.filter(folder => folder.name.toLocaleLowerCase().includes(query)),
    files: files.filter(file => file.filename.toLocaleLowerCase().includes(query))
  }
})
const visibleFolders = computed<FileListFolder[]>(() => filteredChildren.value.folders.map(folder => ({
  id: folder.id,
  name: folder.name,
  createdAt: folder.createdAt
})))
const visibleFiles = computed<FileListFile[]>(() => filteredChildren.value.files.map(file => ({
  id: file.id,
  filename: file.filename,
  fileSize: Number.isFinite(file.fileSize) ? Math.max(0, file.fileSize) : 0,
  createdAt: file.modifiedAt || null,
  contentType: ''
})))
const visibleCount = computed(() => visibleFolders.value.length + visibleFiles.value.length)
const breadcrumbs = computed(() => {
  const result = [{ name: '压缩包根目录', path: '' }]
  let path = ''
  for (const part of currentPath.value ? currentPath.value.split('/') : []) {
    path = path ? `${path}/${part}` : part
    result.push({ name: part, path })
  }
  return result
})

const goToPath = (path: string) => {
  if (directoryLookup.has(path)) currentPath.value = path
}
const navigateFolder = (folder: FileListFolder) => {
  goToPath(String(folder.id).replace(/^folder:/, ''))
}
const openFile = (file: FileListFile) => {
  const item = fileLookup.get(String(file.id))
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
