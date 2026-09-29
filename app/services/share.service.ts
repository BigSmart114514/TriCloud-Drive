import { SHARE_INHERIT, SHARE_SHARED } from '~~/types/share'
import type { ShareMode } from '~~/types/share'

export interface ShareTargetType {
  targetType: 'file' | 'folder'
  targetId: number
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

export const ShareService = {
  async list(target: ShareTargetType) {
    return await $fetch<ShareState & { success: boolean; targetId: number; ownerId: number }>(
      '/api/share/list',
      { params: { targetType: target.targetType, targetId: target.targetId } }
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
      body: { ...target, ...payload }
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
