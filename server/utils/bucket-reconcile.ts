// 桶与数据库的对账：孤儿对象 / 悬空行。
//
// ## 它要回答的问题
//
// 数据库是权威界面，但**不是存储的权威**。上传分三步，中间那一步对象已经在桶里了
// 而行还不存在；进程被 SIGKILL 之后那一步永远不会执行。于是两个方向都会漂移：
//
//   孤儿对象  COS 有、files 表无 → 白占空间。用户看不见也删不掉。
//             仓库里有四处注释承认这件事：credentials.post.ts:110、
//             save.post.ts:105、paste.post.ts:332、purge-user.ts:6。
//             paste 那条写得很直白：「进程被 SIGKILL 时补偿不会执行 ——
//             那是孤儿对象对账的课题」，本文件就是那个课题的答案。
//
//   悬空行    files 表有、COS 无 → 用户在界面上看得见这个文件，点开 404。
//             之前**没有任何一个页面**能告诉管理员「这个用户的 3 号文件对象没了」。
//
// ## 为什么 db 与 lister 都注入
//
// 和 share-bulk-apply.ts、concurrency.ts 同一个理由：这个文件里最容易写错的
// 全是「失败时怎么办」，而那些分支必须能被真的执行到。注入假 db / 假 lister
// 就能把「DB 抛异常」「翻页中途断掉」这些分支跑一遍，而真机上它们一辈子未必发生一次。
//
// ## 三条不许越过的线
//
// 1. **DB 读失败 → 不产出任何孤儿。**
//    孤儿 = COS 键集 − DB 键集。DB 读失败时如果当成空集，差集就是**整个桶**，
//    而本项目的孤儿列表带删除按钮。所以这里把「读失败」和「这个用户一个文件
//    都没有」严格区分：前者返回 error 且两个列表都为空。
//
// 2. **列举不完整 → 悬空行整个不产出。**
//    悬空行 = DB 键集 − COS 键集。COS 侧只列到 1/40 时，这个差集里
//    绝大多数是**假的** —— 用户文件好好的，只是我们没翻到那一页。
//    报出来就是几百条「你的文件丢了」的假警报。
//
// 3. **列举不完整 → 孤儿全部标记为不可删。**
//    孤儿集合本身不会因为漏翻而变大（漏翻只会让 COS 键集更小），
//    但我们无法区分「列举真的穷尽了」与「列举坏了」。在分不清的时候按坏的算。
//
// ## 年龄下限为什么必须存在
//
// 孤儿无法与「正在上传」区分 —— 上传是 credentials → 客户端直传 COS → files/save，
// 第二步之后对象存在、行还不存在，中间没有任何标记能说明它在途。
// （本项目服务器不代理字节，所以服务端根本没有「上传中」这个状态。）
//
// 不设下限的话，管理员点一次删除就把用户正在传的那个文件当场删掉，且不可逆。
// 所以 `minAgeMs` 挡的是**删除**，不是**可见性**：太新的照样列出来，
// 只是标成 deletable: false —— 不然这个面板会对「桶里到底有什么」撒谎，
// 而如实说谎正是它唯一的价值。
import { FILE_KEY_PREFIXES, fileKeyOwnerId } from '~~/server/utils/file-key'

/** 24 小时。见文件头：这是「在途」与「废弃」唯一的可分辨信号 */
export const DEFAULT_ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000

export interface ReconcileFileRow {
  id: number
  fileKey: string
  filename: string
  folderId: number | null
  fileSize: number
  createdAt: string
}

export interface ReconcileOrphan {
  key: string
  size: number
  lastModified: string
  /** 距今毫秒。lastModified 解析不了时为 null —— 也就无从判定可否删除 */
  ageMs: number | null
  /** 未到年龄下限时为 false，页面据此禁用删除按钮 */
  deletable: boolean
}

export interface ReconcileDangling {
  id: number
  fileKey: string
  filename: string
  folderId: number | null
  fileSize: number
  createdAt: string
}

export interface ReconcileResult {
  userId: number
  orphans: ReconcileOrphan[]
  dangling: ReconcileDangling[]
  /** 没能覆盖全命名空间。见文件头第 2、3 条线 */
  incomplete: boolean
  /** 悬空行被压制的原因（列举不完整时非空） */
  danglingSuppressedReason?: string
  /** 人能读的失败原因 */
  error?: string
  /** COS 侧扫到的对象数 */
  scannedObjects: number
  /** DB 侧这个用户的行数 */
  scannedRows: number
  /**
   * 扫到了但形状对不上的两类。列出来而不是丢掉：
   * 「key 不在自己命名空间下」在正常情况下不可能出现，出现就说明 COS 那边
   * 有我们不了解的东西 —— 那正是需要人看一眼的东西。
   */
  foreignObjects: string[]
  foreignRows: Array<{ id: number; fileKey: string; ownerId: number | null }>
}

