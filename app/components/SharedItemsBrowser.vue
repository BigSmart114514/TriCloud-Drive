<template>
  <div class="flex h-full min-h-0 flex-col bg-white">
    <div class="flex shrink-0 items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
      <div class="flex min-w-0 items-center gap-2">
        <input
          ref="masterCheckboxRef"
          type="checkbox"
          class="hidden h-4 w-4 rounded border-gray-300 text-indigo-600 sm:block"
          :checked="isAllSelected"
          :disabled="!hasItems"
          @change="toggleSelectAll"
          title="全选/全不选"
        />
        <h3 class="shrink-0 text-lg font-medium text-gray-900">{{ title || '共享内容' }}</h3>
        <span class="truncate text-xs text-gray-400">
          文件夹 {{ sharedFolders.length }} · 文件 {{ sharedFiles.length }}
        </span>
      </div>

      <div class="flex items-center gap-2">
        <button
          class="p-1 text-sm text-red-600 hover:text-red-500 disabled:opacity-50"
          :disabled="selectedCount === 0 || bulkDeleting"
          title="删除所选"
          aria-label="删除所选"
          @click="deleteSelected"
        >
          <TrashIcon class="h-5 w-5" />
        </button>
        <button
          class="p-1 text-sm text-indigo-600 hover:text-indigo-500 disabled:opacity-50"
          :disabled="selectedCount === 0 || bulkDownloading"
          title="下载所选"
          aria-label="下载所选"
          @click="downloadSelected"
        >
          <ArrowDownTrayIcon class="h-5 w-5" />
        </button>
        <button
          class="p-1 text-sm text-gray-600 hover:text-gray-800"
          title="刷新"
          aria-label="刷新"
          @click="fetchShared"
        >
          <ArrowPathIcon class="h-5 w-5" />
        </button>
      </div>
    </div>

    <div v-if="errorMessage" class="mx-4 mt-3 shrink-0 rounded-md bg-red-50 p-3 text-sm text-red-700">
      {{ errorMessage }}
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6">
      <FileList
        :folders="sharedFolders"
        :files="sharedFiles"
        :loading="loading"
        :selectable="true"
        :show-actions="true"
        :framed="false"
        :downloading-folder-id="downloadingFolderId"
        :selected-folder-ids="selectedFolderIds"
        :selected-file-ids="selectedFileIds"
        empty-title="该用户没有分享任何内容"
        empty-description="只有被显式标记为「分享」或「公开」的文件夹与文件会出现在这里。"
        @navigate-folder="onPreviewFolder"
        @preview-file="onPreviewFile"
        @toggle-folder="onToggleFolder"
        @toggle-file="onToggleFile"
        @download-folder="onDownloadFolder"
        @delete-folder="onDeleteFolder"
        @rename-folder="onRenameFolder"
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

    <FilePreviewer
      v-if="previewingFile"
      :file="previewingFile"
      :current-folder-id="previewingFile.folderId"
      :target-user-id="userId"
      @close="closePreview"
      @saved="fetchShared"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  TrashIcon
} from '@heroicons/vue/24/outline'
import FileList from '~/components/FileList.vue'
import FilePreviewer from '~/components/FilePreviewer.vue'
import ShareDialog from '~/components/ShareDialog.vue'
import { useDualSelection } from '~/composables/useDualSelection'
import { useBulkActions } from '~/composables/useBulkActions'
import { useNameEditing } from '~/composables/useNameEditing'
import { useFolderDownload } from '~/composables/useFolderDownload'
import type { FolderRecord, FileRecord } from '~/types/file-browser'
import type { FileListFile, FileListFolder } from '~/types/file-list'

/**
 * 某个用户「显式分享出去」的文件夹与文件，平铺展示。
 *
 * 与 CloudFileBrowser 的区别只有两点：数据来自 /api/manage/sharedItems 而不是
 * 某个目录，且不带当前目录概念 —— 所以这里没有面包屑、上传、新建、剪贴板。
 * 选中、批量、下载、重命名、删除、分享这些动作仍走同一批 composables。
 */
