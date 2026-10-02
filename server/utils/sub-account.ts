// 子账户的配额链：子账户花的是主账号的池，但账要分开记。
//
// ## 模型
//
//   主账号 P（自己的池 = P 自己的 maxStorage/maxDownload）
//     └─ 子账户 C（分到的上限 = C 自己的 maxStorage/maxDownload）
//
// 只允许**一层**（accounts/index.post.ts 校验 parent_id 的 parent_id 为 NULL），
// 所以链长恒为 2，重算恒为 2 行，不需要递归 CTE。
//
// ## 为什么主账号行只记「自己那份」
//
// 直觉写法是预占时同时改两行。但那样必须拆成两条语句 + 补偿回滚，中间有个
// 窗口会让计数偏高、误拒并发请求；而且删掉一个子账户时还得手工退额。
//
// 改成：P 行的 usedStorage/usedDownload **只记 P 自己名下的文件**，
// 子账户的一律实时 SUM。于是：
//
//   - 预占是一条原子 UPDATE 里的两个条件（见 reserveStorage / reserveDownload）
//   - 删子账户自动退额 —— 池永远是实时 SUM，不需要任何反向记账
//   - 改 P 自己的上限，立刻对所有子账户生效
//
// 代价：每次预占要在池里 SUM 一次。走 ix_users_parent_id，池里最多
// maxSubAccount 行（0 = 不限时是管理员自己定的），可忽略。
//
// ## 判定顺序
//
// 每层各判各的：**先过期，再限额**。主账号过期 → 整条链冻住（子账户额度
// 还在，但一样用不了）；子账户自己过期 → 只冻它自己，不影响兄弟。
import { isExpired, nowSqlString } from '~~/server/utils/time'

/** 一次预占失败时的原因。用来选文案 —— 「过期」和「不够」要分开说。 */
export type QuotaFail = 'expired_self' | 'expired_parent' | 'storage_self' | 'storage_parent' | 'download_self' | 'download_parent'

export interface QuotaChain {
  /** 自己 */
  selfId: number
  /** 主账号 id；没有主账号时为 null（链长 1） */
  parentId: number | null
}

/**
 * 取一条配额链。**只查一层**：不递归，因为层数被建号接口卡死在一层。
 *
 * 为什么不递归：万一数据被外力写坏（parent_id 指来指去成环），
 * 递归就得带环检测，而那是一个本不该存在的状态。
 */
export async function resolveQuotaChain(db: any, userId: number): Promise<QuotaChain> {
  const row = await db
    .prepare('SELECT parent_id AS parentId FROM users WHERE id = ?')
    .bind(userId)
    .first()
  const parentId = row == null ? null : (row as any).parentId
  return { selfId: Number(userId), parentId: parentId == null ? null : Number(parentId) }
}

/**
 * 链上某一层是否已过期。主账号过期会冻住整条链。
 *
 * `isExpired` 对空白值返回 false，「没设过期时间」= 「没过期」。
 */
