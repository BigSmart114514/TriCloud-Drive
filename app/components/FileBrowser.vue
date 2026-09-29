<template>
  <div
    class="bg-white transition-colors"
    :class="[
      fill ? 'flex h-full min-h-0 flex-col p-0' : 'rounded-lg shadow p-4 sm:p-6',
      { 'border-2 border-dashed border-indigo-400 bg-indigo-50': isDragging && isOwn }
    ]"
    @dragover="isOwn && $event.preventDefault()"
    @dragenter="isOwn && onDragEnter()"
    @dragleave="isOwn && onDragLeave()"
    @drop="isOwn && handleDrop($event)"
  >
    <div
      class="flex items-center justify-between gap-2"
      :class="fill ? 'shrink-0 px-4 py-3' : 'mb-4 flex-wrap'"
    >
      <div class="flex items-center gap-2 min-w-0">
        <input
          ref="masterCheckboxRef"
          type="checkbox"
          class="h-4 w-4 text-indigo-600 rounded border-gray-300 hidden sm:block"
          :checked="isAllSelected"
          :disabled="!hasItems"
          @change="toggleSelectAll"
          title="全选/全不选"
        />
        <h3 class="text-lg font-medium text-gray-900 shrink-0">{{ title || defaultTitle }}</h3>
        <nav class="text-sm text-gray-500 overflow-x-auto whitespace-nowrap no-scrollbar max-w-[60vw] sm:max-w-none">
          <span v-for="(crumb, idx) in breadcrumbs" :key="String(crumb.id) + '-' + idx">
            <span v-if="idx > 0" class="mx-1">/</span>
            <button class="hover:text-indigo-600" @click="handleGoToBreadcrumb(idx)" :disabled="idx === breadcrumbs.length - 1">
              {{ crumb.name }}
            </button>
          </span>
        </nav>
      </div>

      <div class="flex items-center gap-2">
        <button
          v-if="breadcrumbs.length > 1"
          class="p-1 text-sm text-gray-600 hover:text-gray-800"
          @click="handleGoUp"
          title="返回上一级"
          aria-label="返回上一级"
        >
          <ArrowLeftIcon class="h-5 w-5" />
        </button>
        <button
          class="p-1 text-sm text-red-600 hover:text-red-500 disabled:opacity-50 hidden sm:inline-flex"
          :disabled="selectedCount === 0 || bulkDeleting"
          @click="deleteSelected"
          title="删除所选"
          aria-label="删除所选"
        >
          <TrashIcon class="h-5 w-5" />
        </button>
        <button
          class="p-1 text-sm text-indigo-600 hover:text-indigo-500 disabled:opacity-50 hidden sm:inline-flex"
          :disabled="selectedCount === 0 || bulkDownloading"
          @click="downloadSelected"
          title="下载所选"
          aria-label="下载所选"
        >
          <ArrowDownTrayIcon class="h-5 w-5" />
        </button>
        <button
          v-if="isOwn"
          class="p-1 text-sm text-indigo-600 hover:text-indigo-500 disabled:opacity-50 hidden sm:inline-flex"
          :disabled="selectedCount === 0"
          @click="clipSelection"
          title="剪贴所选（移动）"
          aria-label="剪贴所选（移动）"
        >
          <ScissorsIcon class="h-5 w-5" />
        </button>
        <button
          v-if="isOwn"
          class="p-1 text-sm text-indigo-600 hover:text-indigo-500 disabled:opacity-50 hidden sm:inline-flex"
          :disabled="selectedCount === 0"
          @click="copySelection"
          title="复制所选（拷贝）"
          aria-label="复制所选（拷贝）"
        >
          <DocumentDuplicateIcon class="h-5 w-5" />
        </button>
        <button
          v-if="isOwn"
          class="p-1 text-sm text-green-600 hover:text-green-500 disabled:opacity-50 hidden sm:inline-flex"
          :disabled="!hasClipboard || pasting"
          @click="pasteClipboard"
          :title="clipboard?.mode === 'cut' ? '移动到当前文件夹' : '复制到当前文件夹'"
          aria-label="粘贴到当前文件夹"
        >
          <ClipboardDocumentCheckIcon class="h-5 w-5" />
        </button>
        <span v-if="isOwn && hasClipboard" class="text-xs text-gray-500 hidden sm:inline">{{ clipboardActionLabel }} {{ clipboardCount }} 项</span>

        <div v-if="isOwn" ref="uploadMenuRef" class="relative" @mouseenter="openUploadMenu()" @mouseleave="scheduleCloseUploadMenu()">
          <button
            class="p-1 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700"
            @click.stop="toggleUploadMenu"
            title="上传"
            aria-label="上传"
          >
            <ArrowUpTrayIcon class="h-5 w-5" />
          </button>
          <div v-if="showUploadMenu" class="fixed inset-0 z-10 sm:hidden" @click="closeUploadMenu" />
          <transition name="fade-slide">
            <div
              v-show="showUploadMenu"
              class="absolute right-0 mt-2 w-44 z-20 bg-white border border-gray-200 rounded-md shadow-lg"
              @mouseenter="openUploadMenu()"
              @mouseleave="scheduleCloseUploadMenu()"
            >
              <button class="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2" @click="fileInputRef?.click()">
                <DocumentArrowUpIcon class="h-5 w-5 text-gray-500" />
                上传文件
              </button>
              <button class="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2" @click="folderInputRef?.click()">
                <FolderPlusIcon class="h-5 w-5 text-gray-500" />
                上传文件夹
              </button>
              <div class="px-4 py-2 border-t border-gray-100">
                <div class="space-y-2 text-xs text-gray-600">
                  <label class="flex items-center gap-2"><input v-model="conflictStrategy" type="radio" name="upload-conflict" value="overwrite" class="text-indigo-600" />同名时覆盖</label>
                  <label class="flex items-center gap-2"><input v-model="conflictStrategy" type="radio" name="upload-conflict" value="skip" class="text-indigo-600" />同名时跳过</label>
                  <label class="flex items-center gap-2"><input v-model="conflictStrategy" type="radio" name="upload-conflict" value="rename" class="text-indigo-600" />自动重命名</label>
                </div>
              </div>
            </div>
          </transition>
        </div>

        <button
          v-if="isOwn"
          class="p-1 text-sm text-indigo-600 hover:text-indigo-500 hidden sm:inline-flex"
          @click="createFolder"
          title="新建文件夹"
          aria-label="新建文件夹"
        >
          <FolderPlusIcon class="h-5 w-5" />
        </button>
        <button class="p-1 text-sm text-indigo-600 hover:text-indigo-500" @click="fetchFiles" title="刷新" aria-label="刷新">
          <ArrowPathIcon class="h-5 w-5" />
        </button>

        <div class="relative sm:hidden">
          <button class="p-1 text-gray-600 hover:text-gray-800" @click.stop="mobileMoreOpen = !mobileMoreOpen" title="更多" aria-label="更多">
            <EllipsisVerticalIcon class="h-5 w-5" />
          </button>
          <template v-if="mobileMoreOpen">
            <div class="fixed inset-0 z-10" @click="mobileMoreOpen = false" />
            <div class="absolute right-0 mt-2 w-48 z-20 bg-white border border-gray-200 rounded-md shadow-lg py-1">
              <button class="w-full px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2 text-gray-700" :disabled="selectedCount === 0 || bulkDeleting" @click="deleteSelected(); mobileMoreOpen = false">
                <TrashIcon class="h-5 w-5 text-red-600" />删除所选
              </button>
              <button class="w-full px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2 text-gray-700" :disabled="selectedCount === 0 || bulkDownloading" @click="downloadSelected(); mobileMoreOpen = false">
                <ArrowDownTrayIcon class="h-5 w-5 text-indigo-600" />下载所选
              </button>
              <button v-if="isOwn" class="w-full px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2 text-gray-700" :disabled="selectedCount === 0" @click="clipSelection(); mobileMoreOpen = false">
                <ScissorsIcon class="h-5 w-5 text-indigo-600" />剪贴所选
              </button>
              <button v-if="isOwn" class="w-full px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2 text-gray-700" :disabled="selectedCount === 0" @click="copySelection(); mobileMoreOpen = false">
                <DocumentDuplicateIcon class="h-5 w-5 text-indigo-600" />复制所选
              </button>
              <button v-if="isOwn" class="w-full px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2 text-gray-700" :disabled="!hasClipboard || pasting" @click="pasteClipboard(); mobileMoreOpen = false">
                <ClipboardDocumentCheckIcon class="h-5 w-5 text-green-600" />{{ clipboard?.mode === 'cut' ? '粘贴（移动）' : '粘贴（复制）' }}
              </button>
              <div class="border-t border-gray-100 my-1" />
              <button v-if="isOwn" class="w-full px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2 text-gray-700" @click="createFolder(); mobileMoreOpen = false">
                <FolderPlusIcon class="h-5 w-5 text-indigo-600" />新建文件夹
              </button>
            </div>
          </template>
        </div>
      </div>
    </div>

    <input v-if="isOwn" ref="fileInputRef" type="file" multiple class="hidden" @change="handleFileSelect" />
    <input v-if="isOwn" ref="folderInputRef" type="file" webkitdirectory directory multiple class="hidden" @change="handleFolderSelect" />

    <div
      v-if="isOwn && uploading"
      :class="fill ? 'mx-4 mt-3 shrink-0' : 'mt-2 mb-4'"
    >
      <div class="flex items-center justify-between text-sm text-gray-600 mb-2">
        <span>上传中...</span>
        <span>{{ uploadProgress.percent }}%</span>
      </div>
      <div class="w-full bg-gray-200 rounded-full h-2">
        <div class="bg-indigo-600 h-2 rounded-full transition-all duration-300" :style="{ width: `${uploadProgress.percent}%` }" />
      </div>
    </div>
    <div
      v-if="isOwn && uploadError"
      :class="fill ? 'mx-4 mt-3 shrink-0 rounded-md bg-red-50 p-3 text-sm text-red-700' : 'mt-2 mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700'"
    >{{ uploadError }}</div>

    <div
      v-if="listError"
      :class="fill ? 'mx-4 mt-3 shrink-0 rounded-md bg-red-50 p-3 text-sm text-red-700' : 'mt-2 mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700'"
    >{{ listError }}</div>

    <!-- fill 模式下由本层承载滚动，页面本身不再被列表撑高 -->
    <div :class="fill ? 'min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-24 lg:pb-4' : ''">
      <FileList
        :folders="folders"
        :files="files"
        :loading="loading"
        :selectable="true"
        :show-actions="true"
        :framed="false"
        :downloading-folder-id="downloadingFolderId"
        :selected-folder-ids="selectedFolderIds"
        :selected-file-ids="selectedFileIds"
        empty-title="这里空空如也"
        :empty-description="emptyDescription"
        @navigate-folder="onNavigateFolder"
        @preview-file="onPreviewFile"
        @toggle-folder="onToggleFolder"
        @toggle-file="onToggleFile"
        @download-folder="onDownloadFolder"
        @delete-folder="onDeleteFolder"
        @rename-folder="onRenameFolder"
        :show-clip="isOwn"
        :can-share="canShare"
        @clip-folder="onClipFolder"
        @copy-folder="onCopyFolder"
        @download-file="onDownloadFile"
        @delete-file="onDeleteFile"
        @rename-file="onRenameFile"
      @clip-file="onClipFile"
      @copy-file="onCopyFile"
      @share-file="onShareFile"
      @share-folder="onShareFolder"
    />
    </div>

    <ShareDialog
      :open="shareTarget !== null"
      :target-type="shareTarget?.type ?? 'file'"
      :target-id="shareTarget?.id ?? null"
      :name="shareTarget?.name ?? ''"
      @close="shareTarget = null"
    />

    <transition name="slide-up">
      <div v-show="selectedCount > 0" data-liquid class="ui-glass fixed bottom-0 inset-x-0 z-40 sm:hidden bg-white border-t px-3 py-2 pb-[calc(env(safe-area-inset-bottom)+8px)]">
        <div class="flex items-center justify-between">
          <span class="text-sm text-gray-700">已选 {{ selectedCount }} 项</span>
          <div class="flex items-center gap-3">
            <button class="p-1 text-red-600 disabled:opacity-50" :disabled="bulkDeleting" @click="deleteSelected" title="删除" aria-label="删除">
              <TrashIcon class="h-5 w-5" />
            </button>
            <button class="p-1 text-indigo-600 disabled:opacity-50" :disabled="bulkDownloading" @click="downloadSelected" title="下载" aria-label="下载">
              <ArrowDownTrayIcon class="h-5 w-5" />
            </button>
            <button v-if="isOwn" class="p-1 text-indigo-600 disabled:opacity-50" :disabled="selectedCount === 0" @click="clipSelection" title="剪贴" aria-label="剪贴">
              <ScissorsIcon class="h-5 w-5" />
            </button>
            <button v-if="isOwn" class="p-1 text-indigo-600 disabled:opacity-50" :disabled="selectedCount === 0" @click="copySelection" title="复制" aria-label="复制">
              <DocumentDuplicateIcon class="h-5 w-5" />
            </button>
            <button v-if="isOwn" class="p-1 text-green-600 disabled:opacity-50" :disabled="!hasClipboard || pasting" @click="pasteClipboard" title="粘贴" aria-label="粘贴">
              <ClipboardDocumentCheckIcon class="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>
    </transition>

    <button
      v-if="isOwn"
      class="fixed sm:hidden bottom-[72px] right-4 h-12 w-12 rounded-full bg-indigo-600 text-white shadow-lg flex items-center justify-center"
      @click.stop="chooseFiles"
      title="上传"
      aria-label="上传"
    >
      <ArrowUpTrayIcon class="h-6 w-6" />
    </button>

    <FilePreviewer
      v-if="previewingFile"
      :file="previewingFile"
      :current-folder-id="currentFolderId"
      :target-user-id="targetUserIdRef"
      @close="closePreview"
      @saved="fetchFiles"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue'