export interface ReconcileDeps {
  /** 扫一个用户的整个命名空间（两个前缀都扫） */
  listNamespace: (userId: number, prefixes: readonly string[]) => Promise<{
    objects: Array<{ key: string; size: number; lastModified: string }>
    incomplete: boolean
    error?: string
  }>
  /** 读这个用户的全部文件行。**抛异常必须被当成「读失败」，不是「零行」** */
  loadRows: (userId: number) => Promise<ReconcileFileRow[]>
  now: number
  minAgeMs: number
}

function emptyResult(userId: number, scannedObjects: number, scannedRows: number): ReconcileResult {
  return {
    userId,
    orphans: [],
    dangling: [],
    incomplete: false,
    scannedObjects,
    scannedRows,
    foreignObjects: [],
    foreignRows: []
  }
}

/**
 * 对账一个用户的存储。
 *
 * 不抛 —— 失败以 `error` + 空列表的形式返回。上层要能把这个结果原样显示给
 * 管理员（「列举失败」和「没有孤儿」是完全不同的两件事）。
 */
export async function reconcileUserBucket(
  userId: number,
  deps: ReconcileDeps
): Promise<ReconcileResult> {
  const prefixes = FILE_KEY_PREFIXES

  // ---- 先读 DB ----
  //
  // 放在列举之前不是为了快，而是为了让「DB 读失败」这个分支根本不去碰 COS：
  // 拿不到 DB 键集时，一次列举请求都没有意义。
  let rows: ReconcileFileRow[]
  try {
    rows = await deps.loadRows(userId)
  } catch (e: any) {
    // 线 1：这里必须返回**两个空列表**，而不是「COS 侧照常，DB 侧当空」。
    // 差集的方向决定了哪个错误最致命 —— 把 DB 当空集会把整个桶报成孤儿。
    return {
      ...emptyResult(userId, 0, 0),
      error: `读取该用户的文件记录失败：${e?.message || e}。未做任何比对 —— 此时若把空集当成「这个用户没有文件」，桶里每个对象都会被误报成孤儿。`
    }
  }

  const dbKeys = new Set<string>()
  const foreignRows: ReconcileResult['foreignRows'] = []
  // 属主对不上的行。它**不在** dbKeys 里 —— 放进���的话，它会同时出现在
  // 「孤儿判定」与「悬空判定」里：它指向的对象在别人的命名空间下，本次的
  // 列举根本看不到，于是被算成悬空，界面会说「用户 5 的这个文件丢了」——
  // 而那个文件其实在别人那儿好好的。
  for (const row of rows) {
    if (typeof row.fileKey !== 'string' || !row.fileKey) continue
    dbKeys.add(row.fileKey)
    // 行的属主解析不出来、或解析出来不是这个人 —— 历史上 file_key 是客户端
    // 原样传进来的（见 file-key.ts 的文件头），库里可能有重复行。
    // 报出来，不动。
    const owner = fileKeyOwnerId(row.fileKey)
    if (owner !== userId) {
      foreignRows.push({ id: row.id, fileKey: row.fileKey, ownerId: owner })
    }
  }

  // ---- 再列 COS ----
  const listing = await deps.listNamespace(userId, prefixes)

  // COS 侧认不出的对象（key 不在自己命名空间下）
  const ownPrefixes = prefixes.map((p) => `${p}/${userId}/`)
  const foreignObjects: string[] = []
  const cosKeys = new Set<string>()
  for (const obj of listing.objects) {
    if (!ownPrefixes.some((p) => obj.key.startsWith(p))) {
      foreignObjects.push(obj.key)
      continue
    }
    cosKeys.add(obj.key)
  }

  const base = emptyResult(userId, listing.objects.length, rows.length)
  const result: ReconcileResult = {
    ...base,
    incomplete: listing.incomplete,
    foreignObjects,
    foreignRows
  }
  if (listing.error) result.error = listing.error

  // ---- 孤儿 ----
  //
  // ageMs 算不出来（LastModified 缺失或格式不认识）时 ageMs: null、
  // deletable: false —— 「证明不了它够旧」就不许删，与「它很新」同等待遇。
  const listingComplete = !listing.incomplete
  for (const obj of listing.objects) {
    if (!cosKeys.has(obj.key)) continue // 已在 foreignObjects 里报过
    if (dbKeys.has(obj.key)) continue
    const parsed = Date.parse(obj.lastModified)
    const ageMs = Number.isFinite(parsed) ? Math.max(0, deps.now - parsed) : null
    result.orphans.push({
      key: obj.key,
      size: obj.size,
      lastModified: obj.lastModified,
      ageMs,
      deletable: listingComplete && ageMs !== null && ageMs >= deps.minAgeMs
    })
  }

  // ---- 悬空行 ----
  //
  // 线 2：列举不完整时整个不产出。漏翻的那 38/39 页面里的文件都会被算成
  // 「悬空」，报出来就是几百条「你的文件丢了」的假警报 —— 而管理员会当真，
  // 用户也会当真，然后拿着一条不存在的文件丢失来问。
  if (listing.incomplete) {
    result.danglingSuppressedReason =
      listing.error ||
      '列举未能覆盖整个命名空间，此时「数据库有、COS 无」无法与「只是没翻到」区分，故不产出悬空行'
  } else {
    for (const row of rows) {
      if (typeof row.fileKey !== 'string' || !row.fileKey) continue
      if (cosKeys.has(row.fileKey)) continue
      // 属主对不上的行（已在 foreignRows 报过）**不算悬空**。
      //
      // 它指向的对象在别人的命名空间下，本次列举根本看不到 —— 所以「COS 没有」
      // 这个观察对它是无效的，拿它推出「文件丢了」会当着用户的面说别人的文件
      // 不见了。这类行要么是历史脏数据，要么是当年 file_key 可被客户端伪造
      // 时留下的（file-key.ts 的文件头记着），但无论哪种都不是「这个用户的文件丢了」。
      if (fileKeyOwnerId(row.fileKey) !== userId) continue
      result.dangling.push({
        id: row.id,
        fileKey: row.fileKey,
        filename: row.filename,
        folderId: row.folderId,
        fileSize: row.fileSize,
        createdAt: row.createdAt
      })
    }
  }

  return result
}

