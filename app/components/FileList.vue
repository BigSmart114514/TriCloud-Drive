<template>
  <div :class="framed ? 'bg-white rounded-lg shadow p-4 sm:p-6 transition-colors' : 'transition-colors'">
    <div v-if="loading" class="text-center py-8">
      <div class="inline-flex items-center">
        <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-indigo-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        <span class="text-gray-600">加载中...</span>
      </div>
    </div>

    <div v-else-if="hasItems" class="space-y-3">
      <div
        v-for="folder in folders"
        :key="`folder-${folder.id}`"
        class="flex items-center gap-2 p-3 sm:p-4 border border-gray-200 rounded-lg hover:bg-gray-50"
      >
        <div class="flex items-center gap-3 flex-1 min-w-0">
          <input
            v-if="selectable"
            type="checkbox"
            class="h-4 w-4 shrink-0 text-indigo-600 rounded border-gray-300"
            :checked="selectedFolderIds?.has(folder.id) || false"
            @change.stop="emit('toggle-folder', folder)"
            @click.stop
            :title="`选择文件夹：${folder.name}`"
          />
          <div class="shrink-0 cursor-pointer" @click="emit('navigate-folder', folder)">
            <svg class="h-8 w-8 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
              <path d="M2 6a2 2 0 012-2h3l2 2h7a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
            </svg>
          </div>
          <div class="flex-1 min-w-0 cursor-pointer" @click="emit('navigate-folder', folder)">
            <p class="text-sm sm:text-base font-medium text-gray-900 truncate">{{ folder.name }}</p>
            <p v-if="folder.relDir" class="text-xs text-gray-400 truncate" :title="folder.relDir">{{ folder.relDir }}</p>
            <p v-if="formatDate(folder.createdAt)" class="text-xs sm:text-sm text-gray-500 truncate">{{ formatDate(folder.createdAt) }}</p>
          </div>
        </div>

        <div v-if="showActions" class="flex items-center gap-1 shrink-0">
          <div class="hidden sm:flex items-center gap-0.5">
            <button
              class="p-1 text-sm text-blue-600 hover:text-blue-500"
              @click.stop="emit('download-folder', folder)"
              :disabled="downloadingFolderId === folder.id"
              title="下载"
              aria-label="下载"
            >
              <svg v-if="downloadingFolderId === folder.id" class="animate-spin h-5 w-5 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <ArrowDownTrayIcon v-else class="h-5 w-5" />
            </button>
            <button class="p-1 text-sm text-red-600 hover:text-red-500" @click.stop="emit('delete-folder', folder)" title="删除" aria-label="删除">
              <TrashIcon class="h-5 w-5" />
            </button>
            <button class="p-1 text-sm text-gray-600 hover:text-gray-800" @click.stop="emit('rename-folder', folder)" title="重命名" aria-label="重命名">
              <PencilSquareIcon class="h-5 w-5" />
            </button>
            <button class="p-1 text-sm text-indigo-600 hover:text-indigo-500" @click.stop="emit('clip-folder', folder)" title="剪贴" aria-label="剪贴">
              <ScissorsIcon class="h-5 w-5" />
            </button>
            <button class="p-1 text-sm text-indigo-600 hover:text-indigo-500" @click.stop="emit('copy-folder', folder)" title="复制" aria-label="复制">
              <DocumentDuplicateIcon class="h-5 w-5" />
            </button>
            <button class="p-1 text-sm text-emerald-600 hover:text-emerald-500" @click.stop="emit('share-folder', folder)" title="分享" aria-label="分享">
              <ShareIcon class="h-5 w-5" />
            </button>
          </div>
          <div class="flex sm:hidden items-center gap-1">
            <button class="p-1 text-blue-600 hover:text-blue-500" :disabled="downloadingFolderId === folder.id" @click.stop="emit('download-folder', folder)" title="下载" aria-label="下载">
              <ArrowDownTrayIcon class="h-5 w-5" />
            </button>
            <button class="p-1 text-gray-600 hover:text-gray-800" @click.stop="openRowMenu('folder', folder)" title="更多" aria-label="更多">
              <EllipsisVerticalIcon class="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>

      <div
        v-for="file in files"
        :key="`file-${file.id}`"
        class="flex items-center gap-2 p-3 sm:p-4 border border-gray-200 rounded-lg hover:bg-gray-50"
      >
        <div class="flex items-center gap-3 flex-1 min-w-0">
          <input
            v-if="selectable"
            type="checkbox"
            class="h-4 w-4 shrink-0 text-indigo-600 rounded border-gray-300"
            :checked="selectedFileIds?.has(file.id) || false"
            @change.stop="emit('toggle-file', file)"
            @click.stop
            :title="`选择文件：${file.filename}`"
          />
          <div class="shrink-0">
            <FileIcon class="h-8 w-8 text-gray-400" :filename="file.filename" />
          </div>
          <div class="flex-1 min-w-0 cursor-pointer" @click="emit('preview-file', file)">
            <p class="text-sm sm:text-base font-medium text-gray-900 truncate">{{ file.filename }}</p>
            <p v-if="file.relDir" class="text-xs text-gray-400 truncate" :title="file.relDir">{{ file.relDir }}</p>
            <p class="text-xs sm:text-sm text-gray-500 truncate">
              {{ formatFileSize(file.fileSize) }}<span v-if="formatDate(file.createdAt)"> • {{ formatDate(file.createdAt) }}</span>
            </p>
          </div>
        </div>

        <div v-if="showActions" class="flex items-center gap-1 shrink-0">
          <div class="hidden sm:flex items-center gap-0.5">
            <button class="p-1 text-sm text-blue-600 hover:text-blue-500" @click.stop="emit('download-file', file)" title="下载" aria-label="下载">
              <ArrowDownTrayIcon class="h-5 w-5" />
            </button>
            <button class="p-1 text-sm text-gray-600 hover:text-gray-800" @click.stop="emit('rename-file', file)" title="重命名" aria-label="重命名">
              <PencilSquareIcon class="h-5 w-5" />
            </button>
            <button class="p-1 text-sm text-red-600 hover:text-red-500" @click.stop="emit('delete-file', file)" title="删除" aria-label="删除">
              <TrashIcon class="h-5 w-5" />
            </button>
            <button class="p-1 text-sm text-indigo-600 hover:text-indigo-500" @click.stop="emit('clip-file', file)" title="剪贴" aria-label="剪贴">
              <ScissorsIcon class="h-5 w-5" />
            </button>
            <button class="p-1 text-sm text-indigo-600 hover:text-indigo-500" @click.stop="emit('copy-file', file)" title="复制" aria-label="复制">
              <DocumentDuplicateIcon class="h-5 w-5" />
            </button>
            <button class="p-1 text-sm text-emerald-600 hover:text-emerald-500" @click.stop="emit('share-file', file)" title="分享" aria-label="分享">
              <ShareIcon class="h-5 w-5" />
            </button>
          </div>
          <div class="flex sm:hidden items-center gap-1">
            <button class="p-1 text-blue-600 hover:text-blue-500" @click.stop="emit('download-file', file)" title="下载" aria-label="下载">
              <ArrowDownTrayIcon class="h-5 w-5" />
            </button>
            <button class="p-1 text-gray-600 hover:text-gray-800" @click.stop="openRowMenu('file', file)" title="更多" aria-label="更多">
              <EllipsisVerticalIcon class="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="text-center py-8">
      <svg class="mx-auto h-12 w-12 text-gray-400" stroke="currentColor" fill="none" viewBox="0 0 48 48">
        <path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <h3 class="mt-2 text-sm font-medium text-gray-900">{{ emptyTitle }}</h3>
      <p class="mt-1 text-sm text-gray-500">{{ emptyDescription }}</p>
    </div>

    <transition name="fade">
      <div v-if="rowMenuOpen" class="fixed inset-0 z-50 sm:hidden">
        <div class="absolute inset-0 bg-black/30" @click="closeRowMenu" />
        <div data-liquid class="ui-glass absolute inset-x-0 bottom-0 bg-white rounded-t-2xl p-3 pb-[calc(env(safe-area-inset-bottom)+12px)] shadow-xl">
          <div class="mx-auto h-1.5 w-12 rounded bg-gray-300 mb-3" />
          <!-- 文件 6 项排 3×2，文件夹 5 项排一行，避免落单换行 -->
          <div
            class="grid gap-2 text-center text-xs"
            :class="rowMenu?.type === 'file' ? 'grid-cols-3' : 'grid-cols-5'"
          >
            <template v-if="rowMenu?.type === 'file'">
              <button class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center" @click="runFileAction('preview-file')">
                <EyeIcon class="h-6 w-6 text-gray-700" />
                <span class="mt-1">预览</span>
              </button>
              <button class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center" @click="runFileAction('rename-file')">
                <PencilSquareIcon class="h-6 w-6 text-gray-700" />
                <span class="mt-1">重命名</span>
              </button>
              <button class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center" @click="runFileAction('delete-file')">
                <TrashIcon class="h-6 w-6 text-red-600" />
                <span class="mt-1">删除</span>
              </button>
              <button class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center" @click="runFileAction('clip-file')">
                <ScissorsIcon class="h-6 w-6 text-indigo-600" />
                <span class="mt-1">剪贴</span>
              </button>
              <button class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center" @click="runFileAction('copy-file')">
                <DocumentDuplicateIcon class="h-6 w-6 text-indigo-600" />
                <span class="mt-1">复制</span>
              </button>
              <button class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center" @click="runFileAction('share-file')">
                <ShareIcon class="h-6 w-6 text-emerald-600" />
                <span class="mt-1">分享</span>
              </button>
            </template>
            <template v-else-if="rowMenu?.type === 'folder'">
              <button class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center" @click="runFolderAction('rename-folder')">
                <PencilSquareIcon class="h-6 w-6 text-gray-700" />
                <span class="mt-1">重命名</span>
              </button>
              <button class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center" @click="runFolderAction('delete-folder')">
                <TrashIcon class="h-6 w-6 text-red-600" />
                <span class="mt-1">删除</span>
              </button>
              <button class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center" @click="runFolderAction('clip-folder')">
                <ScissorsIcon class="h-6 w-6 text-indigo-600" />
                <span class="mt-1">剪贴</span>
              </button>
              <button class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center" @click="runFolderAction('copy-folder')">
                <DocumentDuplicateIcon class="h-6 w-6 text-indigo-600" />
                <span class="mt-1">复制</span>
              </button>
              <button class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center" @click="runFolderAction('share-folder')">
                <ShareIcon class="h-6 w-6 text-emerald-600" />
                <span class="mt-1">分享</span>
              </button>
            </template>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { formatFileSize } from '~/utils/format'
