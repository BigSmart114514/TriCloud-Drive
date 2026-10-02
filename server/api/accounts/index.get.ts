// server/api/accounts/index.get.ts
// 主账号看自己的子账户 + 池的汇总。
//
// **只列 parent_id = 自己**。别人的子账户、以及别人的池用量，都不返回。
// 子账户自己登录这一页只会看到「你不能创建子账户」——他没有孩子，
// 他也不该看到别人的。这与「父子完全隔离」一致。
import { getQuery } from 'h3'
import { getDb } from '~~/server/utils/db-adapter'
import { requireAuth } from '~~/server/utils/auth-middleware'
import { poolUsage } from '~~/server/utils/sub-account'
import { escapeLike } from '~~/server/utils/escape'
import { isExpired } from '~~/server/utils/time'
import { dbConnectionError } from '~~/types/error'

export default defineEventHandler(async (event) => {
  const me = await requireAuth(event)
  const meId = Number(me.userId)
  const db = getDb(event)
  if (!db) throw dbConnectionError

  const q = getQuery(event) as { username?: string }

  const rows = await db
    .prepare(`
      SELECT id, username, email, created_at, expire_at,
             maxStorage, maxSubAccount, canSubAccount,
             usedStorage, usedDownload, maxDownload
      FROM users
      WHERE parent_id = ?
        ${q.username ? "AND username LIKE ? ESCAPE '\\'" : ''}
      ORDER BY created_at DESC
    `)
    .bind(...(q.username ? [meId, `%${escapeLike(q.username)}%`] : [meId]))
    .all()

  const children = (rows?.results ?? []).map((r: any) => ({
    id: Number(r.id),
    username: r.username,
    email: r.email,
    createdAt: r.created_at,
    expireAt: r.expire_at,
    expired: isExpired(r.expire_at),
    usedStorage: Number(r.usedStorage ?? 0),
    maxStorage: Number(r.maxStorage ?? 0),
    usedDownload: Number(r.usedDownload ?? 0),
    maxDownload: Number(r.maxDownload ?? 0)
  }))

  const storage = await poolUsage(db, meId, 'usedStorage')
  const download = await poolUsage(db, meId, 'usedDownload')

  const self = await db
    .prepare('SELECT canSubAccount AS canSub, maxSubAccount AS maxSub, parent_id AS parentId FROM users WHERE id = ?')
    .bind(meId)
    .first()

  return {
    success: true,
    children,
    pool: {
      storage: { own: storage.self, children: storage.children, total: storage.total, max: storage.max },
      download: { own: download.self, children: download.children, total: download.total, max: download.max }
    },
    /** 建号能力与上限，页面据此决定「添加子账户」那张卡要不要显示 */
    capability: {
      canSubAccount: Number((self as any)?.canSub ?? 0) === 1,
      maxSubAccount: Number((self as any)?.maxSub ?? 0),
      /** 我自己是别人的子账户吗？强制一层，所以此时 should be 一直为 false */
      isChild: (self as any)?.parentId != null
    },
    totalCount: children.length
  }
})