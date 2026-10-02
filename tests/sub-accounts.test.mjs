// 子账户的配额链与接口权限测试。
//
// 要防的是两类东西：
//   1. **计费算错** —— 池的实时 SUM 与预占语句里的判定必须是同一个口径。
//      两者一旦漂移，表现是「页面显示池里还有余量，传的时候报空间不足」。
//   2. **权限漏一处** —— users 表能写角色与 parent_id，任一接口漏判就是提权。
//      所以除了行为断言，还有源码结构断言（字段白名单、写死的列名）。
//
// SQL 逐字复刻自 server/utils/sub-account.ts 的 reserveStorage / poolUsage，
// 数据夹具复用 tests/helpers/sqlite-fixture.mjs（在副本上跑，绝不碰开发库）。
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createShareFixture } from './helpers/sqlite-fixture.mjs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

/** 测试账号。主账号 950，子账户 951/952 */
const BOSS = 950
const KID = 951
const SIB = 952

let fx
before(async () => {
  fx = await createShareFixture()
  // 建这三个账号（夹具自带的 900/901 与本套无关）
  // expire_at 必须显式给 NULL：users.expire_at 的**列默认**是 CURRENT_TIMESTAMP，
  // 也就是「建号那一刻」—— 不写就等于一建号就已过期，所有预占都会被
  // NOT_EXPIRED_SQL 挡掉（第一次跑就是这么全红的）。
  for (const [id, username, parent] of [[BOSS, 'boss', null], [KID, 'kid', BOSS], [SIB, 'sib', BOSS]]) {
    await fx.run(
      'INSERT INTO users (id, username, email, password_hash, parent_id, expire_at, maxStorage, maxDownload) VALUES (?, ?, ?, ?, ?, NULL, 0, 0)',
      [id, username, `${username}@t.co`, 'x', parent]
    )
  }
})
after(() => fx.close())
beforeEach(async () => {
  await fx.reset()

  // 账号可能被上一个用例删掉（有一例专门验「删子账户自动退额」）。
  // fx.reset() 只清 files/folders，不碰 users，所以必须在这里补回来 ——
  // 否则后面的用例静默失败：预占作用在一条不存在的行上，changes 恒为 0。
  //
  // expire_at 必须显式给 NULL：users.expire_at 的**列默认**是 CURRENT_TIMESTAMP，
  // 也就是「建号那一刻」—— 不写就等于一建号就已过期，所有预占都会被
  // NOT_EXPIRED_SQL 挡掉。
  for (const [id, username, parent] of [[BOSS, 'boss', null], [KID, 'kid', BOSS], [SIB, 'sib', BOSS]]) {
    await fx.run(
      `INSERT INTO users (id, username, email, password_hash, parent_id, expire_at, maxStorage, maxDownload)
       VALUES (?, ?, ?, 'x', ?, NULL, 0, 0)
       ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id`,
      [id, username, `${username}@t.co`, parent]
    )
  }
  await fx.run(
    'UPDATE users SET maxStorage = 0, maxDownload = 0, usedStorage = 0, usedDownload = 0, expire_at = NULL WHERE id IN (?, ?, ?)',
    [BOSS, KID, SIB]
  )
})

/** 设额度。约定：池 = 1000，每个子账户分到 400 */
async function setLimits(id, { maxStorage = 0, maxDownload = 0, usedStorage = 0, usedDownload = 0, expire = null } = {}) {
  await fx.run(
    'UPDATE users SET maxStorage = ?, maxDownload = ?, usedStorage = ?, usedDownload = ?, expire_at = ? WHERE id = ?',
    [maxStorage, maxDownload, usedStorage, usedDownload, expire, id]
  )
}
const used = async (id, col) => Number((await fx.get(`SELECT ${col} AS v FROM users WHERE id = ?`, [id]))?.v ?? 0)

/* ---------- 复刻 reserveStorage 的 SQL（server/utils/sub-account.ts） ---------- */

