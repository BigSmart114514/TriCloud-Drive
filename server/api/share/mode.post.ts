import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { dbConnectionError } from '~~/types/error'
import {
  assertGrantees,
  assertPermissionBits,
  assertShareTargetType,
  assertTargetId,
  getShareState,
  listGrantsWithUsers,
  replaceAccess,
  resolveShareTarget,
  setPublic,
  setShareMode
} from '~~/server/utils/share'
import { isShareBoundary, normalizeShareMode, SHARE_MODE_LABELS } from '~~/types/share'
import type { ShareMode } from '~~/types/share'

/**
 * 修改分享状态。这是唯一的写接口，取代了原来的 grant / revoke：
 *
 *   mode      共享三态：0 不分享 / 1 分享 / 2 继承
 *   isPublic  对所有已登录用户可读（不含未登录：/api/** 一律先过 requireAuth）
 *   grants    授权名单，**整体覆盖**：传什么就是最终名单，不在列表里的人会被移除
 *
 * 三个字段都可选，只传要改的。grants 传空数组 = 清空名单。
 * 目标永远是文件或文件夹，用 targetType 区分。
 */
export default defineEventHandler(async (event) => {
  try {
    const { authUserId } = await getMeAndTarget(event)
    // 属主只能是「我」：否则普通用户传 targetUserId 就能改别人的分享设置。
    // useAdmin 时 authUserId 才是 targetUserId，管理员代看行为与原版一致。
    const ownerId = Number(authUserId)
    const db = getDb(event)
    if (!db) throw dbConnectionError

    const body = await readBody(event)
    const type = assertShareTargetType(body?.targetType)
    const targetId = assertTargetId(body?.targetId)
    const target = await resolveShareTarget(db, type, targetId, ownerId)

    let mode: ShareMode | null = null
    if (body?.mode !== undefined && body?.mode !== null) {
      mode = await setShareMode(db, target, normalizeShareMode(body.mode))
    }

    let isPublic: boolean | null = null
    if (body?.isPublic !== undefined && body?.isPublic !== null) {
      isPublic = await setPublic(db, target, body.isPublic === true || body.isPublic === 1)
    }

    // 名单整体覆盖。必须先校验再写：把不存在的用户、或属主自己写进名单
    // 会在下一层撞上约束报错，回滚比预先拦住麻烦
    if (body?.grants !== undefined && body?.grants !== null) {
      const list: any[] = Array.isArray(body.grants) ? body.grants : []
      const normalized: Array<{ userId: number; permission: number }> = list.map((g: any) => ({
        userId: Number(g?.userId),
        permission: assertPermissionBits(g?.permission)
      }))
      // 空名单是合法的「清空」，不能走 assertGrantees —— 它要求至少一个人
      if (normalized.length === 0) {
        await replaceAccess(db, target, [])
      } else {
        const ids = await assertGrantees(db, normalized.map((g) => g.userId), ownerId)
        const byId = new Map(normalized.map((g) => [g.userId, g.permission]))
        await replaceAccess(db, target, ids.map((id) => ({ userId: id, permission: byId.get(id)! })))
      }
    }

    const state = await getShareState(db, target)
    // 用共用的这个而不是 listGrants：它补了用户名。前端 submitGrants 会用这里的
    // 返回覆盖本地名单，缺 user 的话界面上会变成「未知用户」。
    const grants = await listGrantsWithUsers(db, target)

    return {
      success: true,
      statusMessage: mode !== null
        ? `已设为「${SHARE_MODE_LABELS[state.mode]}」`
        : '分享设置已更新',
      targetType: type,
      targetId,
      mode: state.mode,
      modeLabel: SHARE_MODE_LABELS[state.mode] ?? '',
      isBoundary: isShareBoundary(state.mode),
      IsPublic: state.isPublic,
      grants
    }
  } catch (error: any) {
    console.error('Share mode error:', error)
    if (error.statusCode) throw error
    throw createError({ statusCode: 500, message: '设置分享状态失败' })
  }
})
