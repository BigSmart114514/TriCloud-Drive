// /api/manage/bucket/purge-orphans —— 删若干个已确认的孤儿对象。
//
// ## 三道关卡，顺序不能换
//
//   1. requireSuperAdmin
//   2. 单个 key 数量上限（本次请求最多删多少个）
//   3. **逐个 key 复查**：命名空间必须属于该用户，且此刻仍无 files 行指向它
//
// 第 3 道里的第二半是重点：对账是几分钟前跑的，而用户完全可能在这期间
// 完成了一次上传 —— 于是那个「孤儿」此刻已经有行了。只信快照就等于
// 删掉一个刚上传成功的文件。所以这里重新读一次 files 表再判。
//
// 命名空间那半则是结构性的：它让跨用户删除**不可能发生**，而不是
// 「页面上禁掉了按钮」。页面可以被绕过，守卫不会。
import { defineEventHandler, readBody, createError } from 'h3'
import { getDb } from '~~/server/utils/db-adapter'
import { requireSuperAdmin } from '~~/server/utils/auth-middleware'
import { deleteCosObjects } from '~~/server/utils/cos'
import { cosConfigured } from '~~/server/utils/cos'
import {
  recheckPurgeableKeys,
  recordPurge,
  loadUserFileRows,
  userKeyPrefixes
} from '~~/server/utils/bucket-admin'

/** 单次最多删多少个。逐个调 deleteObject（不批量）已经够慢了，别让一次点错删掉十万个 */
const MAX_KEYS_PER_REQUEST = 200

export default defineEventHandler(async (event) => {
  const me = await requireSuperAdmin(event)

  const body = await readBody(event).catch(() => ({} as any))
  const userId = Number(body?.userId)
  const keys: unknown = body?.keys

  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw createError({ statusCode: 400, message: '缺少合法的 userId' })
  }
  if (!Array.isArray(keys) || keys.length === 0) {
    throw createError({ statusCode: 400, message: '请提供要删除的 key 列表' })
  }
  if (keys.length > MAX_KEYS_PER_REQUEST) {
    throw createError({
      statusCode: 400,
      message: `单次最多删除 ${MAX_KEYS_PER_REQUEST} 个对象，本次 ${keys.length} 个`
    })
  }

  // 没配 COS 密钥时 deleteCosObject 会对每个 key 返回 false，日志刷一片却什么都没删。
  // 这里提前拒掉并说清原因，别让人以为删成功了。
  if (!cosConfigured()) {
    throw createError({
      statusCode: 400,
      message: '未配置腾讯云密钥，无法操作存储桶'
    })
  }

  const db = getDb(event)

  // ---- 第 3 道：复查 ----
  const { ok, rejected } = await recheckPurgeableKeys(db, userId, keys as string[])
  if (ok.length === 0) {
    throw createError({
      statusCode: 400,
      message: '没有可删除的对象',
      data: { rejected }
    })
  }

  // ---- 审计先落库 ----
  //
  // 顺序是刻意的：COS 删除调不回来，本地 INSERT 是唯一能留下记录的一步。
  // 先记「打算删这些」再去删。反过来的话，COS 删成功而进程在写审计前
  // 被 SIGKILL，就留下一次无记录的真删除 —— 那正是这张表要防的。
  let rowsForSize: Array<{ fileKey: string; fileSize: number }> = []
  try {
    rowsForSize = await loadUserFileRows(db, userId)
  } catch {
    // 读不到也不影响删除：对象在 COS 上，字节数可以从别处补。
    // 这里留空，审计里 bytes 可能为 0，比整个流程失败要好。
  }

  await recordPurge(db, {
    kind: 'orphan-object',
    userId,
    actorId: me.userId,
    count: ok.length,
    bytes: 0,
    entries: ok.map((k) => ({ key: k }))
  })

  // ---- 真删 ----
  const { ok: deleted, failed } = await deleteCosObjects(ok)

  return {
    deleted: deleted.length,
    failed: failed.length,
    failedKeys: failed,
    rejected,
    prefixes: userKeyPrefixes(userId)
  }
})