import { useFileBrowser } from '~/composables/useFileBrowser'
import { useDualSelection } from '~/composables/useDualSelection'
import { useBulkActions } from '~/composables/useBulkActions'
import { useFileUpload } from '~/composables/useFileUpload'
import { useClipboard } from '~/composables/useClipboard'
import { useUploadMenu } from '~/composables/useUploadMenu'
import { useNameEditing } from '~/composables/useNameEditing'
import { useFolderDownload } from '~/composables/useFolderDownload'
import { useDnDUpload } from '~/composables/useDnDUpload'
import FileList from '~/components/FileList.vue'
import FilePreviewer from '~/components/FilePreviewer.vue'
import ShareDialog from '~/components/ShareDialog.vue'
import type { FileListFile, FileListFolder } from '~~/types/file-list'
import type { FileRecord, FolderRecord } from '~~/types/file-browser'
import {
  ArrowDownTrayIcon,
  ArrowLeftIcon,
  ArrowPathIcon,
  ArrowUpTrayIcon,
  ClipboardDocumentCheckIcon,
  DocumentArrowUpIcon,
  DocumentDuplicateIcon,
  EllipsisVerticalIcon,
  FolderPlusIcon,
  ScissorsIcon,
  TrashIcon
} from '@heroicons/vue/24/outline'

