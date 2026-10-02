// precheckStorage 的行为 + **与 reserveStorage 的一致性**。
//
// ## 为什么重点是「一致性」而不是「预检本身对不对」
//
// 预检说够、预占说不够 → 用户白传一遍字节到 COS，然后被拒；
// 预检说不够、预占说够 → 放行了一个注定失败的请求。
//
// 两者只要有一个不一致，就是 bug。而「预检逻辑本身写得对不对」是次要的 ——
// 它现在用的是 reserveStorage 那几个**同样的片段生成器**，结构上就不该分叉。
//
// 所以这里的核心用例是：**同一组条件下，逐个比对两者的结论**。
//
// ## 有一条变异测不出效果，而且**应该**测不出
//
// 变异扫描 13 条抓到 12 条。漏的那条是「把「自己这层够不够」那个分流分支禁掉」——
// 它只影响**失败原因**，不影响 allowed：那句 if 之前，主查询的 WHERE（用
// ownWithinSql）已经拒掉了，allowed 照样是 false。
//
// 而「孩子自己满了」那个用例仍然断言 fail === 'storage_self'，也照样过 ——
// 因为分流块末尾的保守兜底恰好也返回 'storage_self'。两个分支给出同一个答案，
// 所以它确实是等价变异，不是覆盖缺口。记在这儿免得后人重追一遍。
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register(new URL('./helpers/resolve-nuxt-alias.mjs', import.meta.url), import.meta.url)

const { openRawDb } = await import('./helpers/sqlite-fixture.mjs')
const { openAdapterDb } = await import('./helpers/adapter-db.mjs')

const { precheckStorage, reserveStorage, resolveQuotaChain, ownWithinSql, poolWithinSql } =
  await import('../server/utils/sub-account.ts')

const BOSS = 700   // 主账号
const KID = 701    // 子账户
const PLAIN = 702  // 没有主账号的普通用户