const props = withDefaults(
  defineProps<{
    /** 被查看的用户；变化即重新拉取 */
    userId: number
    title?: string
  }>(),
  { title: '' }
)

const sharedFolders = ref<FileListFolder[]>([])
const sharedFiles = ref<FileListFile[]>([])
const loading = ref(false)
const errorMessage = ref('')
const previewingFile = ref<FileRecord | null>(null)

// composables 要的是 Ref<FolderRecord[]> / Ref<FileRecord[]>，
// 所以把 FileList 的宽松类型在这里收紧一次
const folders = computed(() => sharedFolders.value as unknown as FolderRecord[])
const files = computed(() => sharedFiles.value as unknown as FileRecord[])
// 清单是平铺的，没有「当前目录」；重命名/删除后由 fetchShared 重新取
const noBreadcrumbs = ref<Array<{ id: number | null; name: string }>>([])
const noFolder = ref<number | null>(null)
const targetUserId = computed(() => props.userId)

const fetchShared = async () => {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await $fetch<{ success: boolean; folders: FileListFolder[]; files: FileListFile[] }>(
      '/api/manage/sharedItems',
      { params: { userId: props.userId } }
    )
    sharedFolders.value = res.folders ?? []
    sharedFiles.value = res.files ?? []
  } catch (e: any) {
    sharedFolders.value = []
    sharedFiles.value = []
    errorMessage.value = e?.data?.statusMessage || e?.statusMessage || '加载共享内容失败'
  } finally {
    loading.value = false
  }
}

const hasItems = computed(() => sharedFolders.value.length + sharedFiles.value.length > 0)

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
} = useBulkActions(folders, files, selectedFolderIds, selectedFileIds, { targetUserId })

const { renameFolder, renameFile } = useNameEditing(
  folders,
  files,
  noBreadcrumbs,
  noFolder,
  fetchShared,
  { targetUserId }
)

const { downloadingFolderId, downloadFolder } = useFolderDownload({ targetUserId })

const onToggleFolder = (folder: FileListFolder) => toggleSelectFolder(folder as unknown as FolderRecord)
const onToggleFile = (file: FileListFile) => toggleSelectFile(file as unknown as FileRecord)
const onDownloadFolder = (folder: FileListFolder) => downloadFolder(folder as unknown as FolderRecord)
const onDeleteFolder = (folder: FileListFolder) => deleteFolder(folder as unknown as FolderRecord)
const onRenameFolder = (folder: FileListFolder) => renameFolder(folder as unknown as FolderRecord)
const onDownloadFile = (file: FileListFile) => downloadFile(file as unknown as FileRecord)
const onDeleteFile = (file: FileListFile) => deleteFile(file as unknown as FileRecord)
const onRenameFile = (file: FileListFile) => renameFile(file as unknown as FileRecord)
const onPreviewFile = (file: FileListFile) => {
  previewingFile.value = file as unknown as FileRecord
}
const closePreview = () => {
  previewingFile.value = null
}

// 剪贴/复制需要「粘到哪里」，平铺清单里没有当前目录，故不接
const onClipFolder = () => {}
const onCopyFolder = () => {}
const onClipFile = () => {}
const onCopyFile = () => {}
// 点文件夹行不做目录下钻：清单只呈现被分享的那一批，进去会看到未分享的内容
const onPreviewFolder = () => {}

// 分享弹窗的目标（null = 关闭）
const shareTarget = ref<{ type: 'file' | 'folder'; id: number; name: string } | null>(null)
const onShareFile = (file: FileListFile) => {
  shareTarget.value = { type: 'file', id: Number(file.id), name: String(file.filename) }
}
const onShareFolder = (folder: FileListFolder) => {
  shareTarget.value = { type: 'folder', id: Number(folder.id), name: String(folder.name) }
}

watch([folders, files], () => reconcileSelection())
watch(() => props.userId, () => {
  clearSelection()
  closePreview()
  fetchShared()
}, { immediate: true })
onBeforeUnmount(clearSelection)
</script>
