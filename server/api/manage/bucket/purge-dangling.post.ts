// /api/manage/bucket/purge-dangling —— 删掉 files 表里有行、但 COS 里没有对象的那些行。
//
// ## 悬空行不是「没用的数据」，它正在让用户传不了东西
//
// `users.usedStorage` 的算法是 `SUM(file_size) FROM files WHERE user_id = ?`
// （sub-account.ts:313）。也就是说**一个对象已经没了的行，仍然占着那一份配额**：
//
//     用户界面里文件还在（点开 404）
//     COS 里的字节已经不在了
//     但配额被这一行占着
//     → 用户想再传一点，传不进去，提示「空间不足」
//
// 删掉悬空行不只是清理，它是**唯一能把配额还回去的办法** —— 而在没有这个页面
// 之前，没有任何人能找出这些行。这是这个功能最实际的用途，比省空间重要得多。
//
// 所以删完**必须重算**。漏了重算的话行没了、配额数字没变，用户依然传不进，
// 而且比删之前更难查（行已经没了，看不见原因）。
//
// ## 为什么 DELETE 与审计 INSERT 同一个 SAVEPOINT
//
// 与孤儿删除不同，这里两步都在本地数据库里，可以真正原子。
// 项目里的既定写法见 copy/paste.post.ts（每项一个 SAVEPOINT）与
// folders.ts（ensure_paths_tx）。
//
// SAVEPOINT 区间里**不抛不早退**：统一在 finally 里 RELEASE / ROLLBACK TO，
// 并用 settled 标志判断是否已经收口。区间内 `return` 会把 SAVEPOINT 留在
// 开启状态，之后所有语句都被卷进这个事务 —— 那是 paste 那次踩过的坑。
import { defineEventHandler, readBody, createError } from 'h3'
import { getDb } from '~~/server/utils/db-adapter'
import { requireSuperAdmin } from '~~/server/utils/auth-middleware'
import { FileService } from '~~/server/utils/db'
import { recordPurge, loadUserFileRows, userKeyPrefixes } from '~~/server/utils/bucket-admin'

/** 单次最多删多少行。这批是本地 DELETE，比删 COS 快得多，但仍要有个上限 */
const MAX_ROWS_PER_REQUEST = 500

