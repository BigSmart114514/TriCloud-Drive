// 子账户配额链的**真实函数**行为测试。
//
// ## 和 sub-accounts.test.mjs 的分工
//
//   sub-accounts.test.mjs      手抄 SQL + 源码结构断言（权限白名单、写死的列名）
//   本文件                    直接 import server/utils/sub-account.ts 调真函数
//
// 为什么要有本文件：手抄的那份测的是「抄对没有」，不是「发布的代码对没有」。
// 实际踩过 —— 把 poolWithinSql 里 `COALESCE(p.${col}, 0)`（池里主账号自己那一份）
// 删掉，手抄版与源码各跑各的，40 例全过，只能靠加一条源码字面量断言才拦住。
// 直接调真函数就没有这个缝隙：改源码，这里的行为断言立刻变红。
//
// 真函数靠 tests/helpers/register-nuxt-alias.mjs 的 resolve hook 挂上 ~~/ 别名，
// 靠 tests/helpers/adapter-db.mjs 把裸 sqlite3 句柄包成服务端 getDb() 的形状。
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

register(new URL('./helpers/resolve-nuxt-alias.mjs', import.meta.url), import.meta.url)

const { openAdapterDb } = await import('./helpers/adapter-db.mjs')
const {
  chainExpired,
  poolUsage,
  precheckDownload,
  recalculateChainStorage,
  releaseDownload,
  reserveDownload,
  reserveStorage,
  resolveQuotaChain
} = await import('../server/utils/sub-account.ts')
const { GATE_MESSAGES, checkNonNegative, requireOwnChild, subAccountGate } =
  await import('../server/utils/account.ts')

/* 主账号 950；孩子 951、952；被写坏的孙账号 953（parent 指向 951）；普通用户 949（无 parent） */
const BOSS = 950
const KID = 951
const SIB = 952
const GRAND = 953
const PLAIN = 949
const ALL = [BOSS, KID, SIB, GRAND, PLAIN]

const NOW = '2026-06-01 00:00:00'
const PAST = '2000-01-01 00:00:00'
const FUTURE = '2099-01-01 00:00:00'

let dir
let db

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'subacct-quota-'))
  const path = join(dir, 'test.sqlite')
  // 绝不碰开发库：复制到临时目录
  copyFileSync(new URL('../data.sqlite', import.meta.url).pathname, path)
  db = openAdapterDb(path)

  // 清掉开发库的数据，只留干净的 users 骨架。
  // **不删 users 全表** —— 留着原有的行无妨，但必须把它们的 parent_id 摆回 NULL，
  // 否则 poolUsage 的 SUM 会把开发库残留的父子关系算进来。
  await db.run('DELETE FROM folder_access')
  await db.run('DELETE FROM file_access')
  await db.run('DELETE FROM share_links')
  await db.run('DELETE FROM files')
  await db.run('DELETE FROM folders')

  // expire_at 必须显式给 NULL：users.expire_at 的**列默认**是 CURRENT_TIMESTAMP，
  // 也就是「建号那一刻」—— 不写就等于一建号就已过期，所有预占都被 NOT_EXPIRED_SQL 挡掉。
  for (const [id, name, parent] of [
    [BOSS, 'boss', null],
    [KID, 'kid', BOSS],
    [SIB, 'sib', BOSS],
    [GRAND, 'grand', KID],
    [PLAIN, 'plain', null]
  ]) {
    await db.run(
      `INSERT INTO users (id, username, email, password_hash, parent_id, expire_at, maxStorage, maxDownload, usedStorage, usedDownload)
       VALUES (?, ?, ?, 'x', ?, NULL, 0, 0, 0, 0)`,
      [id, name, `${name}@t.co`, parent]
    )
  }
})

