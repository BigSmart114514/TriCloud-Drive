// ~/composables/useClipboard.ts
import { ref, computed, type Ref } from 'vue'
import { MoveService } from '~/services/move.service'
import { CopyService } from '~/services/copy.service'

type ClipboardPayload = {
  mode: 'cut' | 'copy'
  folderIds: number[]
  fileIds: number[]
  fromFolderId: number | null
}

type Params = {
  selectedFolderIds: Ref<Set<number>>
  selectedFileIds: Ref<Set<number>>
  selectedCount: Ref<number>
  currentFolderId: Ref<number | null>
  fetchFiles: () => Promise<void> | void
  clearSelection: () => void
}

export function useClipboard(
  {
    selectedFolderIds,
    selectedFileIds,
    selectedCount,
    currentFolderId,
    fetchFiles,
    clearSelection
  }: Params,
  options?: { targetUserId?: Ref<number | null | undefined>, overwriteExisting?: Ref<boolean | null | undefined>, skipExisting?: Ref<boolean | null | undefined>}
) {
  const tRef = options?.targetUserId

  const clipboard = ref<ClipboardPayload | null>(null)
  const pasting = ref(false)

  const hasClipboard = computed(() => {
    const c = clipboard.value
    return !!c && (c.folderIds.length + c.fileIds.length) > 0
  })
  const clipboardCount = computed(() => {
    const c = clipboard.value
    return c ? (c.folderIds.length + c.fileIds.length) : 0
  })
  const clipboardActionLabel = computed(() =>
    !clipboard.value ? '' : (clipboard.value.mode === 'cut' ? '已剪贴' : '已复制')
  )
  const pasteBtnText = computed(() => {
    if (!clipboard.value) return '粘贴'
    if (pasting.value) return clipboard.value.mode === 'cut' ? '移动中...' : '复制中...'
    return '粘贴'
  })

  const clipSelection = () => {
    if (selectedCount.value === 0) return
    clipboard.value = {
      mode: 'cut',
      folderIds: Array.from(selectedFolderIds.value),
      fileIds: Array.from(selectedFileIds.value),
      fromFolderId: currentFolderId.value ?? null
    }
  }
  const copySelection = () => {
    if (selectedCount.value === 0) return
    clipboard.value = {
      mode: 'copy',
      folderIds: Array.from(selectedFolderIds.value),
      fileIds: Array.from(selectedFileIds.value),
      fromFolderId: currentFolderId.value ?? null
    }
  }

  const clipFolder = (folder: { id: number }) => {
    clipboard.value = { mode: 'cut', folderIds: [folder.id], fileIds: [], fromFolderId: currentFolderId.value ?? null }
  }
  const copyFolder = (folder: { id: number }) => {
    clipboard.value = { mode: 'copy', folderIds: [folder.id], fileIds: [], fromFolderId: currentFolderId.value ?? null }
  }
  const clipFile = (file: { id: number }) => {
    clipboard.value = { mode: 'cut', folderIds: [], fileIds: [file.id], fromFolderId: currentFolderId.value ?? null }
  }
  const copyFile = (file: { id: number }) => {
    clipboard.value = { mode: 'copy', folderIds: [], fileIds: [file.id], fromFolderId: currentFolderId.value ?? null }
  }

  const pasteClipboard = async () => {
    if (!hasClipboard.value || pasting.value) return
    pasting.value = true
    try {
      const targetFolderId = currentFolderId.value ?? null
      const c = clipboard.value!
      const t = tRef?.value ?? null

      const res = c.mode === 'cut'
        ? await MoveService.paste(targetFolderId, c.folderIds, c.fileIds, t, options?.overwriteExisting?.value, options?.skipExisting?.value)
        : await CopyService.paste(targetFolderId, c.folderIds, c.fileIds, t, options?.overwriteExisting?.value, options?.skipExisting?.value)

      if (!res?.success) {
        notify(res?.message || (c.mode === 'cut' ? '移动失败' : '复制失败'), 'error')
        return
      }
      if (res.success && c.mode === 'cut')
      {
        notify(`移动成功！移动文件${res?.moved?.files}，移动文件夹${res?.moved?.folders}，跳过${res?.skipped}，失败${res?.failed}`,'success')
      } else if (res.success && c.mode === 'copy')
      {
        notify(`复制成功！复制文件${res?.copied?.files}，复制文件夹${res?.copied?.folders}，跳过${res?.skipped}，失败${res?.failed}`,'success')
      }
      clipboard.value = null
      clearSelection()
      await fetchFiles()
    } catch (e) {
      notifyError(e, '粘贴失败，请稍后重试')
    } finally {
      pasting.value = false
    }
  }

  return {
    clipboard,
    pasting,
    hasClipboard,
    clipboardCount,
    clipboardActionLabel,
    pasteBtnText,
    clipSelection,
    copySelection,
    clipFolder,
    copyFolder,
    clipFile,
    copyFile,
    pasteClipboard
  }
}