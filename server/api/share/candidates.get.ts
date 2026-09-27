import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { dbConnectionError } from '~~/types/error'
import { placeholders } from '~~/server/utils/functions'
import { getQuery } from 'h3'

/**
 * 搜索可授权的人员。分享需要「按名字找人」，但 listUsers 是管理员专用，
 * 所以这里单独提供一个按需搜索：必须带关键词，且只返回不含敏感字段的最小信息。
 * 注意：这意味着任何登录用户都能按需枚举他人用户名/邮箱，
 * 这是「按名字分享」这个交互本身的固有代价（与网盘产品一致）。
 */
export default defineEventHandler(async (event) => {
  try {
    const { me } = await getMeAndTarget(event)
    const meId = Number(me.userId)
    const db = getDb(event)
    if (!db) throw dbConnectionError

    const q = getQuery(event) as { q?: string; exclude?: string }
    const keyword = String(q?.q ?? '').trim()
    if (keyword.length < 1) {
      return { success: true, candidates: [] }
    }

    // 排除自己，以及已经在名单里的人（可由调用方传 exclude=1,2,3）
    const excluded = new Set<number>([meId])
    if (q?.exclude) {
      for (const part of String(q.exclude).split(',')) {
        const n = Number(part)
        if (Number.isInteger(n) && n > 0) excluded.add(n)
      }
    }
    const keep = [...excluded]

    const res = await db
      .prepare(`
        SELECT id, username, email
        FROM users
        WHERE (username LIKE ? OR email LIKE ?)
          ${keep.length ? `AND id NOT IN (${placeholders(keep.length)})` : ''}
        ORDER BY username ASC
        LIMIT 20
      `)
      .bind(`%${keyword}%`, `%${keyword}%`, ...keep)
      .all()

    return {
      success: true,
      candidates: (res?.results || []).map((r: any) => ({
        id: Number(r.id),
        username: r.username,
        email: r.email
      }))
    }
  } catch (error: any) {
    console.error('Share candidates error:', error)
    if (error.statusCode) throw error
    throw createError({ statusCode: 500, statusMessage: '搜索用户失败' })
  }
})