import { formatDateTime } from '~/utils/time'
import FileIcon from '~/components/FileIcon.vue'
import type { FileListFile, FileListFolder, FileListId } from '~~/types/file-list'
import {
  ArrowDownTrayIcon,
  DocumentDuplicateIcon,
  EllipsisVerticalIcon,
  EyeIcon,
  PencilSquareIcon,
  ScissorsIcon,
  ShareIcon,
  TrashIcon
} from '@heroicons/vue/24/outline'

const props = withDefaults(defineProps<{
  folders?: FileListFolder[]
  files?: FileListFile[]
  loading?: boolean
  selectable?: boolean
  showActions?: boolean
  framed?: boolean
  downloadingFolderId?: FileListId | null
  selectedFolderIds?: ReadonlySet<FileListId>
  selectedFileIds?: ReadonlySet<FileListId>
  emptyTitle?: string
  emptyDescription?: string
}>(), {
  folders: () => [],
  files: () => [],
  loading: false,
  selectable: true,
  showActions: true,
  framed: true,
  downloadingFolderId: null,
  selectedFolderIds: undefined,
  selectedFileIds: undefined,
  emptyTitle: '这里空空如也',
  emptyDescription: '当前目录没有可显示的内容。'
})

const emit = defineEmits<{
  'navigate-folder': [folder: FileListFolder]
  'preview-file': [file: FileListFile]
  'toggle-folder': [folder: FileListFolder]
  'toggle-file': [file: FileListFile]
  'download-folder': [folder: FileListFolder]
  'delete-folder': [folder: FileListFolder]
  'rename-folder': [folder: FileListFolder]
  'clip-folder': [folder: FileListFolder]
  'copy-folder': [folder: FileListFolder]
  'download-file': [file: FileListFile]
  'delete-file': [file: FileListFile]
  'rename-file': [file: FileListFile]
  'clip-file': [file: FileListFile]
  'copy-file': [file: FileListFile]
  'share-file': [file: FileListFile]
  'share-folder': [folder: FileListFolder]
}>()