after(async () => {
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  /**
   * 账号可能被上一个用例删掉（有好几例专门验「删掉就退额」/「删一个孩子就放行」）。
   * 所以这里**必须重建**而不是只 UPDATE —— 否则后面的用例静默失败：
   * 预占作用在一条不存在的行上，changes 恒为 0；或者计数少算一个。
   * 这个坑踩过一次：漏了重建，于是「数量上限」那组用例莫名其妙全放行。
   */
  for (const [id, name, parent] of [
    [BOSS, 'boss', null],
    [KID, 'kid', BOSS],
    [SIB, 'sib', BOSS],
    [GRAND, 'grand', KID],
    [PLAIN, 'plain', null]
  ]) {
    await db.run(
      `INSERT INTO users (id, username, email, password_hash, parent_id, expire_at, maxStorage, maxDownload, usedStorage, usedDownload)
       VALUES (?, ?, ?, 'x', ?, NULL, 0, 0, 0, 0)
       ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id`,
      [id, name, `${name}@t.co`, parent]
    )
  }
  // 把开发库残留行的父子关系也摆正，否则池的 SUM 会把它们算进来
  await db.run('UPDATE users SET parent_id = NULL WHERE parent_id IS NOT NULL')
  await db.run(
    'UPDATE users SET canSubAccount = 0, maxSubAccount = 0, maxStorage = 0, maxDownload = 0, usedStorage = 0, usedDownload = 0, expire_at = NULL WHERE id IN (?, ?, ?, ?, ?)',
    ALL
  )
  await db.run('UPDATE users SET parent_id = ? WHERE id IN (?, ?)', [BOSS, KID, SIB])
  await db.run('UPDATE users SET parent_id = ? WHERE id = ?', [KID, GRAND])
  await db.run('DELETE FROM files')
  await db.run('DELETE FROM folders')
})

/** 设额度。约定：池 = 1000，孩子分到 400 */
async function setLimits(id, o = {}) {
  const {
    maxStorage = 0, maxDownload = 0,
    usedStorage = 0, usedDownload = 0,
    expire = null, canSub = 0, maxSub = 0
  } = o
  await db.run(
    `UPDATE users SET maxStorage = ?, maxDownload = ?, usedStorage = ?, usedDownload = ?,
            expire_at = ?, canSubAccount = ?, maxSubAccount = ? WHERE id = ?`,
    [maxStorage, maxDownload, usedStorage, usedDownload, expire, canSub, maxSub, id]
  )
}

const col = async (id, c) => Number((await db.get(`SELECT ${c} AS v FROM users WHERE id = ?`, [id]))?.v ?? 0)

/** 造一条文件。size 是字节。 */
async function addFile(userId, size, tag = 'f') {
  const folderId = 7000 + userId
  await db.run(
    `INSERT INTO folders (id, user_id, name, parent_id, Shared, IsPublic) VALUES (?, ?, ?, NULL, 2, 0)
     ON CONFLICT(id) DO NOTHING`,
    [folderId, userId, `d${userId}`]
  )
  const id = 9000 + userId * 10 + Math.floor(size % 10)
  await db.run(
    `INSERT INTO files (id, user_id, folder_id, filename, file_key, file_size, file_url, content_type)
     VALUES (?, ?, ?, ?, ?, ?, '', 'application/octet-stream')
     ON CONFLICT(id) DO UPDATE SET file_size = excluded.file_size`,
    [id, userId, folderId, `${tag}.bin`, `k/${userId}/${tag}`, size]
  )
  return id
}

/* ------------------------------------------------------------------ */

describe('resolveQuotaChain：链长恒为 2', () => {
  test('子账户 → parentId 指向主账号', async () => {
    assert.deepEqual(await resolveQuotaChain(db, KID), { selfId: KID, parentId: BOSS })
  })

  test('普通用户 → parentId 为 null（链长 1，走改动前那条语句）', async () => {
    assert.deepEqual(await resolveQuotaChain(db, PLAIN), { selfId: PLAIN, parentId: null })
  })

  test('只取一层：孙账号的 parent 是孩子，不会被解析到主账号', async () => {
    // 这是整个设计的地基：链长恒为 2，重算恒为 2 行，不需要递归 CTE。
    // 万一数据被外力写成三层（这里就是），这里**仍然只取一层** ——
    // 递归就得带环检测，而那是一个本不该存在的状态。
    assert.deepEqual(await resolveQuotaChain(db, GRAND), { selfId: GRAND, parentId: KID })
  })

  test('账号不存在 → parentId 为 null（后续预占自然 0 行）', async () => {
    assert.deepEqual(await resolveQuotaChain(db, 9999), { selfId: 9999, parentId: null })
  })
})