const props = withDefaults(
  defineProps<{
    /**
     * own    —— 我的文件：可上传 / 新建 / 剪贴
     * shared —— 代看某人（仅管理员）：同样可上传 / 新建 / 剪贴，
     *           因为是按 targetUserId 操作的，和 /manage/files 同一条路径
     *
     * 两种模式的差异只有「上传/新建/剪贴」是否显示：自己的文件允许往里写，
     * 代看别人的共享内容时这些写操作不暴露。
     */
    variant?: 'own' | 'shared'
    /** variant=shared：被查看的用户 id，透传给 /api/files 的 targetUserId */
    targetUserId?: number | null
    /**
     * 是否以管理权限浏览。**仅 /manage/files 传 true**。
     * 首页侧栏选人浏览不传 —— 那是分享权限视角，管理员在首页不因此获得提权。
     * 传了但自己不是管理员，服务端一律 403（不静默降级）。
     */
    useAdmin?: boolean
    title?: string
    /** 铺满父容器高度并让列表内部滚动（配合 SidePanelLayout 的全屏页） */
    fill?: boolean
  }>(),
  { variant: 'own', fill: false }
)

const isOwn = computed(() => props.variant === 'own')
const defaultTitle = computed(() => (isOwn.value ? '我的文件' : '用户文件'))
const emptyDescription = computed(() =>
  isOwn.value
    ? '拖拽文件/文件夹到此处上传，或使用右上角“上传”按钮。'
    : '只有被显式标记为「分享」或「公开」的文件夹与文件会出现在这里。'
)

