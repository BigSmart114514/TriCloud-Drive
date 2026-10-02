// server/api/accounts/delete.post.ts
// 主账号删掉自己的子账户。
//
// 与 manage/deleteUser 的差别只有「授权那一层」：那边是 requireAdmin，
// 这边是 requireAuth + parent_id = 我。COS 清理和级联删都走共用的
// purge-user.ts，不抄第二遍。
//
// 子账户自己不能删自己（没有这个入口）—— 与子账户不能改密码同一个思路：
// 账号的存废由主账号决定。
import { getDb } from '~~/server/utils/db-adapter'
import { requireAuth } from '~~/server/utils/auth-middleware'
import { requireOwnChild } from '~~/server/utils/account'
import { enableForeignKeys, purgeUserFiles } from '~~/server/utils/purge-user'
import { dbConnectionError } from '~~/types/error'

export default defineEventHandler(async (event) => {
  const me = await requireAuth(event)
  const meId = Number(me.userId)
  const db = getDb(event)
  if (!db) throw dbConnectionError

  const body = await readBody(event).catch(() => null)
  const id = Number(body?.id)
  if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, message: '缺少子账户 ID' })

  const child = await requireOwnChild(db, meId, id)
  if (!child) throw createError({ statusCode: 404, message: '子账户不存在' })

  const name = String((child as any).username || id)

  const purge = await purgeUserFiles(db, id, useRuntimeConfig())
  await enableForeignKeys(db)

  try {
    // WHERE 带上 parent_id = 我：即使前面查过也别只靠 id 删，
    // 中间若有并发改动 parent_id（目前只有管理员能改）就删不到别人头上
    const r: any = await db.prepare('DELETE FROM users WHERE id = ? AND parent_id = ?').bind(id, meId).run()
    const changed = Number(r?.meta?.changes ?? 0)
    if (changed !== 1) throw new Error('删除的行数不是 1')
  } catch (e: any) {
    throw createError({ statusCode: 500, message: e?.message || '删除失败' })
  }

  /**
   * 池不用还 —— 它本来就是实时 SUM(c.parent_id = me)，子账户行一删就自动退额。
   * 这一点是选「父行只记自己那份」的最大好处：删账号没有反向记账这一步。
   */
  return {
    success: true,
    statusMessage: purge.attempted && !purge.complete
      ? `已删除「${name}」，但 COS 文件删除可能失败`
      : `已删除「${name}」`,
    cosAttempted: purge.attempted,
    cosDeleteAll: purge.complete
  }
})