describe('chainExpired：每层各判各的', () => {
  test('自己过期 → 只有 self 为 true', async () => {
    await setLimits(BOSS, { expire: null })
    await setLimits(KID, { expire: PAST })
    assert.deepEqual(await chainExpired(db, { selfId: KID, parentId: BOSS }), { self: true, parent: false })
  })

  test('主账号过期 → 只有 parent 为 true（整条池因此冻住）', async () => {
    await setLimits(BOSS, { expire: PAST })
    await setLimits(KID, { expire: null })
    assert.deepEqual(await chainExpired(db, { selfId: KID, parentId: BOSS }), { self: false, parent: true })
  })

  test('兄弟过期与我无关（只查自己这两层）', async () => {
    await setLimits(BOSS, { expire: null })
    await setLimits(KID, { expire: null })
    await setLimits(SIB, { expire: PAST })
    assert.deepEqual(await chainExpired(db, { selfId: KID, parentId: BOSS }), { self: false, parent: false })
  })

  test('没设过期时间 = 没过期（空值放行）', async () => {
    await setLimits(BOSS, { expire: null })
    await setLimits(KID, { expire: null })
    assert.deepEqual(await chainExpired(db, { selfId: KID, parentId: BOSS }), { self: false, parent: false })
  })

  test('未来时间 = 没过期', async () => {
    await setLimits(BOSS, { expire: FUTURE })
    assert.equal((await chainExpired(db, { selfId: KID, parentId: BOSS })).parent, false)
  })

  test('链长 1 时 parent 恒为 false（不会去查一个不存在的第二层）', async () => {
    await setLimits(PLAIN, { expire: PAST })
    assert.deepEqual(await chainExpired(db, { selfId: PLAIN, parentId: null }), { self: true, parent: false })
  })
})

describe('reserveStorage：一条 UPDATE 里的两个条件', () => {
  test('成功：只记自己那行，主账号那行一个字都不写', async () => {
    await setLimits(BOSS, { maxStorage: 1000 })
    await setLimits(KID, { maxStorage: 400 })
    const chain = await resolveQuotaChain(db, KID)

    assert.equal(await reserveStorage(db, chain, 300), null)
    assert.equal(await col(KID, 'usedStorage'), 300)
    assert.equal(await col(BOSS, 'usedStorage'), 0, '主账号的 usedStorage 必须保持 0')
  })

  test('撞自己的上限 → storage_self（主账号点名不该出现）', async () => {
    await setLimits(BOSS, { maxStorage: 1000 })
    await setLimits(KID, { maxStorage: 400 })
    const chain = await resolveQuotaChain(db, KID)

    assert.equal(await reserveStorage(db, chain, 500), 'storage_self')
    assert.equal(await col(KID, 'usedStorage'), 0, '失败时不能扣任何字节')
  })

  test('撞池（自己不限，兄弟已吃 800 / 池 1000）→ storage_parent', async () => {
    await setLimits(BOSS, { maxStorage: 1000 })
    await setLimits(KID, { maxStorage: 0 })
    await setLimits(SIB, { usedStorage: 800 })
    const chain = await resolveQuotaChain(db, KID)

    assert.equal(await reserveStorage(db, chain, 300), 'storage_parent')
    assert.equal(await reserveStorage(db, chain, 200), null, '刚好用完应该放行')
    assert.equal(await col(KID, 'usedStorage'), 200)
  })

  test('池里算的是「主账号自己 + 所有孩子」，不含孩子之外的人', async () => {
    await setLimits(BOSS, { maxStorage: 1000, usedStorage: 600 })
    await setLimits(KID, { maxStorage: 0 })
    const chain = await resolveQuotaChain(db, KID)

    // 600 + 0 + 400 = 1000，刚好
    assert.equal(await reserveStorage(db, chain, 400), null)
    // 再来 1 就超了
    assert.equal(await reserveStorage(db, chain, 1), 'storage_parent')
  })

  test('主账号过期 → expired_parent（不是「额度不足」）', async () => {
    await setLimits(BOSS, { maxStorage: 0, expire: PAST })
    await setLimits(KID, { maxStorage: 0 })
    const chain = await resolveQuotaChain(db, KID)

    assert.equal(await reserveStorage(db, chain, 1), 'expired_parent')
  })

  test('自己过期 → expired_self', async () => {
    await setLimits(BOSS, { maxStorage: 0, expire: null })
    await setLimits(KID, { maxStorage: 0, expire: PAST })
    const chain = await resolveQuotaChain(db, KID)

    assert.equal(await reserveStorage(db, chain, 1), 'expired_self')
  })

  test('过期优先于额度：两个都不够时报 expired 而不是 storage', async () => {
    // 用户看到「空间不足」会去调限额，而过期要做的续费。顺序反了就白折腾。
    await setLimits(BOSS, { maxStorage: 1, expire: PAST })
    await setLimits(KID, { maxStorage: 1, expire: PAST })
    const chain = await resolveQuotaChain(db, KID)

    assert.equal(await reserveStorage(db, chain, 9999), 'expired_self')
  })

  test('主账号不存在 → 挡下（EXISTS 不成立），不是静默放行', async () => {
    await setLimits(KID, { maxStorage: 0 })
    // 手工造一条指向虚空的链。诊断成 storage_parent 而不是 storage_self ——
    // 自己那层不限额所以确实没过在**池**上，报「自己的上限满了」才是误导。
    assert.equal(await reserveStorage(db, { selfId: KID, parentId: 9999 }, 1), 'storage_parent')
  })

  test('链长 1 时语义与改动前一致（无限额就随便扣）', async () => {
    await setLimits(PLAIN, { maxStorage: 0, expire: null })
    const chain = await resolveQuotaChain(db, PLAIN)

    assert.equal(await reserveStorage(db, chain, 12345), null)
    assert.equal(await col(PLAIN, 'usedStorage'), 12345)
  })

  test('链长 1 + 超额 → storage_self', async () => {
    await setLimits(PLAIN, { maxStorage: 100, expire: null })
    const chain = await resolveQuotaChain(db, PLAIN)

    assert.equal(await reserveStorage(db, chain, 101), 'storage_self')
  })
})

