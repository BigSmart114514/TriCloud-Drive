import type { ShareMode } from '~~/types/share'

export interface ShareTargetType {
  targetType: 'file' | 'folder'
  targetId: number
  /**
   * 管理视角：/manage/files 里管理员在替别人改分享。
   *
   * 服务端 getMeAndTarget 读这两个参数：useAdmin=true 且调用者确实是管理员时
   * authUserId 会变成 targetUserId，于是 resolveShareTarget 的
   * 「必须是属主」判定自动变成「必须是这个被浏览用户的」—— 不用另写一套接口。
   * 非管理员传 useAdmin 一律 403。
   */
  useAdmin?: boolean
  targetUserId?: number | null
}

export interface ShareGrant {
  userId: number
  permission: number
  label?: string
  user?: { username: string; email: string } | null
}

export interface ShareLink {
  id: number
  /** 32 位 hex token */
  link: string
  targetType: 'file' | 'folder'
  targetId: number
  createdAt: string | null
  /** 完整地址，由服务端拼（见 server/utils/share-link.ts 的 buildShareLinkUrl） */
  url: string
}

export interface ShareState {
  mode: ShareMode
  modeLabel: string
  isBoundary: boolean
  IsPublic: boolean
  grants: ShareGrant[]
  links: ShareLink[]
}

export interface ShareCandidate {
  id: number
  username: string
  email?: string
}

/**
 * 分享管理列表里的一行。目录与文件同构，所以一个列表组件渲染两份。
 *
 * `mode` / `isPublic` / `grantCount` / `linkCount` 是「我设了什么」，
 * `presetActive` / `linkActive` 是「设了的东西现在生效吗」——
 * 后两个是这个页面真正的价值：它们把「我明明分享过了」和「分享了但没用上」分开。
 * 判定口径见 server/utils/share-settings.ts。
 */
export interface ShareSettingRow {
  id: number
  targetType: 'file' | 'folder'
  name: string
  /** 所在目录的文本路径。根层为空串 */
  relDir: string
  /** 从根到目标的目录链，文件到所在目录为止。点「在文件里打开」用 */
  path: Array<{ id: number; name: string }>
  ownerId: number
  mode: ShareMode
  isPublic: boolean
  grantCount: number
  linkCount: number
  presetActive: boolean
  linkActive: boolean
  createdAt: string | null
  /** 仅文件。null = 在根目录，此时没有「在文件里打开」的落点 */
  folderId?: number | null
  fileSize?: number
  contentType?: string | null
}

export interface ShareSettingsSummary {
  /** 两类合计。不受列表上限影响 —— 摘要说的是「一共有多少设置」，不是「给你看几条」 */
  total: number
  folderCount: number
  fileCount: number
  publicCount: number
  privateCount: number
  linkCount: number
  deadLinkCount: number
}

export interface ShareSettingsResult {
  success: boolean
  folders: ShareSettingRow[]
  files: ShareSettingRow[]
  summary: ShareSettingsSummary
  truncated: boolean
  limit: number
}

/**
 * 批量处置的四个动作。
 *
 *   reset       恢复默认：三态→继承 + 取消公开 + 清空名单 + 撤销全部链接
 *   unpublish   取消公开：只动 IsPublic
 *   removeLinks 撤销链接：只撤链接
 *   apply       把一份分享设置整体复写给每一项（走 ShareService.bulkApply）
 *
 * 没有「只把三态设成继承」：点完名单和链接都还在，条目照样不出列表，
 * 语义上等于「没恢复」。真要「停止当挡板但保留名单」，在分享弹窗里改三态即可。
 *
 * apply 不在 SHARE_BULK_ACTION_LABELS 里：它没有按钮文案，那三个是分享管理页
 * 底部批量条上直接印字的按钮，而 apply 是「打开弹窗」，入口在文件列表的工具栏。
 */
export type ShareBulkAction = 'reset' | 'unpublish' | 'removeLinks' | 'apply'

export const SHARE_BULK_ACTION_LABELS: Record<Exclude<ShareBulkAction, 'apply'>, string> = {
  reset: '恢复默认',
  unpublish: '取消公开',
  removeLinks: '撤销链接'
}

