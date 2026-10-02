// server/api/manage/deleteUser.post.ts
import { defineEventHandler, readBody, createError, getMethod } from 'h3'
import { getDb } from '~~/server/utils/db-adapter'
import { FileService } from '~~/server/utils/db'
import { requireAdmin } from '~~/server/utils/auth-middleware'
import { enableForeignKeys, purgeUserFiles } from '~~/server/utils/purge-user'

function toBool(v: any) {
  return v === true || v === 1 || v === '1'
}

export default defineEventHandler(async (event) => {
  // 管理员门控：原先这里自己查库判 IsAdmin/IsSuperAdmin，
  // 与 requireAdmin 完全重复，收敛到一处避免两套逻辑各自漂移
  const me = await requireAdmin(event)

  if (getMethod(event) !== 'POST') {
    throw createError({ statusCode: 405, statusMessage: 'Method Not Allowed' })
  }

  const body = await readBody<{ id: number | string }>(event)
  const userId = Number(body?.id)
  if (!Number.isInteger(userId) || userId <= 0) {
    throw createError({ statusCode: 400, message: '参数错误：id' })
  }

  const db = getDb(event)

  // 查询目标用户
  const target: any = await db
    .prepare('SELECT id, email, username, IsAdmin, IsSuperAdmin FROM users WHERE id = ?')
    .bind(userId)
    .first()

  if (!target) {
    throw createError({ statusCode: 404, message: '用户不存在' })
  }

  const targetIsAdmin = toBool(target.IsAdmin)
  const targetIsSuperAdmin = toBool(target.IsSuperAdmin)

  // 权限规则：
  // - 超管可以删除任何用户，但不能删除系统最后一个超管
  // - 管理员只能删除普通用户（不能删管理员或超管）
  if (!me.isSuperAdmin) {
    if (targetIsAdmin || targetIsSuperAdmin) {
      throw createError({ statusCode: 403, message: '普通管理员不能删除管理员或超级管理员' })
    }
  }

  // 若要删除的是超管，确保不是最后一个超管
  if (targetIsSuperAdmin) {
    // 适配器的 first()/all()/run() 都挂在 prepare().bind() 的返回值上，
    // 少写 .bind() 会得到 "db.prepare(...).first is not a function"
    const row: any = await db
      .prepare('SELECT COUNT(1) AS cnt FROM users WHERE IsSuperAdmin = 1')
      .bind()
      .first()
    const cnt = Number(row?.cnt ?? 0)
    if (cnt <= 1) {
      throw createError({ statusCode: 400, message: '不能删除最后一个超级管理员' })
    }
  }

  /**
   * 还有子账户的主账号不许删。
   *
   * parent_id **故意没加 ON DELETE CASCADE**（理由在 schema.sql），因为
   * SQLite 的级联只认识数据库：它会把子账户的 users 行悄悄删掉，但
   *   - 那个孩子的 COS 对象还在（物理删不在 SQLite 的级联里）→ 孤儿对象，
   *     花了钱存的东西既列不出来也删不掉
   *   - 主账号的池是「实时 SUM 孩子」，级联删完会**自动**把额度还回去，
   *     于是账上看着干净，孤儿对象一个不少
   *
   * 所以在这里挡下来，让用户先把子账户一个个删掉（那���接口会正经清 COS）。
   */
  const childCount = Number((await db
    .prepare('SELECT COUNT(*) AS n FROM users WHERE parent_id = ?')
    .bind(userId)
    .first())?.n ?? 0)
  if (childCount > 0) {
    throw createError({
      statusCode: 400,
      message: `该账号还有 ${childCount} 个子账户，请先删除它们`
    })
  }

  const purge = await purgeUserFiles(db, userId, useRuntimeConfig())

  // 删除用户（files、folders 表通过 ON DELETE CASCADE 自动级联删除）
  try {
    await db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run()
  } catch (e: any) {
    throw createError({ statusCode: 500, message: e?.message || '删除失败' })
  }

  return {
    success: true,
    statusMessage:
      purge.attempted && !purge.complete
        ? '用户已删除，但 COS 文件删除可能失败'
        : '用户及其 COS 文件已删除',
    cosAttempted: purge.attempted,
    cosDeleteAll: purge.complete,
  }
})