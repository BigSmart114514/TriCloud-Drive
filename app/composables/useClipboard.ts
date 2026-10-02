// ~/composables/useClipboard.ts
import { ref, computed, type Ref } from 'vue'
import { MoveService } from '~/services/move.service'
import { CopyService } from '~/services/copy.service'

type ClipboardPayload = {
  mode: 'cut' | 'copy'
  folderIds: number[]
  fileIds: number[]
  fromFolderId: number | null
  /**
   * 剪贴这些条目时所处的**链接视角**（token），没有则 null。
   *
   * 为什么必须带上：链接视图里那些条目的 id 是**属主树里**的 id，
   * 而我（访客/被授权人）对它们没有按人授权 —— 服务端 findAccessibleMany
   * 按 userId 查名单，拿到这些 id 一律 404。所以复制必须把凭据一起递过去，
   * 服务端才知道该按 token 查边界。
   *
   * 粘到别处（自己的目录、别人的分享目录）时这个 token 就不再适用：
   * 目标侧不传 link，走正常权限判定。这是对的 —— 副本的落点归目标侧管，
   * 源的凭据只用来证明「我能读这些」。
   *
   * 剪贴（cut）不带 link：移动就是写属主的树，链接只给只读。
   */
  link?: string | null
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
    /** 当前是否处于链接视角。剪贴时记进 payload，粘贴时带给服务端 */
    link?: Ref<string | null | undefined>
  }
) {
  const tRef = options?.targetUserId
  const useAdmin = options?.useAdmin
  const linkRef = options?.link
  const currentLink = computed(() => (linkRef?.value ? String(linkRef.value) : null))

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
    const setClipboard = (mode: 'cut' | 'copy', folderIds: number[], fileIds: number[]) => {
    clipboard.value = {
      mode,
      folderIds,
      fileIds,
      fromFolderId: currentFolderId.value ?? null,
      // cut 不带链接：链接只给只读，移动需要写权限
      link: mode === 'cut' ? null : currentLink.value
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

      /**
       * 剪贴时记下的链接**一律带上**。这正是「在链接视图里复制、粘到自己空间」
       * 能成立的原因：源的 id 是属主树里的，服务端按 userId 查名单会 404，
       * 必须靠 token 证明「我能读这些」。
       *
       * 带了链接会不会越权？不会 —— 服务端只把 link 用在**源**的解析上
       * （见 paste.post.ts 的注释），目标目录仍然走 findAccessibleById +
       * PERM_WRITE 的正常判定。所以「在自己的目录里粘贴」永远只粘得进
       * 我自己有写权限的地方，而读源的范围被链接的边界 CTE 限死。
       *
       * cut 不带（剪贴时就没记 link）：移动要写权限，链接给不了。
       */
      const res = c.mode === 'cut'
        ? await MoveService.paste(targetFolderId, c.folderIds, c.fileIds, t, options?.overwriteExisting?.value, options?.skipExisting?.value, admin)
        : await CopyService.paste(targetFolderId, c.folderIds, c.fileIds, t, options?.overwriteExisting?.value, options?.skipExisting?.value, admin, c.link ?? null)

      if (!res?.success) {
        notify(res?.statusMessage || (c.mode === 'cut' ? '移动失败' : '复制失败'), 'error')
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
    clipSelection,
    copySelection,
    clipFolder,
    copyFolder,
    clipFile,
    copyFile,
    pasteClipboard
  }
}