import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { dbConnectionError } from '~~/types/error'
import { FileService, FolderService } from '~~/server/utils/db'
import { assertShareTargetType, assertTargetId, getShareState, resolveShareTarget } from '~~/server/utils/share'
import { isShareBoundary, PERMISSION_LABELS, SHARE_MODE_LABELS } from '~~/types/share'

export default defineEventHandler(async (event) => {
  try {
    const { authUserId } = await getMeAndTarget(event)
    // 属主只能是「我」：分享设置是私有数据。
    // useAdmin 时 authUserId 才是 targetUserId，管理员代看行为与原版一致。
    const ownerId = Number(authUserId)
    const db = getDb(event)
    if (!db) throw dbConnectionError

    const q = getQuery(event) as { targetType?: string; targetId?: string }
    const type = assertShareTargetType(q?.targetType)
    const targetId = assertTargetId(q?.targetId)

    const target = await resolveShareTarget(db, type, targetId, ownerId)
    const fileService = new FileService(db)
    const folderService = new FolderService(db)

    const grants =
      type === 'file' ? await fileService.listGrants(targetId) : await folderService.listGrants(targetId)

    const users = grants.length
      ? await db
          .prepare(
            `SELECT id, username, email FROM users WHERE id IN (${grants.map(() => '?').join(',')})`
          )
          .bind(...grants.map((g) => g.userId))
          .all()
      : { results: [] }

    const userMap = new Map(
      (users?.results || []).map((u: any) => [
        Number(u.id),
        { username: u.username, email: u.email }
      ])
    )

    // 目标自身的共享状态，方便前端直接渲染三态选择器
    const state = await getShareState(db, target)

    return {
      success: true,
      targetType: type,
      targetId,
      ownerId: target.ownerId,
      mode: state.mode,
      modeLabel: SHARE_MODE_LABELS[state.mode] ?? '',
      isBoundary: isShareBoundary(state.mode),
      IsPublic: state.isPublic,
      grants: grants.map((g) => ({
        ...g,
        label: PERMISSION_LABELS[g.permission] ?? String(g.permission),
        user: userMap.get(g.userId) ?? null
      }))
    }
  } catch (error: any) {
    console.error('Share list error:', error)
    if (error.statusCode) throw error
    throw createError({ statusCode: 500, message: '获取分享列表失败' })
  }
})