export async function chainExpired(db: any, chain: QuotaChain): Promise<{ self: boolean; parent: boolean }> {
  const ids = chain.parentId == null ? [chain.selfId] : [chain.selfId, chain.parentId]
  const rows = await db
    .prepare(`SELECT id, expire_at FROM users WHERE id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids)
    .all()
  const map = new Map<number, boolean>()
  for (const r of (rows?.results ?? []) as any[]) map.set(Number(r.id), isExpired(r.expire_at))
  return { self: map.get(chain.selfId) === true, parent: map.get(chain.parentId!) === true }
}

/**
 * 池的用量（主账号那一层）。
 *
 * 池里已用 = 主账号自己那份 + 所有子账户实时 SUM 出来的那份。
 * 与 reserve 里的 SQL 是同一个口径 —— 两边算得不一样就会出现
 * 「页面显示没满但传不上去」，那种 bug 已经吃过一次。
 */
export async function poolUsage(
  db: any,
  parentId: number,
  col: 'usedStorage' | 'usedDownload'
): Promise<{ self: number; children: number; total: number; max: number }> {
  const row = await db
    .prepare(`SELECT
        COALESCE(${col}, 0) AS selfUsed,
        COALESCE((SELECT SUM(COALESCE(${col}, 0)) FROM users WHERE parent_id = ?), 0) AS childUsed,
        COALESCE(max${col.slice(4)}, 0) AS maxVal
      FROM users WHERE id = ?`)
    .bind(parentId, parentId)
    .first()
  const self = Number((row as any)?.selfUsed ?? 0)
  const children = Number((row as any)?.childUsed ?? 0)
  const max = Number((row as any)?.maxVal ?? 0)
  return { self, children, total: self + children, max }
}

/**
 * 池的限额条件（预占语句内的一段）。
 *
 * 抽出来是因为它要同时出现在三处预占语句和预检里，而算错的后果是
 * 「显示还剩 X，实际传不进去」。
 *
 * 池内自己那份 + 所有子账户的实时 SUM + 本次。max<=0 表示不限。
 */
export function poolWithinSql(col: 'usedStorage' | 'usedDownload', bytesParam: string): string {
  return `
      COALESCE(p.${col}, 0)
        + COALESCE((SELECT SUM(COALESCE(c.${col}, 0)) FROM users c WHERE c.parent_id = p.id), 0)
        + ${bytesParam} <= COALESCE(p.max${col.slice(4)}, 0)`
}

/**
 * 「自己这一层够不够」：`max <= 0` 表示不限。
 *
 * ## 为什么抽出来
 *
 * reserveStorage 与 precheckStorage 必须给出**同一个答案** —— 预检说够、预占说
 * 不够，用户就白传了一遍字节；反过来则是放行了一个注定失败的请求。
 *
 * 原先两处各写一份 `COALESCE(s.maxStorage, 0) = 0 OR COALESCE(s.usedStorage, 0) + ? <= ...`，
 * 靠人记着同步。这里改成共用一个片段生成器：改一处，两处一起变。
 *
 * 这正是 upload/credentials.post.ts 出事的根因那一类问题 —— 判定条件散在各处、
 * 各写各的。这次把「新接口必须复用这些片段」写进 tests/quota-wiring.test.mjs。
 */
export function ownWithinSql(
  col: 'usedStorage' | 'usedDownload',
  prefix = '',
  bytesParam = '?'
): string {
  const p = prefix ? `${prefix}.` : ''
  const name = col.slice(4)
  return `(COALESCE(${p}max${name}, 0) = 0 OR COALESCE(${p}${col}, 0) + ${bytesParam} <= COALESCE(${p}max${name}, 0))`
}

/**
 * 「未过期」条件、指定列前缀的版本。
 *
 * 不做成 `NOT_EXPIRED_SQL.replace(...)` 那种拼法：那是把一段 SQL 当字符串
 * 模板改，改坏了编译期不报错，只在运行时的某条预占语句上炸。
 * 而预占失败的后果是「静默不扣额度」或「静默拒绝」，都不报错。
 */
export function notExpiredSql(prefix = ''): string {
  const c = prefix ? `${prefix}.expire_at` : 'expire_at'
  return `(TRIM(COALESCE(${c}, '')) = '' OR ${c} > ?)`
}

/**
 * 预占存储空间。返回 null = 成功，否则返回失败原因。
 *
 * **一条 UPDATE**，两个条件（自己的上限 + 池的上限）都是原子的。
 * 没有「先占池再占自己、失败退池」那种两段式，所以不需要补偿回滚，
 * 也就没有误拒并发请求的窗口。
 *
 * `delta` 可以是负数（覆盖上传释放空间），此时池的判定同样按负数算，
 * 于是「池本来就快满了，覆盖同大小文件」不会被误拒。
 */
export async function reserveStorage(
  db: any,
  chain: QuotaChain,
  bytes: number
): Promise<QuotaFail | null> {
  const now = nowSqlString()

  if (chain.parentId == null) {
    // 没有主账号：就是原来那条语句的语义
    const r = await db
      .prepare(`
        UPDATE users
        SET usedStorage = usedStorage + ?
        WHERE id = ?
          AND ${notExpiredSql()}
          AND ${ownWithinSql('usedStorage')}
      `)
      .bind(bytes, chain.selfId, now, bytes)
      .run()
    if (affected(r) > 0) return null

    // 0 行：可能是不够，**也可能只是过期**。
    //
    // 原来这里直接 `return 'storage_self'`，不查过期 —— 于是已过期的普通用户
    // 会被告知「存储空间不足」，让他去调额度，而真正的原因是账号到期了。
    // 有主账号的那条分支一直有 chainExpired 分流，只有这条漏了；
    // 是 precheckStorage 的一致性测试把它照出来的（预检说 expired_self、
    // 预占说 storage_self）。
    const exp = await chainExpired(db, chain)
    return exp.self ? 'expired_self' : 'storage_self'
  }

  const r = await db
    .prepare(`
      UPDATE users AS s
      SET usedStorage = COALESCE(s.usedStorage, 0) + ?
      WHERE s.id = ?
        AND ${notExpiredSql('s')}
        AND ${ownWithinSql('usedStorage', 's')}
        AND EXISTS (
          SELECT 1 FROM users p WHERE p.id = ?
            AND ${notExpiredSql('p')}
            AND (COALESCE(p.maxStorage, 0) = 0 OR ${poolWithinSql('usedStorage', '?')})
        )
    `)
    .bind(bytes, chain.selfId, now, bytes, chain.parentId, now, bytes)
    .run()

  if (affected(r) > 0) return null

  // 0 行：两个条件里至少一个不满足。查一次说清是哪��个 —— 用户看到
  // 「空间不足」去调主账号的池、而实际是自己的上限满了，是纯浪费。
  const exp = await chainExpired(db, chain)
  if (exp.self) return 'expired_self'
  if (exp.parent) return 'expired_parent'
  const st = await selfExceeds(db, chain, 'usedStorage', 'maxStorage', bytes)
  return st ? 'storage_self' : 'storage_parent'
}

/**
 * 预占下载流量。与 reserveStorage 同一套，只是列不同。
 *
 * 注意：下载额度记的是**文件属主**那条链（不是点下载的人）。分享链接的
 * 访客没有身份，记在他身上无从追责，所以记内容的属主 —— 子账户的文件
 * 被匿名访客下载时，扣的是「子账户的上限 + 主账号的池」。
 */
export async function reserveDownload(
  db: any,
  chain: QuotaChain,
  bytes: number
): Promise<QuotaFail | null> {
  const now = nowSqlString()

  if (chain.parentId == null) {
    const r = await db
      .prepare(`
        UPDATE users
        SET usedDownload = COALESCE(usedDownload, 0) + ?
        WHERE id = ?
          AND ${notExpiredSql()}
          AND (COALESCE(maxDownload, 0) <= 0 OR COALESCE(usedDownload, 0) + ? <= COALESCE(maxDownload, 0))
      `)
      .bind(bytes, chain.selfId, now, bytes)
      .run()
    return affected(r) > 0 ? null : 'download_self'
  }

  const r = await db
    .prepare(`
      UPDATE users AS s
      SET usedDownload = COALESCE(s.usedDownload, 0) + ?
      WHERE s.id = ?
        AND ${notExpiredSql('s')}
        AND (COALESCE(s.maxDownload, 0) <= 0 OR COALESCE(s.usedDownload, 0) + ? <= COALESCE(s.maxDownload, 0))
        AND EXISTS (
          SELECT 1 FROM users p WHERE p.id = ?
            AND ${notExpiredSql('p')}
            AND (COALESCE(p.maxDownload, 0) <= 0 OR ${poolWithinSql('usedDownload', '?')})
        )
    `)
    .bind(bytes, chain.selfId, now, bytes, chain.parentId, now, bytes)
    .run()

  if (affected(r) > 0) return null

  const exp = await chainExpired(db, chain)
  if (exp.self) return 'expired_self'
  if (exp.parent) return 'expired_parent'
  const ex = await selfExceeds(db, chain, 'usedDownload', 'maxDownload', bytes)
  return ex ? 'download_self' : 'download_parent'
}

export async function releaseDownload(db: any, chain: QuotaChain, bytes: number): Promise<void> {
  await db
    .prepare('UPDATE users SET usedDownload = COALESCE(usedDownload, 0) - ? WHERE id = ?')
    .bind(bytes, chain.selfId)
    .run()
}

/** 自己那一层会不会因为这次预占而超限 */
async function selfExceeds(
  db: any,
  chain: QuotaChain,
  usedCol: string,
  maxCol: string,
  bytes: number
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT COALESCE(${usedCol},0) AS u, COALESCE(${maxCol},0) AS m FROM users WHERE id = ?`)
    .bind(chain.selfId)
    .first()
  const u = Number((row as any)?.u ?? 0)
  const m = Number((row as any)?.m ?? 0)
  return m > 0 && u + bytes > m
}