const targetUserIdRef = toRef(props, 'targetUserId')
const useAdminRef = toRef(props, 'useAdmin')
const previewingFile = ref<FileRecord | null>(null)

/**
 * 只有一个数据源 —— 自己的文件和「分享给我的」都走 /api/files，
 * 区别只在 targetUserId 传不传：
 *   不传  → me == target，列我的根目录
 *   传了  → 管理员代看该用户（useAdmin=1 由 service 自动带上）
 * 权限判定全在服务端的 getMeAndTarget，前端不用分支。
 */
const {
  folders,
  files,
  loading,
  error: listError,
  hasItems,
  currentFolderId,
  breadcrumbs,
  fetchFiles,
  navigateToFolder,
  goUp,
  goToBreadcrumb
} = useFileBrowser({ targetUserId: targetUserIdRef, useAdmin: useAdminRef })

const {
  masterCheckboxRef,
  selectedFolderIds,
  selectedFileIds,
  selectedCount,
  isAllSelected,
  toggleSelectAll,
  toggleSelectFolder,
  toggleSelectFile,
  clearSelection,
  reconcileSelection
} = useDualSelection(folders, files)

const {
  bulkDeleting,
  bulkDownloading,
  downloadFile,
  deleteFile,
  deleteFolder,
  deleteSelected,
  downloadSelected
} = useBulkActions(folders, files, selectedFolderIds, selectedFileIds, { targetUserId: targetUserIdRef })