const NOT_EXPIRED = (prefix = '') => {
  const c = prefix ? `${prefix}.expire_at` : 'expire_at'
  return `(TRIM(COALESCE(${c}, '')) = '' OR ${c} > ?)`
}
const POOL_WITHIN = (col, bytesParam) =>
  `COALESCE(p.${col}, 0) + COALESCE((SELECT SUM(COALESCE(c.${col}, 0)) FROM users c WHERE c.parent_id = p.id), 0) + ${bytesParam} <= COALESCE(p.max${col.slice(4)}, 0)`

/** 链长 2 时的存储预占。一条 UPDATE，两个条件都是原子的。 */
async function reserveStorageInChain(selfId, parentId, bytes, now) {
  return fx.run(
    `UPDATE users AS s
     SET usedStorage = COALESCE(s.usedStorage, 0) + ?
     WHERE s.id = ?
       AND ${NOT_EXPIRED('s')}
       AND (COALESCE(s.maxStorage, 0) = 0 OR COALESCE(s.usedStorage, 0) + ? <= COALESCE(s.maxStorage, 0))
       AND EXISTS (SELECT 1 FROM users p WHERE p.id = ?
            AND ${NOT_EXPIRED('p')}
            AND (COALESCE(p.maxStorage, 0) = 0 OR ${POOL_WITHIN('usedStorage', '?')}))`,
    [bytes, selfId, now, bytes, parentId, now, bytes]
  )
}

/** 复刻 poolUsage */
async function poolUsage(parentId, col = 'usedStorage') {
  const row = await fx.get(
    `SELECT COALESCE(${col},0) AS selfUsed,
            COALESCE((SELECT SUM(COALESCE(${col},0)) FROM users WHERE parent_id = ?),0) AS childUsed,
            COALESCE(max${col.slice(4)},0) AS maxVal
     FROM users WHERE id = ?`,
    [parentId, parentId]
  )
  const self = Number(row?.selfUsed ?? 0)
  const children = Number(row?.childUsed ?? 0)
  return { self, children, total: self + children, max: Number(row?.maxVal ?? 0) }
}

const NOW = '2026-06-01 00:00:00'
const FUTURE = '2099-01-01 00:00:00'
const PAST = '2000-01-01 00:00:00'

describe('两层额度：自己的上限 + 主账号的池', () => {
  test('池 1000、自己 400 → 预占 300 成功，只记自己那行', async () => {
    await setLimits(BOSS, { maxStorage: 1000 })
    await setLimits(KID, { maxStorage: 400 })
    assert.equal(await reserveStorageInChain(KID, BOSS, 300, NOW), 1)
    assert.equal(await used(KID, 'usedStorage'), 300)
  })

  test('主账号那一行从不写（池是实时 SUM，写了就变成两套账）', async () => {
    await setLimits(BOSS, { maxStorage: 1000 })
    await setLimits(KID, { maxStorage: 400 })
    await reserveStorageInChain(KID, BOSS, 300, NOW)
    assert.equal(await used(BOSS, 'usedStorage'), 0, '主账号的 usedStorage 应保持 0')
    // 池却要算得出 300
    assert.equal((await poolUsage(BOSS)).total, 300)
  })

  test('超过自己的上限（自己 400，池 1000）→ 挡下', async () => {
    await setLimits(BOSS, { maxStorage: 1000 })
    await setLimits(KID, { maxStorage: 400 })
    assert.equal(await reserveStorageInChain(KID, BOSS, 500, NOW), 0)
    assert.equal(await used(KID, 'usedStorage'), 0)
  })

  test('超过池（自己不限，池 1000，兄弟已用 800）→ 挡下', async () => {
    await setLimits(BOSS, { maxStorage: 1000 })
    await setLimits(KID, { maxStorage: 0 })
    await setLimits(SIB, { usedStorage: 800 })
    // 兄弟那 800 是从池里实时 SUM 出来的，不写在主账号行上
    assert.equal(await used(BOSS, 'usedStorage'), 0)
    assert.equal(await reserveStorageInChain(KID, BOSS, 300, NOW), 0, '池只剩 200')
    assert.equal(await reserveStorageInChain(KID, BOSS, 200, NOW), 1, '刚好用完应该放行')
  })

  test('池不限（max=0）时自己的上限仍然是硬约束', async () => {
    await setLimits(BOSS, { maxStorage: 0 })
    await setLimits(KID, { maxStorage: 400 })
    assert.equal(await reserveStorageInChain(KID, BOSS, 500, NOW), 0)
  })

  test('自己的上限不限时池仍然是硬约束', async () => {
    await setLimits(BOSS, { maxStorage: 1000 })
    await setLimits(KID, { maxStorage: 0 })
    await setLimits(SIB, { usedStorage: 1000 })
    assert.equal(await reserveStorageInChain(KID, BOSS, 1, NOW), 0)
  })
})

