import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { dbConnectionError } from '~~/types/error'
import {
  assertGrantees,
  assertPermissionBits,
  assertShareTargetType,
  assertTargetId,
  grantAccess,
  resolveShareTarget
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
    const permission = assertPermissionBits(body?.permission)

    const target = await resolveShareTarget(db, type, targetId, ownerId)
    const userIds = await assertGrantees(db, body?.userIds || [], target.ownerId)

    const granted = await grantAccess(db, target, userIds, permission)

    return {
      success: true,
      message: `已授权 ${granted} 人`,
      targetType: type,
      targetId,
      permission,
      userIds
    }
  } catch (error: any) {
    console.error('Share grant error:', error)
    if (error.statusCode) throw error
    throw createError({ statusCode: 500, statusMessage: '授权失败' })
  }
})