const { uploading, uploadProgress, uploadError, uploadMultipleFiles } = useFileUpload({ targetUserId: targetUserIdRef })
const {
  showUploadMenu,
  uploadMenuRef,
  openUploadMenu,
  scheduleCloseUploadMenu,
  toggleUploadMenu
} = useUploadMenu()
const closeUploadMenu = () => { showUploadMenu.value = false }
const { createFolder, renameFolder, renameFile } = useNameEditing(
  folders,
  files,
  breadcrumbs,
  currentFolderId,
  fetchFiles,
  { targetUserId: targetUserIdRef }
)
const { downloadingFolderId, downloadFolder } = useFolderDownload({ targetUserId: targetUserIdRef })
const {
  isDragging,
  onDragEnter,
  onDragLeave,
  fileInputRef,
  folderInputRef,
  overwriteExisting,
  skipExisting,
  handleDrop,
  handleFileSelect,
  handleFolderSelect
} = useDnDUpload(currentFolderId, uploadMultipleFiles, fetchFiles, clearSelection, { targetUserId: targetUserIdRef })
const {
  clipboard,
  hasClipboard,
  pasting,
  clipboardCount,
  clipboardActionLabel,
  clipSelection,
  copySelection,
  clipFolder,
  copyFolder,
  clipFile,
  copyFile,
  pasteClipboard
} = useClipboard(
  {
    selectedFolderIds,
    selectedFileIds,
    selectedCount,
    currentFolderId,
    fetchFiles,
    clearSelection
  },
  { targetUserId: targetUserIdRef, overwriteExisting, skipExisting }
)