export default defineEventHandler(async (event) => {
  const me = await requireSuperAdmin(event)

  const body = await readBody(event).catch(() => ({} as any))
  const userId = Number(body?.userId)
  const ids: unknown = body?.ids

  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw createError({ statusCode: 400, message: '缺少合法的 userId' })
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    throw createError({ statusCode: 400, message: '请提供要删除的行 id 列表' })
  }
  if (ids.length > MAX_ROWS_PER_REQUEST) {
    throw createError({
      statusCode: 400,
      message: `单次最多删除 ${MAX_ROWS_PER_REQUEST} 行，本次 ${ids.length} 行`
    })
  }

  const numericIds = ids.map((n) => Number(n))
  if (numericIds.some((n) => !Number.isSafeInteger(n) || n <= 0)) {
    throw createError({ statusCode: 400, message: 'id 列表里含有非法值' })
  }

  const db = getDb(event)

  // ---- 复查：这些行现在还在、还是这个用户的吗 ----
  //
  // 不能只信 id。凭 id 删东西是最容易写出越权的形状：传一个别人的 file id
  // 过来，`DELETE FROM files WHERE id = ?` 会老老实实删掉它。所以条件里
  // 一定带 user_id —— 让「删错人」在 SQL 层就不可能，而不是靠上面那个 id 合法。
  const rows = await loadUserFileRows(db, userId)
  const byId = new Map(rows.map((r) => [r.id, r]))
  /**
   * **要的是行，不是 id。**
   *
   * 原来的写法 `numericIds.filter((id) => byId.has(id))` 留的是 id 数组，
   * 下面却当成行用（r.fileSize / r.filename…）。运行时的后果不是报错而是
   * 一批 `undefined`：审计快照的每个字段都是 undefined、freedBytes 算成 0。
   * 也就是说「删掉 200 行、释放配额」的提示会显示 0 字节，审计表里那 200 条
   * 记录全都答不出「删掉的到底是什么」—— 而那张表存在的全部意义就是回答这个。
   */
  const targets = numericIds
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
  const missing = numericIds.filter((id) => !byId.has(id))

  if (targets.length === 0) {
    throw createError({
      statusCode: 400,
      message: '没有可删除的行',
      data: { missing }
    })
  }

  // 顺手算一下释放的配额，展示给操作者 —— 悬空行占着配额是这个功能的主要卖点，
  // 让人看见「删完能多传多少」比一个「成功」有用得多。
  const freedBytes = targets.reduce((sum, r) => sum + (Number(r.fileSize) || 0), 0)

  // ---- 事务：DELETE + 审计一起 ----
  const placeholders = targets.map(() => '?').join(', ')
  let settled = false
  let deleted = 0

  await db.prepare('SAVEPOINT purge_dangling_tx').bind().run()
  try {
    const delRes: any = await db
      .prepare(`DELETE FROM files WHERE user_id = ? AND id IN (${placeholders})`)
      .bind(userId, ...targets.map((r) => r.id))
      .run()
    deleted = Number(delRes?.meta?.changes ?? targets.length)

    // 审计放在同一个 SAVEPOINT 里：要么都成，要么都没发生
    await db
      .prepare(
        `INSERT INTO bucket_purge_log (kind, user_id, count, bytes, actor_id, payload)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        'dangling-row',
        userId,
        targets.length,
        freedBytes,
        me.userId,
        JSON.stringify(
          targets.map((r) => ({
            id: r.id,
            fileKey: r.fileKey,
            filename: r.filename,
            folderId: r.folderId,
            fileSize: r.fileSize,
            createdAt: r.createdAt
          }))
        )
      )
      .run()

    await db.prepare('RELEASE purge_dangling_tx').bind().run()
    settled = true
  } catch (e: any) {
    // ROLLBACK TO 失败意味着事务状态已不可信，不能吞（bulk.post.ts 的同一判断）
    await db.prepare('ROLLBACK TO purge_dangling_tx').bind().run().catch((err: any) => {
      console.error('[bucket] ROLLBACK TO purge_dangling_tx 失败，事务状态不可信:', err)
    })
    settled = true
    console.error('[bucket] 删除悬空行失败，已回滚:', e?.message || e)
    throw createError({
      statusCode: 500,
      message: `删除失败，已回滚：${e?.message || e}`
    })
  } finally {
    // 区间内不早退，所以走到这里时 settled 一定已经是 true。
    // 留着这个判断是为了「万一将来有人在区间里加了 return」时会有声音，
    // 而不是留一个开着的 SAVEPOINT 把后面的语句全卷进来。
    if (!settled) {
      console.error('[bucket] purge_dangling_tx 区间未收口（不该发生）')
      await db.prepare('ROLLBACK TO purge_dangling_tx').bind().run().catch(() => {})
    }
  }

  // ---- 重算配额 ----
  //
  // 放在事务之外：它会顺带重算用户的**父账号**（resolveQuotaChain），
  // 那是两个用户各一行的写，混进上面那个事务没有额外好处，反而让它更长。
  //
  // 失败不抛：行已经删掉了、审计也已经记下了。此时抛错只会让操作者以为
  // 删除失败而重复点，而配额下一轮重算（任何一次 move/delete/paste）就修好了。
  let storageRecalculated = false
  try {
    await new FileService(db).recalculateUsedStorage(userId)
    storageRecalculated = true
  } catch (e: any) {
    console.error('[bucket] 重算 usedStorage 失败（行已删除，配额下一轮会修正）:', e?.message || e)
  }

  return {
    deleted,
    freedBytes,
    storageRecalculated,
    missing,
    prefixes: userKeyPrefixes(userId)
  }
})