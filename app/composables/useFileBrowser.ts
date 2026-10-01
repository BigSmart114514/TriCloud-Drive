// ~/composables/useFileBrowser.ts
import { FilesService } from '~/services/files.service'
import { toMessage } from '~/utils/notify'
import type { FolderRecord, FileRecord } from '~/types/files'

export function useFileBrowser(options?: {
  targetUserId?: Ref<number | null | undefined>
  /** 非激活时跳过取数。FileBrowser 同时挂载两个数据源，靠它避免多余请求 */
  enabled?: Ref<boolean>
  /**
   * 是否以管理权限浏览。仅 /manage/files 传 true（管理员看别人）。
   * 首页侧栏选人浏览**不传** —— 那是分享权限视角，管理员在首页拿不到提权。
   */
  useAdmin?: Ref<boolean>
  /**
   * 分享链接 token。传了就走服务端的链接分支（listByLink）：
   * 匿名可调，权限锁死读+下载，与登录态无关。
   *
   * 它同时是「切换数据源」的开关 —— 换了链接要重置浏览状态回到根，
   * 所以下面 watch 里和 targetUserId 一起进数组。
   */
  link?: Ref<string | null | undefined>
}) {
  const tRef = options?.targetUserId
  const enabled = options?.enabled ?? ref(true)
  const useAdmin = options?.useAdmin ?? ref(false)
  const linkRef = options?.link
  const shareLink = computed(() => (linkRef?.value ? String(linkRef.value) : null))

  const folders = ref<FolderRecord[]>([])
  const files = ref<FileRecord[]>([])
  const loading = ref(false)
  const currentFolderId = ref<number | null>(null)
  const breadcrumbs = ref<{ id: number | null; name: string }[]>([
    { id: null, name: '全部文件' }
  ])
  const hasItems = computed(() => folders.value.length + files.value.length > 0)

  /**
   * 服务端下发的两个判定，原先在 fetchFiles 里被丢掉了。
   *   sharedList —— 当前是「平铺分享清单」还是真实目录（清单里没有粘贴目标）
   *   canWrite   —— 当前目录我能不能写（共享视图据此给不给上传/新建/粘贴）
   */
  const sharedList = ref(false)
  const canWrite = ref(true)
  /**
   * 服务端走的是链接分支。链接视图里写操作一律不给（服务端也拦），
   * 但入口不该出现 —— 匿名访客看到「上传」按钮点了只会得到一句 401。
   * 与 canWrite 分开：这个是「视角性质」，那个是「这一层的权限」。
   */
  const linkMode = ref(false)

  // 列表拉取失败时的提示文案。onMounted 直接调 fetchFiles，
  // 这里不兜住异常的话，401/500 会变成未捕获的 promise rejection，
  // 报成 "Unhandled error during execution of mounted hook"，看不出真实原因。
  const error = ref('')

  const fetchFiles = async () => {
    if (!enabled.value) return
    try {
      loading.value = true
      error.value = ''
      const res = await FilesService.list(
        currentFolderId.value,
        tRef?.value ?? null,
        useAdmin.value || undefined,
        shareLink.value
      )
      if (res.success) {
        folders.value = res.folders || []
        files.value = res.files || []
        currentFolderId.value = res.currentFolderId ?? null
        sharedList.value = !!res.sharedList
        canWrite.value = res.canWrite ?? true
        linkMode.value = !!res.linkMode
      }
    } catch (e: any) {
      folders.value = []
      files.value = []
      /**
       * 链接的失效提示与「未登录」不同：链接过期/被撤销/目标已删都走 404，
       * 说成「登录已失效」会让人跑去重新登录 —— 而他可能压根没账号。
       * 服务端在 LINK_NOT_ACTIVE_MESSAGE 里已经把原因讲清了，直接透传。
       */
      error.value =
        e?.statusCode === 401 || e?.status === 401
          ? (shareLink.value ? toMessage(e, '分享链接无法访问') : '登录已失效，请重新登录')
          : toMessage(e, '加载文件列表失败')
    } finally {
      loading.value = false
    }
  }

  const navigateToFolder = (folder: FolderRecord) => {
    currentFolderId.value = folder.id
    breadcrumbs.value.push({ id: folder.id, name: folder.name })
    fetchFiles()
  }
  const goUp = () => {
    if (breadcrumbs.value.length <= 1) return
    breadcrumbs.value.pop()
    currentFolderId.value = breadcrumbs.value[breadcrumbs.value.length - 1].id
    fetchFiles()
  }
  const goToBreadcrumb = (index: number) => {
    if (index < 0 || index >= breadcrumbs.value.length) return
    breadcrumbs.value.splice(index + 1)
    currentFolderId.value = breadcrumbs.value[index].id
    fetchFiles()
  }

  onMounted(fetchFiles)

  /**
   * 切换数据源时重置浏览状态。
   *
   * shareLink 必须在里面：链接视图的 currentFolderId 是**属主树里**的目录 id，
   * 换一条链接（可能是别人的树）之后带着旧 id 去请求必然 404。
   * 根层对链接的含义是「链接挂的那个节点」，由服务端 listByLink 解析，
   * 前端只要把 currentFolderId 置空即可。
   */
  watch([tRef, enabled, shareLink], () => {
    folders.value = []
    files.value = []
    currentFolderId.value = null
    breadcrumbs.value = [{ id: null, name: '全部文件' }]
    fetchFiles()
  })

  return {
    folders, files, loading, error, hasItems,
    currentFolderId, breadcrumbs, sharedList, canWrite, linkMode,
    fetchFiles, navigateToFolder, goUp, goToBreadcrumb
  }
}