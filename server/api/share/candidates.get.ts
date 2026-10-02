import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { dbConnectionError } from '~~/types/error'
import { placeholders } from '~~/server/utils/functions'
import { escapeLike } from '~~/server/utils/escape'
import { getQuery } from 'h3'

/**
 * 搜索可授权的人员。分享需要「按名字找人」，但 listUsers 是管理员专用，
 * 所以这里单独提供一个按需搜索：必须带关键词，且只返回不含敏感字段的最小信息。
 * 注意：这意味着任何登录用户都能按需枚举他人用户名/邮箱，
 * 这是「按名字分享」这个交互本身的固有代价（与网盘产品一致）。
 */
export default defineEventHandler(async (event) => {
  try {
    const { me, adminMode, targetUserId } = await getMeAndTarget(event)
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
    // 管理视角下「自己」是**属主**：我在替 test 改分享，能搜到 test 的话
    // 管理员会把他加进名单，保存时才撞 assertGrantees 的 400
    // 「不能授权给属主本人」—— 让不可选的东西根本搜不出来。
    // （getMeAndTarget 已经保证非超管进不了超管的数据，这里只管属主这一层）
    if (adminMode) excluded.add(Number(targetUserId))
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
        WHERE (username LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')
          ${keep.length ? `AND id NOT IN (${placeholders(keep.length)})` : ''}
        ORDER BY username ASC
        LIMIT 20
      `)
      .bind(`%${escapeLike(keyword)}%`, `%${escapeLike(keyword)}%`, ...keep)
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
    throw createError({ statusCode: 500, message: '搜索用户失败' })
  }
})
