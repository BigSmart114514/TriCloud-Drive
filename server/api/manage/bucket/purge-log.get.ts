// /api/manage/bucket/purge-log —— 清理历史。
//
// 这个项目的其他删除（files/delete、folders/delete、purge-user）都**不留记录**，
// 只有 purge-user 有 console.warn —— 而那在容器/serverless 上随时可能没。
// 所以「上周是谁清掉了这个用户的 3 个文件」这个问题此前无解。
//
// 这张表回答的是两件事：
//   - 删错了，能看出当时删的到底是什么（payload 是快照，不受后续改动影响）
//   - 用户投诉「我上周的文件不见了」，能给出时间与范围
//
// 故意不按 users 表建外键：删用户时审计记录必须留下来，而 CASCADE 会
// 把它一起带走 —— 恰好在需要账本的时候把账本清掉。
import { defineEventHandler, getQuery } from 'h3'
import { getDb } from '~~/server/utils/db-adapter'
import { requireSuperAdmin } from '~~/server/utils/auth-middleware'
import { listPurgeLog } from '~~/server/utils/bucket-admin'

export default defineEventHandler(async (event) => {
  await requireSuperAdmin(event)

  const q = getQuery(event)
  const rawUserId = q?.userId
  const userId = rawUserId != null && rawUserId !== '' ? Number(rawUserId) : null

  if (userId !== null && (!Number.isSafeInteger(userId) || userId <= 0)) {
    throw createError({ statusCode: 400, message: 'userId 不合法' })
  }

  const limit = q?.limit != null ? Number(q.limit) : undefined

  const db = getDb(event)
  const entries = await listPurgeLog(db, { userId, limit })

  return { entries }
})