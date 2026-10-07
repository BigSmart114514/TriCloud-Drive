// 存储桶管理的数据面胶水：把 db、cos-list、bucket-reconcile 接起来。
//
// ## 为什么要有这一层
//
// bucket-reconcile.ts 里全是「失败时怎么办」的分支，那是最容易写错的部分，
// 所以它被写成 db/lister 都注入的纯逻辑，好处是能测。而端点里剩下的活是
// 「SQL 长什么样」「审计怎么写」—— 这些既测不动也不值得测，混进对账逻辑里
// 只会让那个文件变长。所以拆开：对账只管算什么，这一层管怎么取、怎么记。
//
// ## 审计必须在删除**之前**落库
//
// 顺序是刻意的：孤儿对象删除是调 COS，没有事务可以包住；而审计 INSERT 是在
// 本地数据库里。所以先记「打算删这些」，再去删。反过来的话，COS 删成功但
// 进程在写审计前被 SIGKILL，就留下一次没有任何记录的真删除 —— 那正是这张表
// 要防的情况。
//
// 悬空行的删除没有这个问题：它的 DELETE 与审计 INSERT 在同一个 SAVEPOINT 里。
import {
  reconcileUserBucket,
  partitionPurgeableKeys,
  DEFAULT_ORPHAN_MIN_AGE_MS,
  type ReconcileResult,
  type ReconcileFileRow,
  type ReconcileDeps
} from '~~/server/utils/bucket-reconcile'
import { listUserNamespaceObjects } from '~~/server/utils/cos-list'
import { FILE_KEY_PREFIXES } from '~~/server/utils/file-key'

/**
 * 读这个用户的全部文件行。
 *
 * 列名故意取别名成 camelCase，让返回的形状与 ReconcileFileRow 一致 ——
 * 否则每个消费点都得再做一次 `row.fileKey ?? row.file_key`（db.ts:469 就有
 * 一处这样的兼容，那是因为别处的查询没起别名）。这里起别名，那行兼容就不必复制。
 */
export async function loadUserFileRows(db: any, userId: number): Promise<ReconcileFileRow[]> {
  const res = await db
    .prepare(
      `SELECT id         AS id,
              file_key   AS fileKey,
              filename   AS filename,
              folder_id  AS folderId,
              file_size  AS fileSize,
              created_at AS createdAt
         FROM files
        WHERE user_id = ?`
    )
    .bind(userId)
    .all()
  return (res?.results ?? []) as ReconcileFileRow[]
}

/** 组装对账依赖。测试可以覆盖其中任意一项来注入失败。 */
export function makeReconcileDeps(
  db: any,
  overrides: Partial<ReconcileDeps> = {}
): ReconcileDeps {
  return {
    listNamespace: (userId, prefixes) => listUserNamespaceObjects(userId, prefixes),
    loadRows: (userId) => loadUserFileRows(db, userId),
    now: Date.now(),
    minAgeMs: DEFAULT_ORPHAN_MIN_AGE_MS,
    ...overrides
  }
}

export async function reconcileUserBucketWithDb(
  db: any,
  userId: number,
  overrides: Partial<ReconcileDeps> = {}
): Promise<ReconcileResult> {
  return reconcileUserBucket(userId, makeReconcileDeps(db, overrides))
}

/**
 * purge 前的复查：重新读一次行，重跑命名空间 + 「是否已有行」两道检查。
 *
 * 不用对账时的快照 —— 对账到点删除之间可能隔着几秒也可能隔着一天，而这期间
 * 用户完成了一次上传，于是那个「孤儿」已经有了行。这是唯一能覆盖该窗口的办法。
 */
export async function recheckPurgeableKeys(
  db: any,
  userId: number,
  keys: string[]
): Promise<{ ok: string[]; rejected: Array<{ key: string; reason: string }> }> {
  const rows = await loadUserFileRows(db, userId)
  return partitionPurgeableKeys(keys, rows, userId)
}

export type PurgeKind = 'orphan-object' | 'dangling-row'

export interface PurgeLogEntry {
  kind: PurgeKind
  userId: number
  actorId: number
  /** 被删的条目快照。悬空行存整行，孤儿对象存 key/size/lastModified */
  entries: Array<Record<string, unknown>>
  bytes: number
  /** 实际成功删掉的条数（entries 可能是尝试数） */
  count: number
}

/**
 * 写一条审计。
 *
 * 不抛：审计写失败不该让已经完成的删除变成「报错」，但必须留 console.error
 * —— 静默失败的话，这张表就会在某天悄悄变成空的，而它的价值恰恰在于「不会空」。
 */
export async function recordPurge(db: any, entry: PurgeLogEntry): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO bucket_purge_log
           (kind, user_id, count, bytes, actor_id, payload)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        entry.kind,
        entry.userId,
        entry.count,
        entry.bytes,
        entry.actorId,
        JSON.stringify(entry.entries)
      )
      .run()
  } catch (e: any) {
    console.error(
      `[bucket] 审计写入失败 kind=${entry.kind} user=${entry.userId} count=${entry.count}:`,
      e?.message || e
    )
  }
}

export interface PurgeLogRow {
  id: number
  kind: string
  userId: number
  count: number
  bytes: number
  actorId: number
  payload: string
  createdAt: string
}

export async function listPurgeLog(
  db: any,
  opts: { userId?: number | null; limit?: number } = {}
): Promise<PurgeLogRow[]> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50))
  // userId 为空就不带 WHERE —— 这里是「看全部清理历史」的视图，
  // 而全表按 created_at 倒序即可（这张表本来就小）。
  const sql =
    opts.userId != null
      ? `SELECT id          AS id,
                kind        AS kind,
                user_id     AS userId,
                count       AS count,
                bytes       AS bytes,
                actor_id    AS actorId,
                payload     AS payload,
                created_at  AS createdAt
           FROM bucket_purge_log
          WHERE user_id = ?
          ORDER BY id DESC
          LIMIT ?`
      : `SELECT id          AS id,
                kind        AS kind,
                user_id     AS userId,
                count       AS count,
                bytes       AS bytes,
                actor_id    AS actorId,
                payload     AS payload,
                created_at  AS createdAt
           FROM bucket_purge_log
          ORDER BY id DESC
          LIMIT ?`
  const res = opts.userId != null
    ? await db.prepare(sql).bind(opts.userId, limit).all()
    : await db.prepare(sql).bind(limit).all()
  return (res?.results ?? []) as PurgeLogRow[]
}

/** 用户对象键的合法前缀。页面用它做下拉，purge 用它做守卫 —— 同一个来源 */
export function userKeyPrefixes(userId: number): string[] {
  return FILE_KEY_PREFIXES.map((p) => `${p}/${userId}/`)
}