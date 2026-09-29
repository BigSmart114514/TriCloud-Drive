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
  options?: {
    targetUserId?: Ref<number | null | undefined>
    overwriteExisting?: Ref<boolean | null | undefined>
    skipExisting?: Ref<boolean | null | undefined>
    useAdmin?: Ref<boolean | null | undefined>
  }
) {
  const tRef = options?.targetUserId
  const useAdmin = options?.useAdmin

  /**
   * 剪贴板必须跨组件存活。
   *
   * 首页侧栏切换选中的人时 FileBrowser 是按 :key 重建的（index.vue），
   * 用局部 ref 的话剪贴一下、切个人，内容就没了。所以走 useState。
   */
  const clipboard = useState<ClipboardPayload | null>('clipboard', () => null)
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

  const setClipboard = (mode: 'cut' | 'copy', folderIds: number[], fileIds: number[]) => {
    clipboard.value = {
      mode,
      folderIds,
      fileIds,
      fromFolderId: currentFolderId.value ?? null
    }
  }

  const clipSelection = () => {
    if (selectedCount.value === 0) return
    setClipboard('cut', Array.from(selectedFolderIds.value), Array.from(selectedFileIds.value))
  }
  const copySelection = () => {
    if (selectedCount.value === 0) return
    setClipboard('copy', Array.from(selectedFolderIds.value), Array.from(selectedFileIds.value))
  }

  const clipFolder = (folder: { id: number }) => setClipboard('cut', [folder.id], [])
  const copyFolder = (folder: { id: number }) => setClipboard('copy', [folder.id], [])
  const clipFile = (file: { id: number }) => setClipboard('cut', [], [file.id])
  const copyFile = (file: { id: number }) => setClipboard('copy', [], [file.id])

  const pasteClipboard = async () => {
    if (!hasClipboard.value || pasting.value) return
    pasting.value = true
    try {
      const targetFolderId = currentFolderId.value ?? null
      const c = clipboard.value!
      const t = tRef?.value ?? null
      const admin = useAdmin?.value || undefined

      const res = c.mode === 'cut'
        ? await MoveService.paste(targetFolderId, c.folderIds, c.fileIds, t, options?.overwriteExisting?.value, options?.skipExisting?.value, admin)
        : await CopyService.paste(targetFolderId, c.folderIds, c.fileIds, t, options?.overwriteExisting?.value, options?.skipExisting?.value, admin)

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
