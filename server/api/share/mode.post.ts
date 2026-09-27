import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { dbConnectionError } from '~~/types/error'
import {
  assertShareTargetType,
  assertTargetId,
  getShareState,
  resolveShareTarget,
  setPublic,
  setShareMode
} from '~~/server/utils/share'
import { isShareBoundary, normalizeShareMode, SHARE_MODE_LABELS } from '~~/types/share'

/** 设置共享三态：0 不分享 / 1 分享 / 2 继承。也可同时设置 isPublic。 */
export default defineEventHandler(async (event) => {
  try {
    const { targetUserId } = await getMeAndTarget(event)
    const ownerId = Number(targetUserId)
    const db = getDb(event)
    if (!db) throw dbConnectionError

    const body = await readBody(event)
    const type = assertShareTargetType(body?.targetType)
    const targetId = assertTargetId(body?.targetId)
    const target = await resolveShareTarget(db, type, targetId, ownerId)

    let mode: number | null = null
    if (body?.mode !== undefined && body?.mode !== null) {
      mode = setShareMode(db, target, normalizeShareMode(body.mode))
    }

    let isPublic: boolean | null = null
    if (body?.isPublic !== undefined && body?.isPublic !== null) {
      isPublic = await setPublic(db, target, body.isPublic === true || body.isPublic === 1)
    }

    const state = await getShareState(db, target)

    return {
      success: true,
      message: mode !== null
        ? `已设为「${SHARE_MODE_LABELS[state.mode]}」`
        : '分享设置已更新',
      targetType: type,
      targetId,
      mode: state.mode,
      modeLabel: SHARE_MODE_LABELS[state.mode] ?? '',
      isBoundary: isShareBoundary(state.mode),
      IsPublic: state.isPublic
    }
  } catch (error: any) {
    console.error('Share mode error:', error)
    if (error.statusCode) throw error
    throw createError({ statusCode: 500, statusMessage: '设置分享状态失败' })
  }
})