describe('reserveStorage：负 delta（覆盖上传变小）不能被池误拒', () => {
  /**
   * 覆盖上传的 delta 可以是负数（覆盖更小的文件会释放容量）。
   *
   * 这是最容易写错的一处：若池的判定忽略符号、或对 delta 取绝对值，
   * 就会出现「池本来快满了，**缩小**一个文件却被拒」——
   * 用户看到的是「空间不足」，而他明明在减少占用。
   * 而 users 表默认 maxStorage = 1（也就是 1 字节），这类账号默认就撞上。
   */
  test('池剩 100、自己已用满 400 → 覆盖成 -300 应该放行', async () => {
    await setLimits(BOSS, { maxStorage: 1000, usedStorage: 900 })
    await setLimits(KID, { maxStorage: 400, usedStorage: 400 })
    const chain = await resolveQuotaChain(db, KID)

    assert.equal(await reserveStorage(db, chain, -300), null)
    assert.equal(await col(KID, 'usedStorage'), 100)
  })

  test('池已经超了（历史漂移）→ 覆盖变小仍应放行，否则永远补不回来', async () => {
    await setLimits(BOSS, { maxStorage: 1000, usedStorage: 1400 })
    await setLimits(KID, { maxStorage: 0, usedStorage: 300 })
    const chain = await resolveQuotaChain(db, KID)

    // 1400 + 300 - 800 = 900 ≤ 1000 → 放行
    assert.equal(await reserveStorage(db, chain, -800), null)
  })

  test('负 delta 也不能突破池的上限（缩小到负数之下不行）', async () => {
    // 这一条防的是另一个方向的错：把 delta 换成绝对值就会在这里露馅
    await setLimits(BOSS, { maxStorage: 1000 })
    await setLimits(KID, { maxStorage: 0, usedStorage: 900 })
    const chain = await resolveQuotaChain(db, KID)

    // 0 + 900 - 900 = 0 ≤ 1000 → 放行，且不该把 usedStorage 压成负数
    assert.equal(await reserveStorage(db, chain, -900), null)
    assert.equal(await col(KID, 'usedStorage'), 0)
  })
})

