import { SHARE_INHERIT, SHARE_SHARED } from '~~/types/share'
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

export { SHARE_INHERIT, SHARE_SHARED }