export interface ShareBulkResult {
  success: boolean
  action: ShareBulkAction
  actionLabel: string
  okCount: number
  failCount: number
  /** 逐项结果。归属校验在服务端做，别名不属于你的项会单独 ok:false 而不是整批失败 */
  results: Array<{ targetType: string; targetId: number | null; ok: boolean; message?: string }>
}

/**
 * apply 的载荷。三个字段都是**可选**，且 null/undefined 的含义是「不碰这一项」。
 *
 * `grants` 是**整体复写**语义：传什么就是最终名单，不在列表里的人会被移除。
 * 所以 `grants: []`（空数组）与「不传 grants」是两件截然不同的事 ——
 * 前者是清空名单，后者是保留原名单。批量弹窗的初值是空的，
 * 于是「什么都不改直接提交」等价于清空所有授权，前端因此必须显式警告。
 */
export interface ShareBulkApplyPayload {
  mode?: ShareMode | null
  isPublic?: boolean | null
  grants?: Array<{ userId: number; permission: number }> | null
}

/** 批量设置里的一项。除 id/type 外还带当前状态，用来在弹窗里显示「会被覆盖成什么」 */
export interface ShareBulkTarget {
  targetType: 'file' | 'folder'
  targetId: number
  name: string
  /** 数字三态。**必须走 normalizeShareMode**，别自己 `=== 1`：
   *  Number(true) === 1 === SHARE_SHARED */
  Shared?: number
  IsPublic?: boolean
  grantCount?: number
}

/**
 * 链接校验的返回形状。三态对应前端三种动作，**不能压成布尔**：
 *
 *   200 active:true   → 打开
 *   200 active:false  → 保留在侧栏，标「当前不可用」（属主以后可能修好）
 *   404               → 从本地存储删除（token 不存在 / 目标已删，不可恢复）
 *   5xx / 网络失败     → 保留，什么都不删
 *
 * 「什么时候该删」这条规则收在 useShareLinks 的 verifyLink 里，别散在调用方。
 */

/** 只在管理视角带上 useAdmin / targetUserId，省得空值传过去被服务端 readBool 误判 */
function scopeParams(target: ShareTargetType) {
  const base: Record<string, any> = {
    targetType: target.targetType,
    targetId: target.targetId
  }
  if (target.useAdmin && target.targetUserId != null) {
    base.useAdmin = true
    base.targetUserId = target.targetUserId
  }
  return base
}