describe('reserveDownload：下载那条', () => {
  test('成功只记自己那行', async () => {
    await setLimits(BOSS, { maxDownload: 1000 })
    await setLimits(KID, { maxDownload: 400 })
    const chain = await resolveQuotaChain(db, KID)

    assert.equal(await reserveDownload(db, chain, 300), null)
    assert.equal(await col(KID, 'usedDownload'), 300)
    assert.equal(await col(BOSS, 'usedDownload'), 0)
  })

  test('撞自己的上限 → download_self', async () => {
    await setLimits(BOSS, { maxDownload: 1000 })
    await setLimits(KID, { maxDownload: 400 })
    const chain = await resolveQuotaChain(db, KID)

    assert.equal(await reserveDownload(db, chain, 401), 'download_self')
  })

  test('撞池 → download_parent', async () => {
    await setLimits(BOSS, { maxDownload: 1000 })
    await setLimits(KID, { maxDownload: 0 })
    await setLimits(SIB, { usedDownload: 900 })
    const chain = await resolveQuotaChain(db, KID)

    assert.equal(await reserveDownload(db, chain, 200), 'download_parent')
  })

  test('maxDownload <= 0 = 不限，但仍累计（与既有口径一致）', async () => {
    await setLimits(BOSS, { maxDownload: 0 })
    await setLimits(KID, { maxDownload: 0 })
    const chain = await resolveQuotaChain(db, KID)

    assert.equal(await reserveDownload(db, chain, 999999), null)
    assert.equal(await col(KID, 'usedDownload'), 999999, '不限 ≠ 不记账')
  })

  test('存储与下载两条互不干扰', async () => {
    await setLimits(BOSS, { maxStorage: 1000, maxDownload: 1000 })
    await setLimits(KID, { maxStorage: 400, maxDownload: 400 })
    const chain = await resolveQuotaChain(db, KID)

    assert.equal(await reserveDownload(db, chain, 400), null)
    assert.equal(await reserveStorage(db, chain, 400), null, '下载满了不该挡住存储')
    assert.equal(await col(KID, 'usedDownload'), 400)
    assert.equal(await col(KID, 'usedStorage'), 400)
  })
})

describe('precheckDownload 与 reserveDownload 必须同口径', () => {
  /**
   * 这一组是防漂移的核心。
   *
   * 整包下载的预检说「不会超」、点下去第一份文件就 403 —— 那个 bug 吃过一次。
   * 根因是预检与预占是两套独立判定，任一处改了另一处没跟上。
   *
   * 现在两边都来自 sub-account.ts，所以这里跑矩阵：**对每种组合，
   * precheck.allowed 必须与「真去 reserve 会不会失败」完全一致。**
   */
  const CASES = [
    { name: '池 1000 / 自己 400 / 都空 → 300 放行', b: { maxDownload: 1000 }, k: { maxDownload: 400 }, bytes: 300, ok: true },
    { name: '自己刚好 400 → 400 放行', b: { maxDownload: 1000 }, k: { maxDownload: 400 }, bytes: 400, ok: true },
    { name: '自己差 1 字节 → 401 挡', b: { maxDownload: 1000 }, k: { maxDownload: 400 }, bytes: 401, ok: false },
    { name: '自己不限 / 池 1000 / 兄弟吃 900 → 100 挡', b: { maxDownload: 1000 }, k: { maxDownload: 0 }, s: { usedDownload: 900 }, bytes: 200, ok: false },
    { name: '自己不限 / 池 1000 / 兄弟吃 900 → 刚好 100 放行', b: { maxDownload: 1000 }, k: { maxDownload: 0 }, s: { usedDownload: 900 }, bytes: 100, ok: true },
    { name: '自己也不限 / 池也不限 → 随便放行', b: { maxDownload: 0 }, k: { maxDownload: 0 }, bytes: 999999999, ok: true },
    { name: '自己过期 → 挡', b: { maxDownload: 0 }, k: { maxDownload: 0, expire: PAST }, bytes: 1, ok: false },
    { name: '主账号过期 → 挡', b: { maxDownload: 0, expire: PAST }, k: { maxDownload: 0 }, bytes: 1, ok: false }
  ]

  for (const c of CASES) {
    test(c.name, async () => {
      await setLimits(BOSS, c.b)
      await setLimits(KID, c.k)
      await setLimits(SIB, c.s || {})
      const chain = await resolveQuotaChain(db, KID)

      const pre = await precheckDownload(db, chain, c.bytes)
      assert.equal(pre.allowed, c.ok, `预检判定错了：${JSON.stringify(pre)}`)

      // 真去预占，结论必须一致
      const actual = await reserveDownload(db, chain, c.bytes)
      assert.equal(actual === null, c.ok, `预占与预检不一致：预检 ${pre.allowed}，预占失败原因 ${actual}`)
    })
  }

  test('预检**不**预占（跑完所有计数都不变）', async () => {
    await setLimits(BOSS, { maxDownload: 1000 })
    await setLimits(KID, { maxDownload: 400 })
    const chain = await resolveQuotaChain(db, KID)

    const before = [await col(KID, 'usedDownload'), await col(BOSS, 'usedDownload')]
    await precheckDownload(db, chain, 300)
    const after = [await col(KID, 'usedDownload'), await col(BOSS, 'usedDownload')]

    assert.deepEqual(after, before, '预检只是「会不会超」，不该动账')
  })

  test('预检报的原因与真正被拒时的原因同源（同一个 QuotaFail 值）', async () => {
    // manifest 的 precheck.message 与真被拒时的 403 文案都由 quotaFailMessage 生成。
    // 这里只断言 precheck.fail 与 reserveDownload 的返回值一致。
    await setLimits(BOSS, { maxDownload: 1000 })
    await setLimits(KID, { maxDownload: 0 })
    await setLimits(SIB, { usedDownload: 900 })
    const chain = await resolveQuotaChain(db, KID)

    const pre = await precheckDownload(db, chain, 200)
    assert.equal(pre.fail, 'download_parent')
    assert.equal(await reserveDownload(db, chain, 200), 'download_parent')
  })

  /**
   * 下面这条记的是**当前实现的实际行为**，其中有一处值得留意。
   *
   * precheckDownload 返回的 used/max 在链长 2 时取的是**池**的口径，链长 1 时取自己的。
   * 这是有意为之（注释写在 precheckDownload 上）：整包下载真正会被卡住时，
   * 绝大多数情况是池先满，显示池的数才对得上。
   *
   * 但有个副作用：**池不限、而子账户自己的上限是瓶颈时，显示的数字不反映
   * 真正的约束**。下面这个例子就是 —— 池是 0（不限），孩子的上限是 100，
   * 预检却回 max=0/unlimited=true。用户看到「不限」，点下去却撞自己的上限。
   *
   * allowed 与 fail 都是对的（allowed=true、真的也放行 50 字节），所以不是
   * 「说不会超却拒了」那种 bug；只是提示文案里的数字挑错了层。
   * `fail` 已经能区分是哪一层，manifest 的 precheck 字段也带了它 ——
   * 要修的话是让提示用 `pre.fail` 选层，而不是改这里。
   */
  test('池不限但自己有限额时，precheck 的 used/max 取的是池的口径（提示数字会挑错层）', async () => {
    await setLimits(BOSS, { maxDownload: 0 })
    await setLimits(KID, { maxDownload: 100 })
    const chain = await resolveQuotaChain(db, KID)

    assert.deepEqual(
      await precheckDownload(db, chain, 50),
      { allowed: true, fail: null, used: 0, max: 0, unlimited: true },
      '这是当前行为：回的是池（不限），不是自己的 100'
    )
  })

  test('但 allowed / fail 仍与真实预占一致（数字挑错层不影响判定）', async () => {
    await setLimits(BOSS, { maxDownload: 0 })
    await setLimits(KID, { maxDownload: 100 })
    const chain = await resolveQuotaChain(db, KID)

    // 显示说「不限」，但 150 确实会被自己挡 —— fail 指对了层
    const pre = await precheckDownload(db, chain, 150)
    assert.equal(pre.allowed, false)
    assert.equal(pre.fail, 'download_self', 'fail 指向了自己那一层，提示文案能据此说清')
    assert.equal(await reserveDownload(db, chain, 150), 'download_self')
  })
})

