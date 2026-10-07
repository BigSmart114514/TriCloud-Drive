// /api/manage/bucket/reconcile —— 对账某个用户的存储。
//
// 只读。列桶里的对象 + 读数据库的 files 行，算出两个方向的漂移。
// 页面拿到这个结果后可以展示、以及逐个删孤儿（走 purge-orphans）。
//
// 超管门控见 requireSuperAdmin：/api/manage/ 整段只过 requireAdmin，
// 而它放行 isAdmin || isSuperAdmin —— 普通管理员放得进来。
import { defineEventHandler, readBody, createError } from 'h3'
import { getDb } from '~~/server/utils/db-adapter'
import { requireSuperAdmin } from '~~/server/utils/auth-middleware'
import { reconcileUserBucketWithDb, userKeyPrefixes } from '~~/server/utils/bucket-admin'

export default defineEventHandler(async (event) => {

  await requireSuperAdmin(event)

  const body = await readBody(event).catch(() => ({} as any))
  const userId = Number(body?.userId)

  // 不猜 userId。少一层判空就等于「不传时对账 user 0」——
  // 而 reconcile 对 user 0 会列出空前缀、报「一切正常」，看起来像跑成功了。
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw createError({ statusCode: 400, message: '缺少合法的 userId' })
  }

  const db = getDb(event)
  const result = await reconcileUserBucketWithDb(db, userId)

  // 前缀列表也给回去，让页面下钻时不必自己拼（也就不会拼错第二段）
  return {
    ...result,
    prefixes: userKeyPrefixes(userId),
    minAgeMs: undefined
  }
})