function affected(r: any): number {
  return Number(r?.meta?.changes ?? r?.meta?.rowsAffected ?? r?.changes ?? 0)
}

/**
 * 重算一整条链的记账。
 *
 * 每层的 used 都是「**只算自己名下那些文件**」—— 这是 poolUsage 里
 * 「池 = 自己 + 实时 SUM 孩子」的前提，两处必须一致。
 *
 * 触发点（delete / move / paste 之后）是自愈：预占失败没退干净的账靠它纠正。
 */
export async function recalculateChainStorage(db: any, userId: number): Promise<void> {
  const { selfId, parentId } = await resolveQuotaChain(db, userId)

  const recalc = async (id: number) => {
    const row = await db
      .prepare('SELECT COALESCE(SUM(file_size), 0) AS totalSize FROM files WHERE user_id = ?')
      .bind(id)
      .first()
    await db
      .prepare('UPDATE users SET usedStorage = ? WHERE id = ?')
      .bind(Number((row as any)?.totalSize ?? 0), id)
      .run()
  }

  await recalc(selfId)
  if (parentId != null) await recalc(parentId)
}

/**
 * 预检存储：这次会超吗？返回原因，**不预占**。
 *
 * ## 存在的理由
 *
 * upload/credentials.post.ts 在发 STS 临时凭证之前要判断「够不够」。这个判断原先
 * 是它自己写的单行 `maxStorage > 0 && usedForCheck + size > maxStorage`，
 * 完全不看主账号池 —— 而子账户建号时 maxStorage 故意给 0（不限），于是
 * `maxStorage > 0` 恒为 false，**这层闸门对子账户等于不存在**。
 * 凭证照发 → COS 里真落字节 → /api/files/save 的 reserveStorage 才失败 →
 * 数据库没记录，桶里留一个用户看不见也删不掉的文件。
 *
 * ## 口径必须与 reserveStorage 一致
 *
 * 所以这里的 WHERE 用的是 reserveStorage 那几个**同样的片段生成器**
 * （notExpiredSql / ownWithinSql / poolWithinSql），不是另抄一份。
 * 两者分叉过一次，代价就是上面那个孤儿对象。
 *
 * ## 只是预检，不预占
 *
 * 真正的扣减永远发生在 save.post.ts 的 reserveStorage。这里挡掉的只是「注定失败」
 * 的那部分，避免白传一遍字节。**存在竞态窗口**（预检通过后、save 之前池可能被
 * 别人占满），那属于「save 时拒绝」，不是预检的锅。
 *
 * ## bytes 可以是负数
 *
 * 覆盖上传时传 `新大小 - 旧大小`（可能是负数），与 save.post.ts 里
 * reserveStorage 收到的是同一个值。两边口径一致，覆盖才不会一边放行一边拒绝。
 */