describe('删子账户自动退额（没有反向记账这一步）', () => {
  // 这是「父行只记自己那份」这个设计最大的好处。直观的写法（预占时同时改两行）
  // 必须在这里补一笔退额，漏了就是永久性的账目漂移。
  test('删掉那个孩子后池立刻变大', async () => {
    await setLimits(BOSS, { maxStorage: 1000 })
    await setLimits(KID, { maxStorage: 0 })
    await reserveStorageInChain(KID, BOSS, 800, NOW)
    assert.equal((await poolUsage(BOSS)).total, 800)

    await fx.run('DELETE FROM users WHERE id = ?', [KID])
    assert.equal((await poolUsage(BOSS)).total, 0, '孩子删了池就该回到原值')
    assert.equal(await reserveStorageInChain(KID, BOSS, 1000, NOW), 0, 'KID 已不存在')
  })

  test('主账号自己的那份不受孩子影响', async () => {
    await setLimits(BOSS, { maxStorage: 1000, usedStorage: 100 })
    await setLimits(KID, { usedStorage: 700 })
    const p = await poolUsage(BOSS)
    assert.equal(p.self, 100)
    assert.equal(p.children, 700)
    assert.equal(p.total, 800)
  })
})

describe('过期：主账号过期冻住整条链，子账户自己过期只冻自己', () => {
  test('主账号过期 → 子账户传不了', async () => {
    await setLimits(BOSS, { maxStorage: 1000, expire: PAST })
    await setLimits(KID, { maxStorage: 400 })
    assert.equal(await reserveStorageInChain(KID, BOSS, 10, NOW), 0)
  })

  test('子账户自己过期 → 它传不了', async () => {
    await setLimits(BOSS, { maxStorage: 1000 })
    await setLimits(KID, { maxStorage: 400, expire: PAST })
    assert.equal(await reserveStorageInChain(KID, BOSS, 10, NOW), 0)
  })

  test('兄弟过期不影响我', async () => {
    await setLimits(BOSS, { maxStorage: 1000 })
    await setLimits(KID, { maxStorage: 400 })
    await setLimits(SIB, { expire: PAST })
    assert.equal(await reserveStorageInChain(KID, BOSS, 10, NOW), 1)
  })

  test('主账号的过期时间没设 = 没过期', async () => {
    await setLimits(BOSS, { maxStorage: 1000, expire: null })
    await setLimits(KID, { maxStorage: 400 })
    assert.equal(await reserveStorageInChain(KID, BOSS, 10, NOW), 1)
  })

  test('未来时间 = 没过期', async () => {
    await setLimits(BOSS, { maxStorage: 1000, expire: FUTURE })
    assert.equal(await reserveStorageInChain(KID, BOSS, 10, NOW), 1)
  })
})

describe('没有主账号的普通用户走原来那条语句', () => {
  // 900/901 是夹具自带的账号，parent_id 为 NULL
  test('无 parent_id → 不进 EXISTS 分支，语义与改动前一致', async () => {
    // 901 是夹具自建的账号，同样继承了 expire_at 的列默认（= 已过期），要先摆正
    await fx.run('UPDATE users SET expire_at = NULL, maxStorage = 0, usedStorage = 0 WHERE id = ?', [901])
    const r = await fx.run(
      `UPDATE users SET usedStorage = usedStorage + ?
       WHERE id = ? AND ${NOT_EXPIRED()} AND (maxStorage = 0 OR usedStorage + ? <= maxStorage)`,
      [100, 901, 100]
    )
    assert.equal(r, 1)
    assert.equal(await used(901, 'usedStorage'), 100)
  })
})

