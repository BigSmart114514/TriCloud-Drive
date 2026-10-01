// 一个目录的祖先链（根在前）。给「在文件里打开」用。
//
// ## 为什么要这个接口
//
// 分享管理页、搜索结果里都能点「在文件里打开」，落点是一个目录。
// 首页的 FileBrowser 拿到这个目录后要重建**面包屑**，而面包屑要的是
// 「根 → 目标」每一级的 id 和名字 —— 光有 targetId 重建不出来。
//
// 走 URL 而不是别的：/?at=<folderId> 可以收藏、可以发给自己的另一个浏览器，
// 刷新也还在。用一次性内存传参的话这些全做不到。
//
// ## 只给「我自己的树」
//
// user_id = me，不接受任何用户参数。理由与 /api/share/settings 一样：
// 祖先链是目录名，而目录名在这里没有授权模型（能列目录 ≠ 能知道它上面
// 每一级的名字），所以只对自己开。管理员代管走 targetUserId 的路径不适用 ——
// 首页的「在文件里打开」永远落在自己树上。

import { requireAuth } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import { dbConnectionError } from '~~/types/error'

export default defineEventHandler(async (event) => {
  const me = await requireAuth(event)
  const ownerId = Number(me.userId)

  const folderId = Number(getQuery(event)?.id)
  if (!Number.isInteger(folderId) || folderId < 1) {
    throw createError({ statusCode: 400, message: '非法的目录 id' })
  }

  const db = getDb(event)
  if (!db) throw dbConnectionError

  // 先确认这个目录是我的树上的一条，再上溯。上溯本身会无条件往上走，
  // 所以「起点属主」这一步不能省。
  const own = await db
    .prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?')
    .bind(folderId, ownerId)
    .first()
  if (!own) {
    throw createError({ statusCode: 404, message: '文件夹不存在' })
  }

  const res = await db
    .prepare(
      `
      WITH RECURSIVE up(id, name, parent_id, depth) AS (
        SELECT id, name, parent_id, 0 FROM folders WHERE id = ? AND user_id = ?
        UNION ALL
        SELECT p.id, p.name, p.parent_id, up.depth + 1
        FROM folders p JOIN up ON p.id = up.parent_id
      )
      SELECT id, name FROM up ORDER BY depth DESC
    `
    )
    .bind(folderId, ownerId)
    .all()

  return {
    success: true,
    folderId,
    // 根在前。collectHits 那套「depth DESC 即根→目标」的顺序，这里同理
    lineage: (res?.results || []).map((r: any) => ({ id: Number(r.id), name: String(r.name) }))
  }
})
