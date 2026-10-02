// server/api/accounts/index.post.ts
// 建子账户。
//
// 这是整个功能里**权限最敏感的一个接口**：它写的是 users 表，
// 而 users 表的 IsAdmin/IsSuperAdmin 决定全站授权。
//
// 所以下面这条是硬要求，不要为了省事改成「从 body 拿」：
//   IsAdmin = 0、IsSuperAdmin = 0、canChangePassword = 0
// 一个都不从请求里读。哪怕 body 里传了 IsAdmin: true 也不看。
import { getDb } from '~~/server/utils/db-adapter'
import { requireAuth } from '~~/server/utils/auth-middleware'
import { hashPassword, validateEmail, validatePassword, validateUsername } from '~~/server/utils/auth'
import { checkNonNegative, GATE_MESSAGES, subAccountGate } from '~~/server/utils/account'
import { isSqlDateTimeString } from '~~/server/utils/time'
import { dbConnectionError } from '~~/types/error'

export default defineEventHandler(async (event) => {
  // 鉴权必须在读 body 之前
  const me = await requireAuth(event)
  const meId = Number(me.userId)
  const db = getDb(event)
  if (!db) throw dbConnectionError

  const gate = await subAccountGate(db, meId)
  if (!gate.allowed) {
    throw createError({ statusCode: 403, message: GATE_MESSAGES[gate.reason!] })
  }

  const body = await readBody(event).catch(() => null)
  const email = String(body?.email ?? '').trim()
  const username = String(body?.username ?? '').trim()
  const password = String(body?.password ?? '')
  const maxStorage = Number(body?.maxStorage ?? 0)
  const maxDownload = Number(body?.maxDownload ?? 0)
  const expireAt = body?.expire_at == null || body?.expire_at === '' ? null : String(body.expire_at)

  if (!email || !username || !password) {
    throw createError({ statusCode: 400, message: '邮箱、用户名、密码都是必填项' })
  }
  if (!validateEmail(email)) throw createError({ statusCode: 400, message: '邮箱格式不正确' })
  if (!validateUsername(username)) throw createError({ statusCode: 400, message: '用户名格式不正确，暂时只能包含大小写字母和数字' })
  if (!validatePassword(password)) throw createError({ statusCode: 400, message: '密码至少8位，且包含字母和数字' })

  const bad = checkNonNegative(maxStorage)
  if (bad) throw createError({ statusCode: 400, message: `存储上限${bad}` })
  const bad2 = checkNonNegative(maxDownload)
  if (bad2) throw createError({ statusCode: 400, message: `下载上限${bad2}` })

  // 空值 = 不限（与 maxStorage/maxDownload 的既有口径一致）。
  // 注意不是 1 —— users 表的默认 maxStorage 是 1，也就是 1 字节，
  // 新建就立刻什么都传不了；这里显式给 0，池兜底。
  if (expireAt != null && !isSqlDateTimeString(expireAt)) {
    throw createError({ statusCode: 400, message: '到期时间格式不正确' })
  }

  const exists = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first()
  if (exists) throw createError({ statusCode: 409, message: '该用户名已被注册' })

  const hash = await hashPassword(password)

  /**
   * 列名逐个写死，不拼字符串。
   *
   * parent_id = 我；canChangePassword = 0（子账户不能自助改密码，
   * 忘了只能我重置 —— 见 reset-password.post.ts）；
   * IsAdmin / IsSuperAdmin 不在列表里，落到列默认值 0。
   */
  const created = await db
    .prepare(`
      INSERT INTO users
        (email, username, password_hash, parent_id, canChangePassword, maxStorage, maxDownload, expire_at)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?)
      RETURNING id, username, email
    `)
    .bind(email, username, hash, meId, maxStorage, maxDownload, expireAt)
    .first()

  return { success: true, statusMessage: '子账户已创建', child: created }
})