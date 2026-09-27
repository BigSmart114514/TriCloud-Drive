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

  async setState(
    target: ShareTargetType,
    payload: { mode?: ShareMode; isPublic?: boolean }
  ) {
    return await $fetch<ShareState & { success: boolean; message: string }>('/api/share/mode', {
      method: 'POST',
      body: { ...target, ...payload }
    })
  },

  async grant(target: ShareTargetType, userIds: number[], permission: number) {
    return await $fetch<{ success: boolean; message: string }>('/api/share/grant', {
      method: 'POST',
      body: { ...target, userIds, permission }
    })
  },

  async revoke(target: ShareTargetType, userIds: number[]) {
    return await $fetch<{ success: boolean; message: string }>('/api/share/revoke', {
      method: 'POST',
      body: { ...target, userIds }
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
