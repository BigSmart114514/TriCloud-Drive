import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { dbConnectionError } from '~~/types/error'
import {
  assertGrantees,
  assertShareTargetType,
  assertTargetId,
  resolveShareTarget,
  revokeAccess
} from '~~/server/utils/share'

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
    const userIds = await assertGrantees(db, body?.userIds || [], target.ownerId)

    const removed = await revokeAccess(db, target, userIds)

    return {
      success: true,
      message: removed ? `已取消 ${removed} 条授权` : '没有需要取消的授权',
      targetType: type,
      targetId,
      userIds
    }
  } catch (error: any) {
    console.error('Share revoke error:', error)
    if (error.statusCode) throw error
    throw createError({ statusCode: 500, statusMessage: '取消授权失败' })
  }
})