describe('poolUsage：展示口径', () => {
  test('自己 + 实时 SUM 的孩子', async () => {
    await setLimits(BOSS, { maxStorage: 1000, usedStorage: 100 })
    await setLimits(KID, { usedStorage: 700 })
    assert.deepEqual(await poolUsage(db, BOSS, 'usedStorage'), { self: 100, children: 700, total: 800, max: 1000 })
  })

  test('切到下载列：col.slice(4) 要能推出 maxDownload', async () => {
    // 切片那一步（'usedDownload'.slice(4) === 'Download'）写错了的话，
    // 展示的上限会变成存储的上限 —— 界面上「下载流量 X / 容量 Y」，很难发现。
    await setLimits(BOSS, { maxStorage: 111, maxDownload: 222, usedDownload: 60 })
    await setLimits(KID, { usedDownload: 40 })
    assert.deepEqual(await poolUsage(db, BOSS, 'usedDownload'), { self: 60, children: 40, total: 100, max: 222 })
  })

  test('没有孩子时 children = 0（不是 NULL，界面直接相加会得到 null）', async () => {
    await setLimits(BOSS, { maxStorage: 1000, usedStorage: 50 })
    assert.deepEqual(await poolUsage(db, BOSS, 'usedStorage'), { self: 50, children: 0, total: 50, max: 1000 })
  })

  test('账号不存在 → 全 0（不抛）', async () => {
    assert.deepEqual(await poolUsage(db, 9999, 'usedStorage'), { self: 0, children: 0, total: 0, max: 0 })
  })
})