export async function precheckStorage(
  db: any,
  chain: QuotaChain,
  bytes: number
): Promise<{ allowed: boolean; fail: QuotaFail | null; used: number; max: number; unlimited: boolean }> {
  const exp = await chainExpired(db, chain)
  if (exp.self) return { allowed: false, fail: 'expired_self', used: 0, max: 0, unlimited: false }
  if (exp.parent) return { allowed: false, fail: 'expired_parent', used: 0, max: 0, unlimited: false }

  // 与 reserveStorage 的 WHERE 同构：有行 = 放行，无行 = 至少一个条件不满足
  const sql =
    chain.parentId == null
      ? `SELECT 1 AS ok FROM users
          WHERE id = ?
            AND ${notExpiredSql()}
            AND ${ownWithinSql('usedStorage')}`
      : `SELECT 1 AS ok FROM users s
          WHERE s.id = ?
            AND ${notExpiredSql('s')}
            AND ${ownWithinSql('usedStorage', 's')}
            AND EXISTS (
              SELECT 1 FROM users p WHERE p.id = ?
                AND ${notExpiredSql('p')}
                AND (COALESCE(p.maxStorage, 0) = 0 OR ${poolWithinSql('usedStorage', '?')})
            )`
  const now = nowSqlString()
  const args =
    chain.parentId == null
      ? [chain.selfId, now, bytes]
      : [chain.selfId, now, bytes, chain.parentId, now, bytes]
  const row = await db.prepare(sql).bind(...args).first()
  if (row) {
    const pool =
      chain.parentId != null
        ? await poolUsage(db, chain.parentId, 'usedStorage')
        : await ownUsage(db, chain.selfId, 'usedStorage')
    return {
      allowed: true,
      fail: null,
      used: pool.total,
      max: pool.max,
      unlimited: pool.max <= 0
    }
  }

  // 无行：说清是哪一层不够，别让用户去调错的那一层
  const own = await ownUsage(db, chain.selfId, 'usedStorage')
  if (own.max > 0 && own.total + bytes > own.max) {
    return { allowed: false, fail: 'storage_self', used: own.total, max: own.max, unlimited: false }
  }
  if (chain.parentId != null) {
    const pool = await poolUsage(db, chain.parentId, 'usedStorage')
    if (pool.max > 0 && pool.total + bytes > pool.max) {
      return {
        allowed: false,
        fail: 'storage_parent',
        used: pool.total,
        max: pool.max,
        unlimited: false
      }
    }
  }
  // 两个额度数字都够，却仍然无行 —— 只可能是过期（已在上面排除），
  // 或者有人并发改过额度。保守起见按自己这层不够报，让 save 去给最终答案。
  return { allowed: false, fail: 'storage_self', used: own.total, max: own.max, unlimited: false }
}

