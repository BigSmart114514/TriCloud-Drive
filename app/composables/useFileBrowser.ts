import { FilesService } from '~/services/files.service'
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
}) {
  const tRef = options?.targetUserId
  const enabled = options?.enabled ?? ref(true)
  const useAdmin = options?.useAdmin ?? ref(false)

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
        useAdmin.value || undefined
      )
      if (res.success) {
        folders.value = res.folders || []
        files.value = res.files || []
        currentFolderId.value = res.currentFolderId ?? null
        sharedList.value = !!res.sharedList
        canWrite.value = res.canWrite ?? true
      }
    } catch (e: any) {
      folders.value = []
      files.value = []
      error.value =
        e?.statusCode === 401 || e?.status === 401
          ? '登录已失效，请重新登录'
          : e?.data?.statusMessage || e?.statusMessage || '加载文件列表失败'
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

  // 切换 targetUserId 时重置浏览状态
  watch([tRef, enabled], () => {
    folders.value = []
    files.value = []
    currentFolderId.value = null
    breadcrumbs.value = [{ id: null, name: '全部文件' }]
    fetchFiles()
  })

  return {
    folders, files, loading, error, hasItems,
    currentFolderId, breadcrumbs, sharedList, canWrite,
    fetchFiles, navigateToFolder, goUp, goToBreadcrumb
  }
}