describe('recalculateChainStorage：删/移动/复制之后的自愈', () => {
  test('每层只算自己名下的文件 —— 池实时 SUM 的前提', async () => {
    await addFile(KID, 700)
    await addFile(BOSS, 300)
    // 把账改坏，模拟预占失败没退干净的漂移
    await db.run('UPDATE users SET usedStorage = 99999 WHERE id IN (?, ?)', [BOSS, KID])

    await recalculateChainStorage(db, KID)

    assert.equal(await col(KID, 'usedStorage'), 700, '自己那份 = 自己名下的文件')
    assert.equal(await col(BOSS, 'usedStorage'), 300, '主账号那份不能把孩子的算进来')
    assert.equal((await poolUsage(db, BOSS, 'usedStorage')).total, 1000)
  })

  test('连带把主账号那行也重算（子账户的改动会影响父账号的池）', async () => {
    await addFile(KID, 700)
    await addFile(BOSS, 300)
    await db.run('UPDATE users SET usedStorage = 1 WHERE id IN (?, ?)', [BOSS, KID])

    await recalculateChainStorage(db, KID)

    assert.equal(await col(BOSS, 'usedStorage'), 300, '主账号那行也要被纠正')
  })

  test('文件删光 → 归零，不会残留旧账', async () => {
    await addFile(KID, 700)
    await recalculateChainStorage(db, KID)
    assert.equal(await col(KID, 'usedStorage'), 700)

    await db.run('DELETE FROM files WHERE user_id = ?', [KID])
    await recalculateChainStorage(db, KID)
    assert.equal(await col(KID, 'usedStorage'), 0)
  })

  test('链长 1：只重算自己，不去碰别人', async () => {
    await setLimits(PLAIN, { usedStorage: 555 })
    await recalculateChainStorage(db, PLAIN)
    assert.equal(await col(PLAIN, 'usedStorage'), 0, 'PLAIN 名下没有文件')
  })
})

describe('退额只退自己那一行（父行从不写，所以不需要退两层）', () => {
  test('releaseDownload 同理', async () => {
    await setLimits(BOSS, { usedDownload: 50 })
    await setLimits(KID, { usedDownload: 300 })
    const chain = { selfId: KID, parentId: BOSS }

    await releaseDownload(db, chain, 100)

    assert.equal(await col(KID, 'usedDownload'), 200)
    assert.equal(await col(BOSS, 'usedDownload'), 50)
  })
})

describe('subAccountGate：建号的三道门', () => {
  test('canSubAccount 关着 → no_permission（主门）', async () => {
    await setLimits(BOSS, { canSub: 0 })
    assert.deepEqual(await subAccountGate(db, BOSS), { allowed: false, reason: 'no_permission' })
  })

  test('canSubAccount = 1 但自己是子账户 → one_level', async () => {
    await setLimits(KID, { canSub: 1 })
    assert.deepEqual(await subAccountGate(db, KID), { allowed: false, reason: 'one_level' })
  })

  test('额度上限 2 且已有 2 个 → quota_reached', async () => {
    await setLimits(BOSS, { canSub: 1, maxSub: 2 })
    assert.deepEqual(await subAccountGate(db, BOSS), { allowed: false, reason: 'quota_reached' })
  })

  test('上限 2 且只有 1 个 → 放行', async () => {
    await setLimits(BOSS, { canSub: 1, maxSub: 2 })
    await db.run('DELETE FROM users WHERE id = ?', [SIB])
    assert.deepEqual(await subAccountGate(db, BOSS), { allowed: true })
  })

  test('上限 0 = 不限，已有再多也放行（与 maxStorage 同口径）', async () => {
    await setLimits(BOSS, { canSub: 1, maxSub: 0 })
    assert.deepEqual(await subAccountGate(db, BOSS), { allowed: true })
  })

  test('账号不存在 → no_permission（不抛）', async () => {
    assert.deepEqual(await subAccountGate(db, 9999), { allowed: false, reason: 'no_permission' })
  })

  test('数量检查数的是**直属**孩子，不含孙账号', async () => {
    await setLimits(BOSS, { canSub: 1, maxSub: 2 })
    // BOSS 名下 KID/SIB 两个；KID 名下还有 GRAND
    assert.deepEqual(await subAccountGate(db, BOSS), { allowed: false, reason: 'quota_reached' })
    await db.run('DELETE FROM users WHERE id = ?', [SIB])
    assert.deepEqual(await subAccountGate(db, BOSS), { allowed: true }, '删一个直属孩子就该放行')
  })

  test('三种失败原因都有对应的提示文案', async () => {
    for (const r of ['no_permission', 'one_level', 'quota_reached']) {
      assert.equal(typeof GATE_MESSAGES[r], 'string', `缺 ${r} 的文案`)
      assert.ok(GATE_MESSAGES[r].length > 0, `${r} 的文案是空串`)
    }
  })

  test('文案表覆盖每一个可能的 reason（少一个就会弹出 undefined）', () => {
    // 索引不存在的键时 GATE_MESSAGES[x] 是 undefined，h3 会把 undefined
    // 当 message 发出去 —— 用户看到「undefined」而不是一句提示。
    // 这里用一个假的 gate 逐个试，确保联合类型的每个成员都有文案。
    const reasons = ['no_permission', 'one_level', 'quota_reached', 'limit_zero']
    for (const r of reasons) {
      assert.ok(GATE_MESSAGES[r], `GATE_MESSAGES['${r}'] 是 undefined`)
    }
  })
})

