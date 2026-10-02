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
// zip / zip64 预览。目录树逻辑在 useArchiveTree（与 7z 预览共用），
// 这里只负责「用 zip.js 把 blob 读成记录」。
import { onBeforeUnmount, watch } from 'vue'
import FileList from '~/components/FileList.vue'
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
