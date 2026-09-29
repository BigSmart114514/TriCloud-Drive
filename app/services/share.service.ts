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

export interface ShareState {
  mode: ShareMode
  modeLabel: string
  isBoundary: boolean
  IsPublic: boolean
  grants: ShareGrant[]
}

export interface ShareCandidate {
  id: number
  username: string
  email?: string
}

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
    return await $fetch<ShareState & { success: boolean; message: string }>('/api/share/mode', {
      method: 'POST',
      body: { ...scopeParams(target), ...payload }
    })
  },

  async candidates(keyword: string, excludeIds: number[] = []) {
    if (!keyword.trim()) return { candidates: [] as ShareCandidate[] }
    return await $fetch<{ success: boolean; candidates: ShareCandidate[] }>('/api/share/candidates', {
      params: { q: keyword.trim(), exclude: excludeIds.filter(Boolean).join(',') || undefined }
    })
  }
}

export { SHARE_INHERIT, SHARE_SHARED }