describe('requireOwnChild：归属判定', () => {
  test('自己的孩子 → 返回那一行', async () => {
    const row = await requireOwnChild(db, BOSS, KID)
    assert.equal(Number(row.id), KID)
    assert.equal(Number(row.parent_id), BOSS)
  })

  test('别人的孩子 → null（调用方一律转 404，不泄露 id 存在）', async () => {
    assert.equal(await requireOwnChild(db, KID, SIB), null)
  })

  test('自己对自己 → null（不能改/删自己的账号）', async () => {
    assert.equal(await requireOwnChild(db, BOSS, BOSS), null)
  })

  test('不存在的 id → null', async () => {
    assert.equal(await requireOwnChild(db, BOSS, 9999), null)
  })

  test('被写坏的三层链：KID 仍能管自己的孩子 GRAND（按直属那一层判）', async () => {
    // GRAND 的 parent_id 是 KID，所以 KID 对它是有权的。
    // 注意这条与 resolveQuotaChain 的「只取一层」是两件事：
    //   配额链只取一层（不递归）→ 但所有权判定只看**直接** parent_id
    // 一个往上递归、一个不递归，都是刻意的，注释分别在两处。
    const row = await requireOwnChild(db, KID, GRAND)
    assert.equal(Number(row?.id), GRAND)
    // 反过来 BOSS 不能越过 KID 直接动 GRAND
    assert.equal(await requireOwnChild(db, BOSS, GRAND), null)
  })
})

describe('checkNonNegative：额度校验的边界', () => {
  test('正常值放行', () => {
    for (const v of [0, '0', 1, 100, 1.5, '100']) {
      assert.equal(checkNonNegative(v), null, `${JSON.stringify(v)} 应放行`)
    }
  })

  test('负数拒绝', () => {
    for (const v of [-1, '-1', -0.5, '-0.5']) {
      assert.equal(checkNonNegative(v), '必须是 0 或正数', `${JSON.stringify(v)} 应拒绝`)
    }
  })

  test('非数字拒绝', () => {
    for (const v of [NaN, Infinity, -Infinity, 'abc', undefined]) {
      assert.equal(checkNonNegative(v), '必须是 0 或正数', `${JSON.stringify(v)} 应拒绝`)
    }
  })

  /**
   * 下面这组是 `Number()` 宽松强转的结果，记在这里是因为它们**看起来像 bug**：
   * 空的/空白的输入会被当成 0 而放行。
   *
   * 调用方都先做了 `Number(body[key])` 再传进来，而 body 里缺字段时
   * `Number(undefined)` = NaN（被拒），所以「字段没传」与「传了空数组」
   * 走的是两条不同的路 —— 后者只可能来自程序内部，不是用户能构造的 HTTP 请求。
   * 真要收紧就把这里改成 typeof 判断，但那是行为变更，得单独决定。
   */
  test('Number() 的宽松强转：空值/空白/空数组会当成 0 放行（已知，见注释）', () => {
    for (const v of ['', ' ', [], true]) {
      assert.equal(checkNonNegative(v), null, `${JSON.stringify(v)} 当前被当成 0 放行`)
    }
  })
})