describe('precheckStorage 与 reserveStorage 同口径', () => {
  let raw
  let db

  before(async () => {
    raw = await openRawDb()
    await raw.run(`CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT,
      parent_id INTEGER,
      expire_at TEXT,
      usedStorage INTEGER DEFAULT 0,
      maxStorage INTEGER DEFAULT 0,
      usedDownload INTEGER DEFAULT 0,
      maxDownload INTEGER DEFAULT 0
    )`)
    db = openAdapterDb(raw.raw)
  })

  after(async () => {
    await raw?.close()
  })

  /** 铺一批账号。exp 的格式与 nowSqlString() 一致（UTC，秒级） */
  async function setup(rows) {
    await raw.run('DELETE FROM users')
    for (const r of rows) {
      await raw.run(
        `INSERT INTO users (id, username, parent_id, expire_at, usedStorage, maxStorage)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [r.id, r.name ?? `u${r.id}`, r.parent ?? null, r.expire ?? null,
         r.used ?? 0, r.max ?? 0]
      )
    }
  }

  /**
   * 同一个状态下，依次跑「预检」和「预占」，比对结论。
   * @returns {pre: 预检结论, reserve: 预占结论, agree: 是否一致}
   */
  async function both(userId, bytes) {
    const chain = await resolveQuotaChain(db, userId)
    const pre = await precheckStorage(db, chain, bytes)
    const reserve = await reserveStorage(db, chain, bytes)
    return {
      pre,
      reserve,
      agree: (pre.allowed ? null : pre.fail) === reserve
    }
  }

  // 这张表是核心：每一行的三种配置 × 四个字节数，预检与预占必须全部一致。
  const CASES = [
    { label: '主账号不限额', rows: [{ id: BOSS, max: 0 }], user: BOSS, sizes: [1, 1000, 10 ** 9] },
    { label: '主账号有上限、还很空', rows: [{ id: BOSS, max: 1000 }], user: BOSS, sizes: [1, 500, 999, 1000, 1001] },
    { label: '主账号有上限、已用一半', rows: [{ id: BOSS, max: 1000, used: 500 }], user: BOSS, sizes: [1, 499, 500, 501] },
    { label: '普通用户无主账号、不限额', rows: [{ id: PLAIN, max: 0 }], user: PLAIN, sizes: [1, 10 ** 9] },
    { label: '普通用户无主账号、有上限', rows: [{ id: PLAIN, max: 800, used: 300 }], user: PLAIN, sizes: [1, 499, 500, 501] },
    // 链长 2：池与孩子自己的上限都会参与
    {
      label: '子账户：自己不限、池不限',
      rows: [{ id: BOSS, max: 0 }, { id: KID, parent: BOSS, max: 0 }],
      user: KID,
      sizes: [1, 10 ** 9]
    },
    {
      label: '子账户：自己上限小（这正是 credentials.post.ts 原来漏掉的那层）',
      rows: [{ id: BOSS, max: 0 }, { id: KID, parent: BOSS, max: 100 }],
      user: KID,
      sizes: [1, 99, 100, 101]
    },
    {
      label: '子账户：自己不限、池有上限',
      rows: [{ id: BOSS, max: 1000, used: 400 }, { id: KID, parent: BOSS, max: 0 }],
      user: KID,
      sizes: [1, 599, 600, 601]
    },
    {
      label: '子账户：两个上限都很紧（自己更紧）',
      rows: [{ id: BOSS, max: 1000, used: 400 }, { id: KID, parent: BOSS, max: 100 }],
      user: KID,
      sizes: [1, 99, 100, 101]
    },
    {
      label: '子账户：两个上限都很紧（池更紧）',
      rows: [{ id: BOSS, max: 500, used: 400 }, { id: KID, parent: BOSS, max: 300 }],
      user: KID,
      sizes: [1, 99, 100, 101]
    },
    {
      label: '池含多个孩子（池是实时 SUM，不是「池那行的数」）',
      rows: [
        { id: BOSS, max: 1000, used: 100 },
        { id: KID, parent: BOSS, max: 0, used: 200 },
        { id: 703, parent: BOSS, max: 0, used: 300 }
      ],
      user: BOSS,
      sizes: [599, 600, 601]
    },
    { label: '主账号已过期', rows: [{ id: BOSS, max: 0, expire: '2000-01-01 00:00:00' }], user: BOSS, sizes: [1] },
    { label: '子账户已过期', rows: [{ id: BOSS, max: 0 }, { id: KID, parent: BOSS, max: 0, expire: '2000-01-01 00:00:00' }], user: KID, sizes: [1] },
    {
      label: '子账户没过期、主账号过期',
      rows: [{ id: BOSS, max: 0, expire: '2000-01-01 00:00:00' }, { id: KID, parent: BOSS, max: 0 }],
      user: KID,
      sizes: [1]
    }
  ]

  for (const c of CASES) {
    test(`${c.label}：预检与预占结论一致`, async () => {
      await setup(c.rows)
      for (const size of c.sizes) {
        const r = await both(c.user, size)
        assert.ok(
          r.agree,
          `${c.label} size=${size}：预检说 ${r.pre.allowed ? '够' : r.pre.fail}，` +
            `预占说 ${r.reserve === null ? '够' : r.reserve} —— 两者不一致`
        )
        // 还原预占造成的扣减，让同一个 case 里的其他 size 从同一状态出发
        if (r.reserve === null) {
          const chain = await resolveQuotaChain(db, c.user)
          await raw.run('UPDATE users SET usedStorage = usedStorage - ? WHERE id = ?', [size, chain.selfId])
        }
      }
    })
  }

  test('两者都不改额度（预检是纯只读）', async () => {
    await setup([{ id: BOSS, max: 1000, used: 100 }, { id: KID, parent: BOSS, max: 0 }])
    const before = await raw.all('SELECT id, usedStorage FROM users ORDER BY id')
    const chain = await resolveQuotaChain(db, KID)
    const pre = await precheckStorage(db, chain, 100)
    assert.equal(pre.allowed, true)
    const after = await raw.all('SELECT id, usedStorage FROM users ORDER BY id')
    assert.deepEqual(after, before, '预检不许动 usedStorage —— 否则连着传两次就重复扣了')
  })

  test('预检允许后紧接预占，额度只被扣一次', async () => {
    await setup([{ id: BOSS, max: 1000, used: 0 }, { id: KID, parent: BOSS, max: 0 }])
    const chain = await resolveQuotaChain(db, KID)
    assert.equal((await precheckStorage(db, chain, 300)).allowed, true)
    assert.equal(await reserveStorage(db, chain, 300), null)
    const rows = await raw.all('SELECT id, usedStorage FROM users WHERE id = ?', [KID])
    assert.equal(rows[0].usedStorage, 300, '只扣自己那行一次')
  })

  test('连续两次预检不累积（可重复调用）', async () => {
    await setup([{ id: BOSS, max: 1000 }, { id: KID, parent: BOSS, max: 0 }])
    const chain = await resolveQuotaChain(db, KID)
    for (let i = 0; i < 5; i++) {
      assert.equal((await precheckStorage(db, chain, 100)).allowed, true)
    }
    const rows = await raw.all('SELECT usedStorage FROM users WHERE id = ?', [KID])
    assert.equal(rows[0].usedStorage, 0, '预检五次也不该扣任何东西')
  })

  test('bytes 为负数（覆盖一个更大的文件 → 释放空间）', async () => {
    // 与 save.post.ts 的 delta = 新大小 - 旧大小 同形。池快满时覆盖缩小不该被拒。
    await setup([{ id: BOSS, max: 1000, used: 990 }, { id: KID, parent: BOSS, max: 0, used: 0 }])
    const chain = await resolveQuotaChain(db, KID)
    const r = await both(KID, -500)
    assert.ok(r.agree, '负数 delta 上两者也必须一致')
    assert.equal(r.pre.allowed, true, '池只剩 10 字节，但覆盖释放 500，应该放行')
  })

  test('bytes 为 0', async () => {
    await setup([{ id: BOSS, max: 1000, used: 1000 }, { id: KID, parent: BOSS, max: 0 }])
    const chain = await resolveQuotaChain(db, KID)
    const r = await both(KID, 0)
    assert.ok(r.agree)
  })

  test('池刚好用满时再加 1 字节 → 拒绝，并指明是池不够', async () => {
    await setup([{ id: BOSS, max: 1000, used: 500 }, { id: KID, parent: BOSS, max: 0 }])
    const chain = await resolveQuotaChain(db, KID)
    const pre = await precheckStorage(db, chain, 501)
    assert.equal(pre.allowed, false)
    assert.equal(pre.fail, 'storage_parent', '该说是池不够，用户去调主账号')
    assert.equal(pre.max, 1000)
    assert.equal(pre.used, 500, 'used 应是池的合计（主账号自己那份 + 孩子的）')
  })

  test('孩子自己满了而池还空 → 拒绝，并指明是自己不够', async () => {
    await setup([{ id: BOSS, max: 10000, used: 0 }, { id: KID, parent: BOSS, max: 200, used: 180 }])
    const chain = await resolveQuotaChain(db, KID)
    const pre = await precheckStorage(db, chain, 30)
    assert.equal(pre.allowed, false)
    assert.equal(pre.fail, 'storage_self', '该说是自己不够，用户去让主账号提额')
  })

  test('unlimited 标志与 max 一致', async () => {
    await setup([{ id: BOSS, max: 0 }])
    const chain = await resolveQuotaChain(db, BOSS)
    const pre = await precheckStorage(db, chain, 1)
    assert.equal(pre.unlimited, true)
    assert.equal(pre.max, 0)

    await setup([{ id: BOSS, max: 100 }])
    const pre2 = await precheckStorage(db, await resolveQuotaChain(db, BOSS), 1)
    assert.equal(pre2.unlimited, false)
    assert.equal(pre2.max, 100)
  })
})

describe('共用 SQL 片段', () => {
  // 一致性不是靠「人记得同步」，是靠引用同一段文本。这两条钉住片段本身。
  test('ownWithinSql：max<=0 表示不限', () => {
    const sql = ownWithinSql('usedStorage')
    assert.match(sql, /maxStorage/)
    assert.match(sql, /= 0 OR /, '必须带「0 = 不限」的分支')
    assert.match(sql, /\+/, '必须带上本次的字节数')
  })

  test('ownWithinSql：带前缀时限定到该别名', () => {
    const sql = ownWithinSql('usedStorage', 's')
    assert.match(sql, /s\.maxStorage/)
    assert.match(sql, /s\.usedStorage/)
  })

  test('ownWithinSql：下载列也能用（同一个生成器）', () => {
    const sql = ownWithinSql('usedDownload')
    assert.match(sql, /maxDownload/)
    assert.match(sql, /usedDownload/)
  })

  test('ownWithinSql 支持自定义字节参数占位', () => {
    const sql = ownWithinSql('usedStorage', '', ':n')
    // 生成的是 `+ :n <= ...`（`+` 后面有空格）—— 第一版写 /\+:n/ 少了容错，
    // 断言红了才发现是自己把空格吞了，实现没问题
    assert.match(sql, /\+\s*:n/)
    assert.doesNotMatch(sql, /\+\s*\?/, '占位符应被替换掉')
  })

  test('poolWithinSql：池 = 主账号自己那份 + 所有孩子的实时 SUM', () => {
    const sql = poolWithinSql('usedStorage', '?')
    assert.match(sql, /COALESCE\(p\.usedStorage, 0\)/, '主账号自己那一份必须计入')
    assert.match(sql, /SUM\(COALESCE\(c\.usedStorage, 0\)\)/, '孩子的用量必须实时求和')
    assert.match(sql, /c\.parent_id = p\.id/, '只能算自己的孩子')
    assert.match(sql, /<= COALESCE\(p\.maxStorage, 0\)/)
  })
})
