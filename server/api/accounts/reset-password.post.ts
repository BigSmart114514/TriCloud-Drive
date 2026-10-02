// server/api/accounts/reset-password.post.ts
// 主账号给子账户重置密码。
//
// 为什么单独一个接口而不复用 auth/change-password：那个接口的代管路径要求
// `useAdmin && isStaff`（见 auth-middleware 的 resolveIdentity），主账号不是
// 管理员，走不通。而子账户自己**不能**改密码（canChangePassword = 0）——
// 忘了密码就彻底锁死，所以这条是必需能力，不是便利功能。
//
// 只碰 password_hash 一列；canChangePassword 保持 0不变。
import { getDb } from '~~/server/utils/db-adapter'
import { requireAuth } from '~~/server/utils/auth-middleware'
import { requireOwnChild } from '~~/server/utils/account'
import { hashPassword, validatePassword } from '~~/server/utils/auth'

export default defineEventHandler(async (event) => {
  const me = await requireAuth(event)
  const meId = Number(me.userId)
  const db = getDb(event)
  if (!db) throw createError({ statusCode: 500, message: '数据库连接失败' })

  const body = await readBody(event).catch(() => null)
  const id = Number(body?.id)
  const newPassword = String(body?.newPassword ?? '')

  if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, message: '缺少子账户 ID' })
  if (!newPassword) throw createError({ statusCode: 400, message: '请输入新密码' })
  if (!validatePassword(newPassword)) {
    throw createError({ statusCode: 400, message: '密码至少8位，且包含字母和数字' })
  }

  const child = await requireOwnChild(db, meId, id)
  if (!child) throw createError({ statusCode: 404, message: '子账户不存在' })

  await db
    .prepare('UPDATE users SET password_hash = ? WHERE id = ? AND parent_id = ?')
    .bind(await hashPassword(newPassword), id, meId)
    .run()

  return { success: true, statusMessage: '密码已重置' }
})