export const ShareService = {
  /**
   * 分享管理列表：我设置过分享的全部文件与文件夹（默认态的反面）。
   * 只涉及自己，服务端不接受任何用户参数。
   *
   * 原先有个 `limit` 形参，但唯一调用方（pages/shares.vue）从不传 —— 服务端
   * 自己有默认上限，前端再传一遍只是多一个没人用的入口，去掉了。
   */
  async settings() {
    return await $fetch<ShareSettingsResult>('/api/share/settings')
  },

  /**
   * 批量处置。**返回值必须看 okCount / failCount**，不能只看 success：
   * 归属校验逐项在服务端做，别人的（或已被删的）项会单独 ok:false，
   * 其余照常执行 —— 勾了 20 项不该因为 1 项失效而白做另外 19 项。
   */
  async bulk(
    targets: Array<{ targetType: 'file' | 'folder'; targetId: number }>,
    action: Exclude<ShareBulkAction, 'apply'>
  ) {
    return await $fetch<ShareBulkResult>('/api/share/bulk', {
      method: 'POST',
      body: { targets, action }
    })
  },

  /**
   * 批量设置分享。`payload` 里没给的字段不动，给了的整体复写。
   *
   * 管理视角必须传 useAdmin / targetUserId：服务端 bulk 端点读这两个参数决定
   * authUserId 落在谁身上（与 /api/share/mode 同一套）。漏了的话管理员在
   * /manage/files 里改的是自己的「属主判定」，每一项都会 403。
   *
   * 与 bulk() 分成两个方法而不是加第三个参数：apply 的载荷形状完全不同
   * （三个可选字段 vs 一个动作名），塞进同一个签名里将来一定会被搞混。
   */
  async bulkApply(
    targets: Array<{ targetType: 'file' | 'folder'; targetId: number }>,
    payload: ShareBulkApplyPayload,
    scope?: { useAdmin?: boolean; targetUserId?: number | null }
  ) {
    const body: Record<string, any> = { targets, action: 'apply', ...payload }
    if (scope?.useAdmin && scope.targetUserId != null) {
      body.useAdmin = true
      body.targetUserId = scope.targetUserId
    }
    return await $fetch<ShareBulkResult>('/api/share/bulk', { method: 'POST', body })
  },

    async list(target: ShareTargetType) {
    return await $fetch<ShareState & { success: boolean; targetId: number; ownerId: number }>(
      '/api/share/list',
      { params: scopeParams(target) }
    )
  },

  /**
   * 改共享状态。这是唯一的写接口：mode / isPublic / grants 都走它。
   * grants 是**整份名单**，传什么就是最终结果（不在列表里的会被移出），
   * 所以加人和移人都只是「改数组后重发」，不用分别调两个接口。
   */
  async setState(
    target: ShareTargetType,
    payload: { mode?: ShareMode; isPublic?: boolean; grants?: Array<{ userId: number; permission: number }> }
  ) {
    return await $fetch<ShareState & { success: boolean; statusMessage: string }>('/api/share/mode', {
      method: 'POST',
      body: { ...scopeParams(target), ...payload }
    })
  },

  async candidates(keyword: string, excludeIds: number[] = []) {
    if (!keyword.trim()) return { candidates: [] as ShareCandidate[] }
    return await $fetch<{ success: boolean; candidates: ShareCandidate[] }>('/api/share/candidates', {
      params: { q: keyword.trim(), exclude: excludeIds.filter(Boolean).join(',') || undefined }
    })
  },

  /**
   * 生成一个链接。返回完整列表，别再拉一次 —— 结构与 list 的 links 一致。
   * （服务端已经修好过一次这个：add 原来返回裸行没有 url，前端拿不到可复制的地址。）
   */
  async addLink(target: ShareTargetType) {
    return await $fetch<{
      success: boolean
      statusMessage: string
      link: string
      url: string
      links: ShareLink[]
    }>('/api/share/link/add', {
      method: 'POST',
      body: scopeParams(target)
    })
  },

  /**
   * 按 token 撤销一个链接。幂等：撤销不存在的返回成功（服务端口径），
   * 所以前端不用先查一次再决定要不要调。
   */
  async removeLink(link: string, target?: ShareTargetType) {
    return await $fetch<{ success: boolean; statusMessage: string; link: string }>(
      '/api/share/link/remove',
      { method: 'POST', body: { link, ...(target ? scopeParams(target) : {}) } }
    )
  },

  /**
   * 验有效性：token 还在吗、指向什么、当前能不能用。**匿名可调**
   * （中间件的 LINK_PUBLIC_PATHS 放行了），访客没有账号也能问。
   *
   * **「无效」是 body 里的 `valid: false`，不是状态码**。无效也返回 200。
   *
   * 这样定的理由：调用方要拿这个结果做一个不可逆的决定（删用户的本地收藏，
   * 删了找不回来），所以判断依据必须是一个专用的字段，而不是对状态码语义的解读。
   * 404 能来自网关、代理、上层兜底、一次数据库抖动 —— 见到 404 就删，
   * 等于让那些「没说什么」的错误替服务端表态。
   *
   * 5xx 保持 5xx：那是「这次没问成」，调用方据此什么都不做。
   */
  async resolveLink(link: string) {
    return await $fetch<{
      success: boolean
      link: string
      /** false = token 不存在，或它指的目标已被删。这两种该从本地存储移除 */
      valid: boolean
      /** 仅 valid=true 时有意义。false = 链接在但当前覆盖不到，属主可能修好 */
      active: boolean
      targetType?: 'file' | 'folder'
      targetId?: number
      name?: string
      /**
       * valid=false 时是 `'token_not_found' | 'target_gone'`（机器可读，前端据此删）；
       * valid=true 且 active=false 时是给用户看的中文说明。
       */
      reason?: string | null
    }>('/api/share/link/resolve', { params: { link } })
  }
}