/* ---------------------- 源码结构断言：权限与口径 ---------------------- */

describe('建号接口的字段是写死的，不从 body 读', () => {
  // users 表能写角色。能改 IsAdmin 就是提权。所以必须断言 INSERT 的列名是常量。
  const src = read('server/api/accounts/index.post.ts')

  test('INSERT 的列名不含 IsAdmin / IsSuperAdmin', () => {
    const insert = src.slice(src.indexOf('INSERT INTO users'), src.indexOf('RETURNING'))
    assert.ok(insert.length > 0, '找不到 INSERT 语句')
    assert.ok(!/IsAdmin/.test(insert), '建号接口不能写 IsAdmin')
    assert.ok(!/IsSuperAdmin/.test(insert), '建号接口不能写 IsSuperAdmin')
  })

  test('canChangePassword 写死 0（子账户不能自助改密码）', () => {
    const insert = src.slice(src.indexOf('INSERT INTO users'), src.indexOf('RETURNING'))
    assert.ok(/canChangePassword/i.test(insert), 'INSERT 里应显式写 canChangePassword')
    // 值那一行里是 0，不是占位符
    assert.ok(/VALUES\s*\([^)]*,\s*0,/.test(insert.replace(/\s+/g, ' ')), 'canChangePassword 的值应是字面 0')
  })

  test('parent_id 的值是 meId', () => {
    assert.ok(/\.bind\([^)]*meId/.test(src), 'bind 里应有 meId 作为 parent_id')
  })

  test('鉴权在读 body 之前', () => {
    const authAt = src.indexOf('requireAuth')
    const bodyAt = src.indexOf('readBody')
    assert.ok(authAt > -1 && bodyAt > -1)
    assert.ok(authAt < bodyAt, 'requireAuth 必须在 readBody 之前')
  })
})

describe('改额度的接口不碰角色与 parent_id', () => {
  const src = read('server/api/accounts/quota.post.ts')
  const setsStart = src.indexOf("sets.push(")

  test('白名单里只有额度与到期时间', () => {
    const body = src.slice(src.indexOf('const sets'), src.indexOf('if (!sets.length)'))
    for (const allowed of ['maxStorage', 'maxDownload', 'expire_at', 'canChangePassword']) {
      assert.ok(body.includes(allowed), `白名单缺 ${allowed}`)
    }
    for (const forbidden of ['IsAdmin', 'IsSuperAdmin', 'parent_id', 'usedStorage', 'usedDownload']) {
      assert.ok(!body.includes(forbidden), `白名单不该包含 ${forbidden}`)
    }
  })

  test('UPDATE 的 WHERE 带上 parent_id = 我', () => {
    assert.ok(
      /WHERE id = \? AND parent_id = \?/.test(src),
      '删除/更新必须带 parent_id = 我，只靠 id 删就可能被并发改动绕过'
    )
  })
})

describe('重置密码只碰 password_hash', () => {
  const src = read('server/api/accounts/reset-password.post.ts')
  test('UPDATE 只改 password_hash', () => {
    const upd = src.slice(src.indexOf('UPDATE users'))
    // 只截 SET 列表 —— WHERE 里的 parent_id = me 正是归属判定的一部分，
    // 拿 [^;]* 一路匹配会把它误判成「顺带改了 parent_id 列」（踩过）
    const setList = upd.slice(0, upd.indexOf('WHERE'))
    assert.ok(/SET password_hash = \?/.test(setList))
    for (const forbidden of ['IsAdmin', 'IsSuperAdmin', 'parent_id', 'canChangePassword']) {
      assert.ok(!new RegExp(forbidden).test(setList), `不该顺带改 ${forbidden}`)
    }
  })
  test('归属靠 parent_id = 我', () => {
    assert.ok(/requireOwnChild\(db, meId, id\)/.test(src))
  })
})