/** 单个账号自己那一行的 used / max。给预检的「放行后回填 used/max」用 */
async function ownUsage(db: any, userId: number, col: 'usedStorage' | 'usedDownload') {
  const row = await db
    .prepare(`SELECT COALESCE(${col}, 0) AS u, COALESCE(max${col.slice(4)}, 0) AS m FROM users WHERE id = ?`)
    .bind(userId)
    .first()
  return { total: Number((row as any)?.u ?? 0), max: Number((row as any)?.m ?? 0) }
}

/** 预检：这次会超吗？返回原因，不预占。用于 manifest 的 precheck。 */
export async function precheckDownload(
  db: any,
  chain: QuotaChain,
  bytes: number
): Promise<{ allowed: boolean; fail: QuotaFail | null; used: number; max: number; unlimited: boolean }> {
  const exp = await chainExpired(db, chain)
  if (exp.self) return { allowed: false, fail: 'expired_self', used: 0, max: 0, unlimited: false }
  if (exp.parent) return { allowed: false, fail: 'expired_parent', used: 0, max: 0, unlimited: false }

  const own = await db
    .prepare('SELECT COALESCE(usedDownload,0) AS u, COALESCE(maxDownload,0) AS m FROM users WHERE id = ?')
    .bind(chain.selfId)
    .first()
  const u = Number((own as any)?.u ?? 0)
  const m = Number((own as any)?.m ?? 0)
  if (m > 0 && u + bytes > m) {
    return { allowed: false, fail: 'download_self', used: u, max: m, unlimited: false }
  }

  if (chain.parentId != null) {
    const pool = await poolUsage(db, chain.parentId, 'usedDownload')
    if (pool.max > 0 && pool.total + bytes > pool.max) {
      return { allowed: false, fail: 'download_parent', used: pool.total, max: pool.max, unlimited: false }
    }
    return { allowed: true, fail: null, used: pool.total, max: pool.max, unlimited: pool.max <= 0 }
  }

  return { allowed: true, fail: null, used: u, max: m, unlimited: m <= 0 }
}