const hasItems = computed(() => props.folders.length + props.files.length > 0)
const rowMenuOpen = ref(false)
const rowMenu = ref<{ type: 'file' | 'folder'; item: FileListFile | FileListFolder } | null>(null)

const formatDate = (value?: string | null) => formatDateTime(value)

const openRowMenu = (type: 'file' | 'folder', item: FileListFile | FileListFolder) => {
  rowMenu.value = { type, item }
  rowMenuOpen.value = true
}

const closeRowMenu = () => {
  rowMenuOpen.value = false
  rowMenu.value = null
}

const runFileAction = (
  action: 'preview-file' | 'rename-file' | 'delete-file' | 'clip-file' | 'copy-file' | 'share-file'
) => {
  if (rowMenu.value?.type !== 'file') return
  const file = rowMenu.value.item as FileListFile
  if (action === 'preview-file') emit('preview-file', file)
  if (action === 'rename-file') emit('rename-file', file)
  if (action === 'delete-file') emit('delete-file', file)
  if (action === 'clip-file') emit('clip-file', file)
  if (action === 'copy-file') emit('copy-file', file)
  if (action === 'share-file') emit('share-file', file)
  closeRowMenu()
}

const runFolderAction = (
  action: 'rename-folder' | 'delete-folder' | 'clip-folder' | 'copy-folder' | 'share-folder'
) => {
  if (rowMenu.value?.type !== 'folder') return
  const folder = rowMenu.value.item as FileListFolder
  if (action === 'rename-folder') emit('rename-folder', folder)
  if (action === 'delete-folder') emit('delete-folder', folder)
  if (action === 'clip-folder') emit('clip-folder', folder)
  if (action === 'copy-folder') emit('copy-folder', folder)
  if (action === 'share-folder') emit('share-folder', folder)
  closeRowMenu()
}
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