describe('管理接口不写 parent_id', () => {
  // 能改 parent_id = 能把任意用户改写成别人的子账户（花他的池），
  // 或者单方面解除父子关系（凭空释放一个池额度）。
  const src = read('server/api/manage/updateUser.post.ts')
  const upd = src.slice(src.indexOf('const sql = `'), src.indexOf('const stmt'))

  test('UPDATE 的 SET 列表里没有 parent_id', () => {
    assert.ok(!/parent_id/.test(upd), 'updateUser 不能写 parent_id')
    assert.ok(/canSubAccount\s*=/.test(upd) && /maxSubAccount\s*=/.test(upd), '但要有这两个新字段')
  })

  test('两个新字段用 COALESCE 兜底（老前端不传时不清零）', () => {
    assert.ok(/canSubAccount = COALESCE\(\?, canSubAccount\)/.test(upd))
    assert.ok(/maxSubAccount = COALESCE\(\?, maxSubAccount\)/.test(upd))
  })
})

describe('删主账号时若有子账户则拦截', () => {
  // 不能靠 parent_id ON DELETE CASCADE：那只会悄悄删掉 users 行，
  // COS 物理删不在 SQLite 的级联里（孤儿对象），而池是实时 SUM，
  // 级联完还会自动把额度还回去 —— 账上看着干净，孤儿对象一个不少。
  const src = read('server/api/manage/deleteUser.post.ts')

  test('有 parent_id = 目标 的计数检查', () => {
    assert.ok(/COUNT\(\*\) AS n FROM users WHERE parent_id = \?/.test(src), '缺少子账户计数检查')
    assert.ok(/childCount > 0/.test(src), '没有据此拒绝')
  })

  test('schema 里 parent_id 没有外键/级联', () => {
    const schema = read('server/database/schema.sql')
    const col = schema.slice(schema.indexOf('parent_id'), schema.indexOf('parent_id') + 200)
    assert.ok(!/REFERENCES/i.test(col), 'parent_id 不该带 REFERENCES（会带出级联行为）')
    assert.ok(!/ON DELETE/i.test(col), 'parent_id 不该带 ON DELETE')
  })

  test('migration 加的是普通列，不是带外键的', () => {
    const mig = read('server/plugins/db-migrate.ts')
    assert.ok(
      /ALTER TABLE users ADD COLUMN parent_id INTEGER(?!.*REFERENCES)/.test(mig),
      'migration 里 parent_id 应是不带外键的普通列'
    )
  })
})

describe('只有一层：建号时校验 parent_id 的 parent_id 为空', () => {
  const src = read('server/utils/account.ts')
  test('gate 里查了自身的 parent_id', () => {
    assert.ok(/parent_id AS parentId/.test(src))
    assert.ok(/one_level/.test(src), '应有「只能一层」的判定与原因码')
  })
  test('canSubAccount 是主门（不通过就不给建）', () => {
    // 只在函数体里比位置：'one_level' 在文件顶部的 SubAccountGate interface
    // 里就出现了，拿全文 indexOf 比会得出「层数先判」的相反结论（踩过）
    const body = src.slice(src.indexOf('export async function subAccountGate'))
    assert.ok(/canSubAccount AS canSub/.test(body))
    assert.ok(
      body.indexOf('canSub') < body.indexOf('one_level'),
      '先判权限再判层数'
    )
  })
})

describe('过期与额度不足是两句不同的文案，且要点出是哪一层', () => {
  const quota = read('server/utils/quota.ts')
  test('quotaFailMessage 按后缀分自己 / 主账号两层', () => {
    assert.ok(/_parent/.test(quota), '应区分 *_parent 的失败')
  })
  test('匿名访客那条不点名字', () => {
    const fn = quota.slice(quota.indexOf('export async function quotaFailMessage'))
    const anon = fn.slice(0, fn.indexOf('const row ='))
    assert.ok(anon.includes('actorId === null'), '过期/额度文案都该区分匿名访客')
  })
})

