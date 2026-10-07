import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { dbConnectionError } from '~~/types/error'
import { placeholders } from '~~/server/utils/functions'
import { escapeLike } from '~~/server/utils/escape'
import { candidateExclusions } from '~~/server/utils/share'
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

    // 「谁能进名单」的规则只有一份，在 share.ts 里，与写时的 assertGrantees 同源。
    //
    // 原先这里自己抄了一份，把「我」和「属主」两个都排掉 —— 而管理视角下
    // 该排的只有属主。后果是管理员在替别人管分享时搜不到自己，于是
    // 「给自己开一份别人的文件访问」这个操作根本做不了，尽管 assertGrantees
    // 那一侧本来就允许它。理由与两个视角的差别见 candidateExclusions 的注释。
    const keep = candidateExclusions({
      meId,
      targetUserId: Number(targetUserId),
      adminMode,
      exclude: q?.exclude
    })

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
