import type { Database } from '~~/server/utils/db'
import { placeholders, uniqPositiveInts } from '~~/server/utils/functions'
import { normalizePermission, PERM_ALL } from '~~/types/share'

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

/** 授权：已存在则更新权限。先 UPDATE 再 INSERT，避免依赖各方言的 upsert 语法。 */
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
  await syncSharedFlag(db, target)
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
    removed += Number((res as any)?.meta?.changes ?? 0)
  }
  await syncSharedFlag(db, target)
  return removed
}

/**
 * 维护不变量：Shared = 1 当且仅当还有授权行。
 * 少了这一步，向上查找的边界就会停在错误的节点上。
 */
export async function syncSharedFlag(db: Database, target: ShareTarget): Promise<boolean> {
  const table = accessTable(target)
  const column = targetColumn(target)
  const res = await db
    .prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE ${column} = ?`)
    .bind(target.id)
    .first()
  const total = Number(res?.total ?? 0)
  await db
    .prepare(`UPDATE ${target.table} SET Shared = ? WHERE id = ?`)
    .bind(total > 0 ? 1 : 0, target.id)
    .run()
  return total > 0
}