/**
 * purge 前的最后一道：这些 key 现在还在吗、真的还没有 files 行指向它们吗。
 *
 * **不复用 reconcile 的结果。** 对账到点删除之间可能过了几秒，也可能过了
 * 一整天 —— 用户在这期间完成了一次上传，于是某个「孤儿」已经有了行。
 * 到点重新查一次是唯一能覆盖这个窗口的办法，代价是几条 SQL。
 */
export function partitionPurgeableKeys(
  keys: string[],
  rows: ReconcileFileRow[],
  userId: number
): { ok: string[]; rejected: Array<{ key: string; reason: string }> } {
  const nowRows = new Set(rows.map((r) => r.fileKey))
  const ok: string[] = []
  const rejected: Array<{ key: string; reason: string }> = []

  const ownPrefixes = FILE_KEY_PREFIXES.map((p) => `${p}/${userId}/`)

  for (const key of keys) {
    if (typeof key !== 'string' || !key) {
      rejected.push({ key: String(key), reason: '不是合法的 key' })
      continue
    }
    // 命名空间守卫。这条是结构性的：它让跨用户删除不可能发生，
    // 比在页面上禁用按钮可靠 —— 页面可以被绕过，守卫不会被。
    if (!ownPrefixes.some((p) => key.startsWith(p))) {
      rejected.push({
        key,
        reason: `不在用户 ${userId} 的命名空间下（必须是 ${ownPrefixes.join(' 或 ')} 开头）`
      })
      continue
    }
    // 路径穿越。
    //
    // startsWith('users/5/') 挡不住 `users/5/../../users/9/x.bin`：
    // 它确实以 `users/5/` 开头，而 fileKeyOwnerId 只看**前两段**，于是
    // 第 3 段之后的 `..` 完全不在它的视野里。
    //
    // COS 的 key 是扁平的字符串，服务端不会替我们解析 `..`，所以
    // `deleteObject('users/5/../../9/x')` 删的是一个**字面量**叫这个名字的对象
    // —— 也就是说真实危害有限。但这个守卫的存在意义是「让越权在结构上不可能」，
    // 而一个能被 `..` 绕过的前缀匹配恰好不算这种守卫：任何一层将来加上
    // 路径拼接、或者把 key 拿去构造 URL（buildCosUrl 就是 encodeURIComponent，
    // 编码后的 `..` 有些服务端会先解码再规范化），它就变成真的越权。
    // 拒掉比解释「其实没事」便宜。
    if (key.split('/').includes('..') || key.split('/').includes('.')) {
      rejected.push({ key, reason: 'key 含路径片段 . 或 ..，拒绝' })
      continue
    }
    // 行已经出现了 —— 到点复查
    if (nowRows.has(key)) {
      rejected.push({ key, reason: '已经有 files 行指向它了，不是孤儿' })
      continue
    }
    ok.push(key)
  }

  return { ok, rejected }
}