// server/api/manage/updateUser.post.ts
import { getMethod, readBody } from 'h3'
import { getDb } from '~~/server/utils/db-adapter'
import { requireAdmin } from '~~/server/utils/auth-middleware'

export default defineEventHandler(async (event) => {
  if (getMethod(event) !== 'POST') {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }

  // 管理员门控：这个接口能改 IsSuperAdmin / 配额 / 有效期，
  // 漏了校验等于任何登录用户都能给自己提权，必须在读 body 之前就拦住
  await requireAdmin(event)

  try {
    const body = await readBody(event)
    const {
      id,
      IsAdmin,
      IsSuperAdmin,
      maxStorage,
      usedStorage,
      maxDownload,
      usedDownload,
      expire_at
    } = body || {}

    if (!id && id !== 0) {
      throw createError({ statusCode: 400, statusMessage: '缺少用户ID' })
    }

    // 基本数值清洗，确保为非负数
    const toNonNegativeNumber = (v: any) => {
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? n : 0
    }

    const db = getDb(event)

    const sql = `
      UPDATE users
      SET
        IsAdmin = ?,
        IsSuperAdmin = ?,
        maxStorage = ?,
        usedStorage = ?,
        maxDownload = ?,
        usedDownload = ?,
        expire_at = ?
      WHERE id = ?
    `
    const stmt = db.prepare(sql)
    await stmt
      .bind(
        IsAdmin ? 1 : 0,
        IsSuperAdmin ? 1 : 0,
        toNonNegativeNumber(maxStorage),
        toNonNegativeNumber(usedStorage),
        toNonNegativeNumber(maxDownload),
        toNonNegativeNumber(usedDownload),
        expire_at,
        id
      )
      .run()

    return { success: true }
  } catch (error) {
    console.error('updateUser error:', error)
    throw createError({ statusCode: 500, statusMessage: 'Internal Server Error' })
  }
})