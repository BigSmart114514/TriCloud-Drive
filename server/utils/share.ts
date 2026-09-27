import type { Database } from '~~/server/utils/db'
import { placeholders, uniqPositiveInts } from '~~/server/utils/functions'
import { normalizePermission, normalizeShareMode, PERM_ALL, SHARE_NONE, SHARE_SHARED } from '~~/types/share'
import type { ShareMode } from '~~/types/share'

export type ShareTargetType = 'file' | 'folder'

export interface ShareTarget {
  type: ShareTargetType
  /** 所在表：files 或 folders */
  table: 'files' | 'folders'
  id: number
  /** 属主 id，只有属主（或管理员代操作）才能改授权 */
  ownerId: number
}

export function assertShareTargetType(value: any): ShareTargetType {
  if (value === 'file' || value === 'folder') return value
  throw createError({ statusCode: 400, statusMessage: 'targetType 必须是 file 或 folder' })
}

export function assertTargetId(value: any): number {
  const id = Number(value)
  if (!Number.isInteger(id) || id < 1) {
    throw createError({ statusCode: 400, statusMessage: '非法的 targetId' })
  }
  return id
}

/** 定位分享目标并校验操作者是属主。授权管理是属主专属权力，与访问权限无关。 */
export async function resolveShareTarget(
  db: Database,
  type: ShareTargetType,
  targetId: number,
  actingUserId: number
): Promise<ShareTarget> {
  const table = type === 'file' ? 'files' : 'folders'
  const row = await db.prepare(`SELECT id, user_id AS userId FROM ${table} WHERE id = ?`).bind(targetId).first()
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: type === 'file' ? '文件不存在' : '文件夹不存在' })
  }
  if (Number(row.userId) !== actingUserId) {
    throw createError({ statusCode: 403, statusMessage: '只有属主可以管理分享' })
  }
  return { type, table, id: targetId, ownerId: Number(row.userId) }
}

export function assertPermissionBits(value: any): number {
  const raw = Number(value)
  if (!Number.isInteger(raw) || raw <= 0) {
    throw createError({ statusCode: 400, statusMessage: '非法的 permission' })
  }
  if (raw & ~PERM_ALL) {
    throw createError({ statusCode: 400, statusMessage: 'permission 含未定义的权限位' })
  }
  return normalizePermission(raw)
}

/** 被授权人必须真实存在，且不能是属主本人 */
export async function assertGrantees(db: Database, userIds: number[], ownerId: number): Promise<number[]> {
  const ids = uniqPositiveInts(userIds)
  if (!ids.length) {
    throw createError({ statusCode: 400, statusMessage: 'userIds 不能为空' })
  }
  if (ids.includes(ownerId)) {
    throw createError({ statusCode: 400, statusMessage: '不能授权给属主本人' })
  }
  const res = await db
    .prepare(`SELECT id FROM users WHERE id IN (${placeholders(ids.length)})`)
    .bind(...ids)
    .all()
  const found = new Set((res?.results || []).map((r: any) => Number(r.id)))
  const missing = ids.filter((id) => !found.has(id))
  if (missing.length) {
    throw createError({ statusCode: 400, statusMessage: `用户不存在：${missing.join(', ')}` })
  }
  return ids
}

function accessTable(target: ShareTarget) {
  return target.type === 'file' ? 'file_access' : 'folder_access'
}
function targetColumn(target: ShareTarget) {
  return target.type === 'file' ? 'file_id' : 'folder_id'
}

/**
 * 授权：已存在则更新权限。先 UPDATE 再 INSERT，避免依赖各方言的 upsert 语法。
 *
 * 注意：这里**不会**去动 Shared —— 授权名单和「要不要切断继承」是独立的两件事。
 * 早期版本在这里自动把 Shared 置 1，结果属主只是想定向加一个人，
 * 却把这个节点变成了边界，把上层已共享的其他人全挡在门外。
 */
export async function grantAccess(
  db: Database,
  target: ShareTarget,
  userIds: number[],
  permission: number
): Promise<number> {
  const table = accessTable(target)
  const column = targetColumn(target)
  for (const userId of userIds) {
    const updated = await db
      .prepare(`UPDATE ${table} SET permission = ? WHERE ${column} = ? AND user_id = ?`)
      .bind(permission, target.id, userId)
      .run()
    const changes = Number((updated as any)?.meta?.changes ?? 0)
    if (changes === 0) {
      await db
        .prepare(`INSERT INTO ${table} (${column}, user_id, permission) VALUES (?, ?, ?)`)
        .bind(target.id, userId, permission)
        .run()
    }
  }
  return userIds.length
}

/** 取消授权 */
export async function revokeAccess(
  db: Database,
  target: ShareTarget,
  userIds: number[]
): Promise<number> {
  const table = accessTable(target)
  const column = targetColumn(target)
  let removed = 0
  for (const userId of userIds) {
    const res = await db
      .prepare(`DELETE FROM ${table} WHERE ${column} = ? AND user_id = ?`)
      .bind(target.id, userId)
      .run()
    removed += Number((res?.meta?.changes ?? 0) ?? (res as any)?.meta?.changes ?? 0)
  }
  return removed
}

/** 设置共享三态。不分享时顺带清掉公开标记，避免「严格私密却对外可读」的自相矛盾。 */
export async function setShareMode(
  db: Database,
  target: ShareTarget,
  mode: ShareMode
): Promise<ShareMode> {
  const m = normalizeShareMode(mode)
  if (m === SHARE_NONE) {
    await db
      .prepare(`UPDATE ${target.table} SET Shared = ?, IsPublic = 0 WHERE id = ?`)
      .bind(m, target.id)
      .run()
  } else {
    await db
      .prepare(`UPDATE ${target.table} SET Shared = ? WHERE id = ?`)
      .bind(m, target.id)
      .run()
  }
  return m
}

/** 设置公开（等价于给所有人 READ），属主专属 */
export async function setPublic(
  db: Database,
  target: ShareTarget,
  isPublic: boolean
): Promise<boolean> {
  const next = isPublic ? 1 : 0
  if (next) {
    // 公开是「分享」的一种，继承态下也允许，权限仍只到 READ
    await db
      .prepare(`UPDATE ${target.table} SET IsPublic = 1, Shared = CASE WHEN Shared = ? THEN ? ELSE Shared END WHERE id = ?`)
      .bind(SHARE_NONE, SHARE_SHARED, target.id)
      .run()
  } else {
    await db
      .prepare(`UPDATE ${target.table} SET IsPublic = 0 WHERE id = ?`)
      .bind(target.id)
      .run()
  }
  return next === 1
}

/** 该目标当前的共享状态 */
export async function getShareState(db: Database, target: ShareTarget) {
  const row = await db
    .prepare(`SELECT Shared, IsPublic FROM ${target.table} WHERE id = ?`)
    .bind(target.id)
    .first()
  return {
    mode: normalizeShareMode(row?.Shared),
    isPublic: Number(row?.IsPublic ?? 0) === 1
  }
}