const conflictStrategy = computed<'overwrite' | 'skip' | 'rename'>({
  get() {
    if (overwriteExisting.value) return 'overwrite'
    if (skipExisting.value) return 'skip'
    return 'rename'
  },
  set(value) {
    overwriteExisting.value = value === 'overwrite'
    skipExisting.value = value === 'skip'
  }
})
const mobileMoreOpen = ref(false)

const asFolder = (folder: FileListFolder) => folder as unknown as FolderRecord
const asFile = (file: FileListFile) => file as unknown as FileRecord
const onNavigateFolder = (folder: FileListFolder) => {
  clearSelection()
  navigateToFolder(asFolder(folder))
}
const handleGoUp = () => {
  clearSelection()
  goUp()
}
const handleGoToBreadcrumb = (index: number) => {
  clearSelection()
  goToBreadcrumb(index)
}
const onPreviewFile = (file: FileListFile) => {
  previewingFile.value = asFile(file)
}
const onToggleFolder = (folder: FileListFolder) => toggleSelectFolder(asFolder(folder))
const onToggleFile = (file: FileListFile) => toggleSelectFile(asFile(file))
const onDownloadFolder = (folder: FileListFolder) => downloadFolder(asFolder(folder))
const onDeleteFolder = (folder: FileListFolder) => deleteFolder(asFolder(folder))
const onRenameFolder = (folder: FileListFolder) => renameFolder(asFolder(folder))
const onClipFolder = (folder: FileListFolder) => clipFolder(asFolder(folder))
const onCopyFolder = (folder: FileListFolder) => copyFolder(asFolder(folder))
const onDownloadFile = (file: FileListFile) => downloadFile(asFile(file))
const onDeleteFile = (file: FileListFile) => deleteFile(asFile(file))
const onRenameFile = (file: FileListFile) => renameFile(asFile(file))
const onClipFile = (file: FileListFile) => clipFile(asFile(file))
const onCopyFile = (file: FileListFile) => copyFile(asFile(file))

// 分享弹窗的目标（null = 关闭）。只有属主能在弹窗里改授权，服务端会再校验一次。
// 非属主连入口都不给：弹窗一打开就会撞 403「只有属主可以管理分享」，
// 与其弹错，不如一开始就不让他点。
const { user: authUser } = useAuth()
const shareTarget = ref<{ type: 'file' | 'folder'; id: number; name: string } | null>(null)
const canShare = (item: FileListFile | FileListFolder) => {
  const myId = authUser.value?.id
  const ownerId = item.ownerId
  // 拿不到属主信息时保守为不可分享，避免出现「点开必报错」的入口
  if (myId == null || ownerId == null) return false
  return Number(ownerId) === Number(myId)
}
const onShareFile = (file: FileListFile) => {
  if (!canShare(file)) return
  shareTarget.value = { type: 'file', id: Number(file.id), name: String(file.filename) }
}
const onShareFolder = (folder: FileListFolder) => {
  if (!canShare(folder)) return
  shareTarget.value = { type: 'folder', id: Number(folder.id), name: String(folder.name) }
}
const closePreview = () => {
  previewingFile.value = null
}
const chooseFiles = () => {
  fileInputRef.value?.click()
}

const emit = defineEmits<{ 'folder-change': [id: number | null] }>()

watch([folders, files], () => reconcileSelection())
watch(currentFolderId, (id) => emit('folder-change', id), { immediate: true })

defineExpose({
  fetchFiles,
  currentFolderId,
  breadcrumbs
})
</script>

<style scoped>
.no-scrollbar::-webkit-scrollbar { display: none; }
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }

.slide-up-enter-active,
.slide-up-leave-active {
  transition: transform 0.22s ease, opacity 0.22s ease;
}

.slide-up-enter-from,
.slide-up-leave-to {
  transform: translateY(8px);
  opacity: 0;
}

.fade-slide-enter-active,
.fade-slide-leave-active { transition: opacity 0.15s ease, transform 0.15s ease; }
.fade-slide-enter-from,
.fade-slide-leave-to { opacity: 0; transform: translateY(-6px); }
</style>