describe('四类预占都走链版，recalculate 也重算整条链', () => {
  // 这四处曾经各写一遍、只写了一处，导致过期账号能下载。现在是统一委托，
  // 所以断言的是「都引同一个模块」而不是逐条比对 SQL。
  for (const f of [
    'server/api/files/download.post.ts',
    'server/api/files/save.post.ts',
    'server/api/copy/paste.post.ts',
    'server/api/folders/manifest.get.ts'
  ]) {
    test(f, () => {
      const src = read(f)
      assert.ok(
        /from '~~\/server\/utils\/sub-account'/.test(src),
        `${f} 没有引用 sub-account.ts —— 说明还在用改动前的裸语句`
      )
    })
  }

  test('recalculateUsedStorage 委托给链版（而不是就地再实现一遍）', () => {
    const db = read('server/utils/db.ts')
    const fn = db.slice(db.indexOf('async recalculateUsedStorage'))
    assert.ok(/recalculateChainStorage\(this\.db, userId\)/.test(fn))
  })

  test('链版每层只算自己名下的文件（这是池实时 SUM 的前提）', () => {
    const sub = read('server/utils/sub-account.ts')
    assert.ok(
      /SELECT COALESCE\(SUM\(file_size\), 0\) AS totalSize FROM files WHERE user_id = \?/.test(sub),
      '链版必须按单层 user_id 求和，不能把孩子的文件算进主账号那行'
    )
  })
})

describe('池的口径只有一处定义', () => {
  // 两处算得不一样就是「显示没满却传不上去」。
  const sub = read('server/utils/sub-account.ts')
  test('预占语句与 poolUsage 用同一个 SUM 形状', () => {
    assert.ok(/SELECT SUM\(COALESCE\(c\.\$\{col\}, 0\)\) FROM users c WHERE c\.parent_id = p\.id/.test(sub), '预占里的池判定')
    assert.ok(/SELECT SUM\(COALESCE\(\$\{col\}, 0\)\) FROM users WHERE parent_id = \?/.test(sub), 'poolUsage 里的池统计')
  })
})

describe('池的判定必须算上主账号自己那一份（源码断言）', () => {
  /**
   * 为什么必须是源码断言而不是靠 SQL 复刻：
   * 上面的复刻是把 poolWithinSql 手抄一份跑的，改源码不影响它 ——
   * 试过把 `COALESCE(p.${col}, 0)` 那项去掉，38 例**全过**。
   *
   * 而那一项正是「池 = 自己 + 所有孩子」。去掉它的后果是超发一倍：
   * 主账号能用满 maxStorage 的同时，所有孩子合起来又能用满一份，
   * 而 poolUsage 显示的 total 少了自己那一份，用户看着还有余量却传不上去
   * （或者反过来，池真的满了却不拦）。
   */
  const fn = (() => {
    const src = read('server/utils/sub-account.ts')
    const i = src.indexOf('export function poolWithinSql')
    return src.slice(i, src.indexOf('\n}', i))
  })()

  test('池 = 主账号自己 + 实时 SUM 的孩子 + 本次', () => {
    assert.ok(
      /COALESCE\(p\.\$\{col\}, 0\)/.test(fn),
      '池里少了主账号自己那一份 —— 会让总发放量翻倍'
    )
    assert.ok(
      /SUM\(COALESCE\(c\.\$\{col\}, 0\)\) FROM users c WHERE c\.parent_id = p\.id/.test(fn),
      '池里少了孩子的实时 SUM'
    )
    assert.ok(
      /\+\s*\$\{bytesParam\}\s*<=\s*COALESCE\(p\.max/.test(fn),
      '池的上限比对缺少「本次用量」'
    )
  })

  test('池的上限是 max 列，0 才表示不限（口径与 maxStorage/maxDownload 一致）', () => {
    assert.ok(/COALESCE\(p\.max\$\{col\.slice\(4\)\}, 0\)/.test(fn))
  })
})