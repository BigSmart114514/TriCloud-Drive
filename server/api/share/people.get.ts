// server/api/share/people.get.ts
import { requireAuth } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { dbConnectionError } from '~~/types/error'

/**
 * 首页侧栏的数据源：**有内容是我能看的**人。
 *
 * 两类取并集：
 *   granted —— folder_access / file_access 里明确授权给我的
 *   public  —— 有 IsPublic = 1 的公开项（对所有人可读）
 *
 * 不含全站所有人，只含和我有关系的。排除自己（侧栏首行固定是「我的文件」，
 * 重复一行没法解释）。
 *
 * 刻意放在 /api/share 而不是 /api/manage：这是普通功能，管理员和普通用户
 * 拿到的**是同一份数据**。管理能力只在 /api/manage/*。
 *
 * 刻意不返回 IsAdmin / IsSuperAdmin：侧栏在「谁分享了我」的语境下不需要角色，
 * 带了等于把谁是管理员告诉所有人。maxPermission 同理只在你有显式授权时才有值。
 */
export default defineEventHandler(async (event) => {
  const me = await requireAuth(event)
  const myId = Number(me.userId)

  const db = getDb(event)
  if (!db) throw dbConnectionError

  const rows = await db
    .prepare(`
      SELECT u.id, u.username, u.email,
             MAX(a.is_grant)  AS hasGrant,
             MAX(a.is_public) AS hasPublic,
             MAX(a.permission) AS maxPermission
      FROM users u
      JOIN (
        SELECT f.user_id AS owner_id, 1 AS is_grant, 0 AS is_public, fa.permission AS permission
        FROM folder_access fa JOIN folders f ON f.id = fa.folder_id
        WHERE fa.user_id = ?
        UNION ALL
        SELECT fl.user_id AS owner_id, 1 AS is_grant, 0 AS is_public, ga.permission AS permission
        FROM file_access ga JOIN files fl ON fl.id = ga.file_id
        WHERE ga.user_id = ?
        UNION ALL
        SELECT f.user_id AS owner_id, 0 AS is_grant, 1 AS is_public, NULL AS permission
        FROM folders f WHERE f.IsPublic = 1
        UNION ALL
        SELECT fl.user_id AS owner_id, 0 AS is_grant, 1 AS is_public, NULL AS permission
        FROM files fl WHERE fl.IsPublic = 1
      ) a ON a.owner_id = u.id
      WHERE u.id <> ?
      GROUP BY u.id, u.username, u.email
      ORDER BY u.username COLLATE NOCASE ASC
    `)
    .bind(myId, myId, myId)
    .all()

  const people = (rows?.results || []).map((r: any) => {
    const hasGrant = Number(r.hasGrant ?? 0) === 1
    const hasPublic = Number(r.hasPublic ?? 0) === 1
    return {
      id: Number(r.id),
      username: r.username ?? null,
      email: r.email ?? null,
      relation: hasGrant && hasPublic ? 'both' : hasGrant ? 'granted' : 'public',
      maxPermission: hasGrant ? Number(r.maxPermission ?? 0) : 0
    }
  })

  return { success: true, people }
})
