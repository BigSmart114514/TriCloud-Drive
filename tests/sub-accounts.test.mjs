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
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

/* ==================================================================
 * 两条安装路径必须得到**同一个** users 表
 *
 * 全新装：server/database/schema.sql 里已经带了三列
 * 旧库升级：server/plugins/db-migrate.ts 的三条 ALTER TABLE ADD COLUMN
 *
 * 两者漂移的后果是「同一份代码在测试环境/新装环境与生产环境行为不同」，
 * 而且不报错 —— 直到某个账号建出来发现 canSubAccount 忘了开、或者
 * 建号数上限没生效。
 *
 * 这里的做法是**从 db-migrate.ts 源码里把 DDL 提取出来真跑**，
 * 而不是手抄一份 —— 手抄的那份会与迁移各改各的（下面「pool 的判定」
 * 那组已经吃过一次亏）。
 * ================================================================== */

const require = createRequire(import.meta.url)
const sqlite3 = require(new URL('../node_modules/sqlite3', import.meta.url).pathname)

/**
 * 把 db-migrate.ts 里三条 ALTER 的列名与类型抠出来，按出现顺序。
 *
 * 用分组（m[1]/m[2]）**重建** DDL，不要直接用 m[0]：m[0] 是整个匹配，
 * 而模式的末尾那个 `'` 是匹配的一部分 —— 直接拿来执行会得到
 * `... INTEGER'`，SQLite 报 `unrecognized token: "'"`（踩过）。
 */
function migrationDdl() {
  const src = read('server/plugins/db-migrate.ts')
  const out = []
  const re = /ALTER TABLE users ADD COLUMN (\w+) ([^'\n]+)'/g
  let m
  while ((m = re.exec(src))) {
    const col = m[1]
    const type = m[2].trim()
    out.push({ col, type, ddl: `ALTER TABLE users ADD COLUMN ${col} ${type}` })
  }
  return out
}

/**
 * 一次性的临时库。
 *
 * exec 做成会正确 resolve/reject 的 promise：**别把 rej 直接当回调传进去**
 * （`db.exec(sql, rej)`）—— sqlite3 成功时回调收到的是 err=null，于是
 * rej(null) 变成一次 reject，而外层还 await 着，看起来就是
 * 「Promise 一直 pending，最后 event loop 都空了才报」。（踩过，
 * 一整个 suite 会被 node:test 标成 cancelled。）
 */
function openTmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'subacct-schema-'))
  const raw = new sqlite3.Database(join(dir, 't.sqlite'))
  return {
    exec: (sql) => new Promise((res, rej) => raw.exec(sql, (e) => (e ? rej(e) : res(null)))),
    all: (sql) => new Promise((res, rej) => raw.all(sql, (e, r) => (e ? rej(e) : res(r || [])))),
    close: () =>
      new Promise((res) =>
        raw.close(() => {
          rmSync(dir, { recursive: true, force: true })
          res()
        })
      )
  }
}

/** users 表里那三列的定义（名字/类型/NOT NULL/默认值） */
const COLS_SQL =
  "SELECT name, type, \"notnull\" AS nn, dflt_value FROM pragma_table_info('users') WHERE name IN ('parent_id','canSubAccount','maxSubAccount') ORDER BY name"

describe('两条安装路径得到同一个 users 表', () => {
  const DDL = ['parent_id', 'canSubAccount', 'maxSubAccount']

  test('迁移里正好是这三列（少一列就是漏了一次升级）', () => {
    assert.deepEqual(migrationDdl().map((d) => d.col), DDL)
  })

  test('全新库（跑 schema.sql）三列都在', async () => {
    const db = openTmpDb()
    try {
      await db.exec(read('server/database/schema.sql'))
      const cols = await db.all(COLS_SQL)
      assert.equal(cols.length, 3, `schema.sql 里的三列不齐：${JSON.stringify(cols)}`)
      // COLS_SQL 里是 ORDER BY name（字母序），所以这里也比字母序
      assert.deepEqual(cols.map((c) => c.name), [...DDL].sort())
    } finally {
      await db.close()
    }
  })

  test('旧库升级（跑迁移的三条 ALTER）后与全新库**逐字段一致**', async () => {
    // 这是本组的核心：两条路径的列定义必须一模一样。
    // 类型或默认值差一点都不行 —— SQLite 的类型亲和性会让 'INTEGER' 与 'BIGINT'
    // 悄悄共存，而默认值差 0 / NULL 则是「建出来的账号默认值不一样」。
    const fresh = openTmpDb()
    let fromSchema
    try {
      await fresh.exec(read('server/database/schema.sql'))
      fromSchema = await fresh.all(COLS_SQL)
    } finally {
      await fresh.close()
    }

    const upgraded = openTmpDb()
    try {
      // 造一个「迁移之前」的 users 表：只有那三列之前的部分
      await upgraded.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          usedStorage BIGINT DEFAULT 0,
          maxStorage BIGINT DEFAULT 1,
          usedDownload BIGINT DEFAULT 0,
          maxDownload BIGINT DEFAULT 1,
          expire_at TEXT DEFAULT CURRENT_TIMESTAMP,
          canChangePassword BOOLEAN DEFAULT 1
        )
      `)
      for (const d of migrationDdl()) {
        try {
          await upgraded.exec(d.ddl)
        } catch (e) {
          throw new Error(`${d.ddl} 执行失败 → ${e.message}`, { cause: e })
        }
      }
      const fromMigration = await upgraded.all(COLS_SQL)
      assert.deepEqual(
        fromMigration,
        fromSchema,
        '升级路径与全新装的列定义不一致 —— 同一份代码在两种环境下行为会不同'
      )
    } finally {
      await upgraded.close()
    }
  })

  test('两条路径都建出 ix_users_parent_id', async () => {
    // 少了这个索引，池的 SUM 每次要全表扫 users。行数大了之后
    // 「每个子账户上传都慢一截」—— 而且慢的原因不在任何一行日志里。
    const INDEX_SQL = "SELECT name FROM sqlite_master WHERE type='index' AND name='ix_users_parent_id'"

    const fresh = openTmpDb()
    try {
      await fresh.exec(read('server/database/schema.sql'))
      assert.equal((await fresh.all(INDEX_SQL)).length, 1, 'schema.sql 缺这个索引')
    } finally {
      await fresh.close()
    }

    const upgraded = openTmpDb()
    try {
      await upgraded.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, parent_id INTEGER)')
      await upgraded.exec('CREATE INDEX ix_users_parent_id ON users (parent_id)')
      assert.equal((await upgraded.all(INDEX_SQL)).length, 1)
    } finally {
      await upgraded.close()
    }
  })

  test('迁移的 ALTER 不能重跑（所以 columnExists 那道判定是必需的）', async () => {
    // SQLite 对重复加列直接报错。这条测试的意义是证明 columnExists
    // 不是「顺手加的保险」而是**必需** —— 拿掉它，第二次启动就崩。
    const db = openTmpDb()
    try {
      await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, parent_id INTEGER)')
      await db.exec('ALTER TABLE users ADD COLUMN canSubAccount BOOLEAN DEFAULT 0')

      /**
       * 手动捕获而不是 assert.rejects。
       *
       * 后者会 throw，而一次**失败的 exec** 会让这个连接留在半途状态 ——
       * 后面 finally 里的 close() 回调就不触发了，整个 suite 被 node:test
       * 标成 cancelled，现象是「后面几条莫名其妙没跑」（踩过，很难一眼看出
       * 真凶是哪一条）。
       */
      let err = null
      try {
        await db.exec('ALTER TABLE users ADD COLUMN canSubAccount BOOLEAN DEFAULT 0')
      } catch (e) {
        err = e
      }
      assert.match(
        String(err?.message ?? ''),
        /duplicate column/i,
        '重复加列居然成功了，那 columnExists 的判定就是多余的'
      )
    } finally {
      await db.close()
    }
  })

  test('迁移里每条 ALTER 前面都有 columnExists 判定', () => {
    const src = read('server/plugins/db-migrate.ts')
    const seg = src.slice(src.indexOf('// 2) 子账户'), src.indexOf('// 3) 授权表'))
    assert.ok(/columnExists\(db, 'users', col\)/.test(seg), '这段 ALTER 循环没有 columnExists 守卫')
    // 锚到 'ALTER TABLE **users** ADD COLUMN'：这一段开头的注释里正写着
    // 「ALTER TABLE ADD COLUMN 对已有库安全」，不带 users 就会匹配到注释，
    // 于是「守卫在 ALTER 之前」这条永远不成立（踩过）。
    assert.ok(seg.indexOf('columnExists') < seg.indexOf('ALTER TABLE users ADD COLUMN'), '守卫必须在 ALTER 之前')
  })

  test('parent_id 两条路径都不带外键（带了就等于静默级联删子账户）', () => {
    // 理由写在 schema.sql 的 users 表定义里：SQLite 的 ON DELETE CASCADE
    // 只认识数据库，会悄悄删掉子账户的 users 行，而 COS 物理删不在 SQLite 的
    // 级联里（孤儿对象），池又是实时 SUM（额度自动还回去）——
    // 账上看着干净，孤儿对象一个不少。
    for (const d of migrationDdl()) {
      if (d.col === 'parent_id') {
        assert.ok(!/REFERENCES/i.test(d.ddl), '迁移里的 parent_id 不该带 REFERENCES')
        assert.ok(!/ON DELETE/i.test(d.ddl), '迁移里的 parent_id 不该带 ON DELETE')
      }
    }
  })

  test('两个开关列的默认值是 0（默认关 —— 不给就不许建子账户）', () => {
    // 默认 1 等于「任何登录用户都能建子账号、把文件分享出去」，
    // 外面访客下载消耗的是他作为主账号的池。这个默认值是安全边界，不是配置项。
    for (const d of migrationDdl()) {
      if (d.col === 'parent_id') {
        assert.ok(!/DEFAULT/i.test(d.ddl), 'parent_id 不该有默认值（NULL = 不是任何人的子账户）')
      } else {
        assert.ok(/DEFAULT 0/.test(d.ddl), `${d.col} 的默认值应是 0，实际「${d.type}」`)
      }
    }
  })
})

/* ==================================================================
 * updateUser 的两个新字段用 COALESCE 兜底
 *
 * 为什么要在意：管理员改一次容量（本来只想调 maxStorage），
 * 如果这两个字段被顺手清零，那个人的建号能力就没了 ——
 * 而他不会收到任何提示，因为他从来没碰过这两个字段。
 * ================================================================== */

/** 复刻 updateUser.post.ts 的 UPDATE（只留与本组有关的列） */
const UPDATE_USER_SQL = `
  UPDATE users
  SET maxStorage = ?, maxDownload = ?, usedStorage = ?, usedDownload = ?, expire_at = ?,
      canSubAccount = COALESCE(?, canSubAccount),
      maxSubAccount = COALESCE(?, maxSubAccount)
  WHERE id = ?`
const updateUser = (id, o) =>
  fx.run(UPDATE_USER_SQL, [
    o.maxStorage ?? 0, o.maxDownload ?? 0, o.usedStorage ?? 0, o.usedDownload ?? 0,
    o.expire_at ?? null,
    // null = 前端没传这个字段（前端传 undefined → JSON 里没有 → bind 收到 null）
    o.canSubAccount === undefined ? null : (o.canSubAccount ? 1 : 0),
    o.maxSubAccount === undefined ? null : Number(o.maxSubAccount),
    id
  ])

describe('updateUser：老前端不传新字段时不能把它们清零', () => {
  const gateOf = async (id) => {
    const r = await fx.get('SELECT canSubAccount AS c, maxSubAccount AS m FROM users WHERE id = ?', [id])
    return { canSubAccount: Number(r?.c ?? 0), maxSubAccount: Number(r?.m ?? 0) }
  }

  test('只改容量 → 建号能力与上限保持原值', async () => {
    await fx.run('UPDATE users SET canSubAccount = 1, maxSubAccount = 5 WHERE id = ?', [BOSS])

    await updateUser(BOSS, { maxStorage: 999, maxDownload: 888, usedStorage: 1, usedDownload: 2 })

    assert.deepEqual(await gateOf(BOSS), { canSubAccount: 1, maxSubAccount: 5 },
      '只改容量就把建号能力清了 —— 用户不会有任何提示地发现自己的子账户建不了了')
  })

  test('显式传 0 是「关掉」，与「没传」不同', async () => {
    await fx.run('UPDATE users SET canSubAccount = 1, maxSubAccount = 5 WHERE id = ?', [BOSS])

    await updateUser(BOSS, { canSubAccount: 0, maxSubAccount: 0 })

    assert.deepEqual(await gateOf(BOSS), { canSubAccount: 0, maxSubAccount: 0 })
  })

  test('maxSubAccount 传 0 = 不限（与 maxStorage 同口径，不是「只能建 0 个」）', async () => {
    // canSubAccount 也要给 1：第一道门不开的话 gate 直接就拒了，
    // 根本走不到「0 = 不限」那一条 —— 测出来会是「不能建」，
    // 看起来像是 0 的语义有问题，其实是根本没走到。
    await fx.run('UPDATE users SET canSubAccount = 1, maxSubAccount = 3 WHERE id = ?', [BOSS])

    await updateUser(BOSS, { maxSubAccount: 0 })

    assert.equal((await gateOf(BOSS)).maxSubAccount, 0)
    // 0 意味着 gate 不做数量检查
    assert.deepEqual(await subAccountGateLike(BOSS), { allowed: true })
  })

  test('传负数或非数字被 toNonNegativeNumber 归零，不写入脏值', async () => {
    await fx.run('UPDATE users SET maxSubAccount = 7 WHERE id = ?', [BOSS])

    // 复刻 updateUser 的 toNonNegativeNumber 语义（非法 → 0）
    const normalize = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0)
    await updateUser(BOSS, { maxSubAccount: normalize(-5) })

    assert.equal((await gateOf(BOSS)).maxSubAccount, 0)
  })

  test('parent_id 无论传什么都改不了（它根本不在这条 UPDATE 里）', async () => {
    // 反面证明：即使前端塞了 parent_id，这条语句也碰不到它。
    // 真正的防线是「SET 列表里没有这一列」，上面那条源码断言在守着。
    const setList = read('server/api/manage/updateUser.post.ts')
      .slice(read('server/api/manage/updateUser.post.ts').indexOf('const sql = `'))
      .split('`')[0]
    assert.ok(!/parent_id/.test(setList), 'SET 列表里出现了 parent_id')

    await fx.run('UPDATE users SET parent_id = ? WHERE id = ?', [BOSS, KID])
    await updateUser(KID, { maxStorage: 1, maxSubAccount: 3 })
    const row = await fx.get('SELECT parent_id AS p FROM users WHERE id = ?', [KID])
    assert.equal(Number(row?.p), BOSS, '改容量不该动到父子关系')
  })
})

/** 复刻 account.ts 的 subAccountGate（只判 canSubAccount 与数量上限，够这一组用） */
async function subAccountGateLike(id) {
  const me = await fx.get('SELECT canSubAccount AS c, maxSubAccount AS m FROM users WHERE id = ?', [id])
  if (Number(me?.c ?? 0) !== 1) return { allowed: false }
  const max = Number(me?.m ?? 0)
  if (max > 0) {
    const n = await fx.get('SELECT COUNT(*) AS n FROM users WHERE parent_id = ?', [id])
    if (Number(n?.n ?? 0) >= max) return { allowed: false }
  }
  return { allowed: true }
}

/* ==================================================================
 * /accounts 列表只列自己的孩子
 *
 * 这是数据泄露面：一个主账号能看到别人的子账户（进而知道别人账号的
 * id、用户名、用量），或者看到不是自己孩子的行。
 * ================================================================== */

describe('/accounts 列表只列 parent_id = 自己', () => {
  /** 复刻 accounts/index.get.ts 的查询 */
  const LIST_SQL = 'SELECT id, username FROM users WHERE parent_id = ? ORDER BY created_at DESC'
  const list = async (meId) => (await fx.all(LIST_SQL, [meId])).map((r) => Number(r.id))

  test('只返回直属孩子', async () => {
    assert.deepEqual((await list(BOSS)).sort((a, b) => a - b), [KID, SIB].sort((a, b) => a - b))
  })

  test('不是自己孩子的行一个都不出现（包括孙账号）', async () => {
    // 造一个孙账号（parent = KID），它是 KID 的孩子、不是 BOSS 的
    await fx.run(
      `INSERT INTO users (id, username, email, password_hash, parent_id, expire_at)
       VALUES (953, 'grand', 'g@t.co', 'x', ?, NULL)`,
      [KID]
    )

    const mine = await list(BOSS)
    assert.ok(!mine.includes(953), '孙账号不该出现在主账号的列表里')
    assert.ok(!mine.includes(BOSS), '自己也不该出现在自己的列表里')
    assert.deepEqual(mine.sort((a, b) => a - b), [KID, SIB].sort((a, b) => a - b), '直属孩子都要在')

    // 反向：孙账号确实出现在 KID 的列表里（说明上面的排除不是查询坏了），
    // 且 KID 的列表里没有 KID 自己。
    const kids = await list(KID)
    assert.deepEqual(kids, [953])
    assert.ok(!kids.includes(KID), '孩子自己不该出现在自己的列表里')

    await fx.run('DELETE FROM users WHERE id = 953')
  })

  test('看不到别人的孩子', async () => {
    // 再造一个不相干的主账号 954 和它的孩子
    await fx.run(
      `INSERT INTO users (id, username, email, password_hash, parent_id, expire_at)
       VALUES (954, 'other', 'o@t.co', 'x', NULL, NULL)`)
    await fx.run(
      `INSERT INTO users (id, username, email, password_hash, parent_id, expire_at)
       VALUES (955, 'otherkid', 'ok@t.co', 'x', 954, NULL)`)

    const mine = await list(BOSS)
    assert.ok(!mine.includes(955), '泄露：看到别人的子账户')

    // 反过来，别人也看不到我的
    const theirs = await list(954)
    assert.deepEqual(theirs, [955])
    assert.ok(!theirs.includes(KID) && !theirs.includes(SIB))

    await fx.run('DELETE FROM users WHERE id IN (954, 955)')
  })

  test('没有孩子时返回空数组（不是 null，页面直接 .length）', async () => {
    assert.deepEqual(await list(901), [])
  })

  test('源码里 WHERE 必须落在 parent_id 上，且鉴权在查询之前', () => {
    const src = read('server/api/accounts/index.get.ts')
    assert.ok(/WHERE parent_id = \?/.test(src), '列表查询没有按 parent_id 过滤')
    assert.ok(
      src.indexOf('requireAuth') < src.indexOf('SELECT id, username'),
      'requireAuth 必须在查询之前'
    )
    assert.ok(!/IsAdmin/.test(src), '这个接口与角色无关，不该出现 IsAdmin 判定')
  })

  test('池汇总查的是「自己的池」，不是当前行的池', () => {
    const src = read('server/api/accounts/index.get.ts')
    // poolUsage(db, meId, ...) —— 传 meId 而不是 children[0].id 或 targetUserId
    assert.ok(/poolUsage\(db, meId, 'usedStorage'\)/.test(src), '存储池的归属传错了')
    assert.ok(/poolUsage\(db, meId, 'usedDownload'\)/.test(src), '下载池的归属传错了')
  })

  test('【已知缺陷】用户名搜索未转义 LIKE 通配符', async () => {
    // 与 share/candidates.get.ts、manage/listUsers.get.ts 同一个老问题：
    // `%${username}%` 直接拼进 LIKE，而 LIKE 里的 % 和 _ 是通配符。
    // 所以搜 '%' 会列出全部孩子，而不是「名字里含 % 的孩子」。
    // 这不是本次引入的，是既有模式；记在这里以免被当成新 bug 重复报。
    const LIKE_SQL = 'SELECT id FROM users WHERE parent_id = ? AND username LIKE ?'
    const all = (await fx.all(LIKE_SQL, [BOSS, '%%%'])).map((r) => Number(r.id))
    assert.deepEqual(all.sort((a, b) => a - b), [KID, SIB].sort((a, b) => a - b),
      '搜 %% 竟然精确匹配了 —— 说明实现里做了转义，这条可以改成正式回归测试')
    assert.ok(
      read('server/api/accounts/index.get.ts').includes('%${q.username}%'),
      '没看到未转义的拼接 —— 那说明上面那条行为已经变了，本条的注释要一起改'
    )
  })
})

/* ==================================================================
 * 四个 handler 的入参守卫
 *
 * 为什么是源码断言而不是行为断言：这些 handler 用了 Nuxt 的自动导入
 * （defineEventHandler / readBody / createError），node --test 里没法直接调；
 * 复刻一份校验逻辑又回到「测的是抄写」的老问题上。
 *
 * 所以这里钉的是「守卫还在不在」。实测过：把 validatePassword、
 * checkNonNegative、isSqlDateTimeString 三处校验各自去掉，
 * 行为断言一条都不红（因为它们根本不经过这些路径），只有本组会红。
 * ================================================================== */

/**
 * 剥掉行注释与块注释，只留代码。
 *
 * **位置断言一律要在这个结果上做。** 同一个坑踩了三次：
 *   - 断言「columnExists 在 ALTER 之前」，但段首注释里就写着 ALTER TABLE
 *   - 断言「过期判定在 if (reserveBytes > 0) 之外」，但注释里就抄着那一句
 *   - 断言「requireAuth 在 readBody 之前」，但文件头注释里写着
 *     「鉴权必须在读 body 之前：const me = await requireAuth(event)」
 * 三次都是拿 indexOf 比下标，于是注释里的字面量反而成了"证据"，
 * 断言恒真或恒假 —— 两种都等于没测。
 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l) && !/^\s*\*\//.test(l))
    .join('\n')
}

/** 一个 handler 里某个校验函数出现的次数（去掉注释后再数，避免被说明文字骗到） */
function guardCount(src, fn) {
  const noComment = codeOnly(src)
  return (noComment.match(new RegExp(`\\b${fn}\\s*\\(`, 'g')) || []).length
}

/**
 * 「某个表达式的结果被**直接**用作 if 条件」。
 *
 * 为什么不能只写 `if (…expr…)`：那样 `if (bad)` 和 `if (bad && false)`
 * 都算通过 —— 而后者正是「校验还在、结果被短路丢弃」的写法，
 * 负数照样写得进库。变异测试实测过：宽松版断言放过了 4 条变异。
 *
 * 所以这里钉的是惯用写法本身。若哪天改成 `if (bad) { throw … }` 多行形式，
 * 这条会红，届时把 after 那个正则一起放宽即可（失败信息里写了怎么改）。
 */
function guardsResult(src, expr) {
  return new RegExp(`if \\(${expr}\\) \\{?\\s*(throw|//)`).test(codeOnly(src))
}

/** 条件里出现短路运算符 —— 那就是在绕过这个守卫 */
function shortCircuited(src, expr) {
  return new RegExp(`if \\(${expr} (?:&&|\\|\\|)`).test(codeOnly(src))
}

describe('accounts 各接口的入参守卫', () => {
  const HANDLERS = {
    'accounts/index.post.ts': read('server/api/accounts/index.post.ts'),
    'accounts/quota.post.ts': read('server/api/accounts/quota.post.ts'),
    'accounts/reset-password.post.ts': read('server/api/accounts/reset-password.post.ts'),
    'accounts/delete.post.ts': read('server/api/accounts/delete.post.ts'),
    'accounts/index.get.ts': read('server/api/accounts/index.get.ts')
  }

  test('每个 handler 都先鉴权再读 body', () => {
    // 顺序反了的话，未登录的请求会先被读一遍 body 才被拒 ——
    // 更要紧的是 readBody 抛错时返回的错误会盖掉 401。
    for (const [name, src] of Object.entries(HANDLERS)) {
      const code = codeOnly(src)
      // 找**调用**而不是裸标识符：裸标识符会命中 import 语句
      // （`import { requireAuth } from …`），那永远在文件最前面，
      // 于是无论怎么调换调用顺序断言都恒真 —— 变异测试实测过。
      const authAt = code.search(/requireAuth\s*\(/)
      assert.ok(authAt > -1, `${name} 没有鉴权`)
      const bodyAt = code.search(/readBody\s*\(/)
      if (bodyAt > -1) {
        assert.ok(authAt < bodyAt, `${name}: requireAuth 必须在 readBody 之前`)
      }
    }
  })

  test('建号：邮箱 / 用户名 / 密码都要校验', () => {
    const src = HANDLERS['accounts/index.post.ts']
    assert.equal(guardCount(src, 'validateEmail'), 1, '邮箱校验不见了')
    assert.equal(guardCount(src, 'validateUsername'), 1, '用户名校验不见了')
    assert.equal(guardCount(src, 'validatePassword'), 1, '密码强度校验不见了')
    // 三个都必须是 400 而不是 403/500 —— 校验失败与权限无关。
    // 同时钉住「结果被直接用作条件」，否则 `if (!validatePassword(x) && false)`
    // 这种绕过也能过。
    for (const fn of ['validateEmail', 'validateUsername', 'validatePassword']) {
      const i = src.search(new RegExp(`!${fn}\\s*\\(`))
      assert.ok(i > -1, `${fn} 的结果没被用作条件`)
      assert.ok(/statusCode: 400/.test(src.slice(i, i + 200)), `${fn} 失败时应该回 400，不是权限类的 403`)
    }
  })

  test('建号：三个字段缺一不可', () => {
    const src = HANDLERS['accounts/index.post.ts']
    assert.ok(
      /if \(!email \|\| !username \|\| !password\)/.test(src),
      '没有「邮箱、用户名、密码都是必填项」这道守卫'
    )
  })

  test('建号：额度必须非负（两处），且**校验结果要被用**', () => {
    const src = HANDLERS['accounts/index.post.ts']
    assert.equal(guardCount(src, 'checkNonNegative'), 2, '存储/下载两处额度校验，至少有一处不见了')
    // 光数调用次数不够：把 `if (bad) throw` 改成 `if (false) throw`，
    // checkNonNegative 照样被调了两次，只是返回值被丢掉了 ——
    // 那条变异最初就是这么漏网的。
    for (const v of ['bad', 'bad2']) {
      assert.ok(guardsResult(src, v), `checkNonNegative 的返回值(${v})没被直接用作 if 条件`)
      assert.ok(!shortCircuited(src, v), `${v} 在 if 条件里被短路了（形如 if (${v} && false)）—— 守卫等于没有`)
    }
  })

  test('建号：到期时间要么为空、要么是合法时间', () => {
    const src = HANDLERS['accounts/index.post.ts']
    assert.ok(
      /expireAt != null && !isSqlDateTimeString\(expireAt\)/.test(src),
      '守卫必须是「非空才校验合法」—— 反过来就等于「留空也报错」，没法设永不过期'
    )
  })

  test('建号：用户名唯一，且**查到的结果要被用**', () => {
    const src = HANDLERS['accounts/index.post.ts']
    assert.ok(
      /SELECT id FROM users WHERE username = \?/.test(codeOnly(src)),
      '没有查重 —— 并发建同一个名字时两个请求都会过，第二个撞 UNIQUE 报 500'
    )
    // 同上：只断言「有这条查询」不够，把 exists 换成恒 null 也照样过。
    assert.ok(guardsResult(src, 'exists'), '查了重却没用结果 —— 等于没查')
    assert.ok(!shortCircuited(src, 'exists'), 'exists 在 if 条件里被短路了 —— 等于没查')
  })

  test('改额度：两处额度都要校验非负，且**校验结果要被用**', () => {
    const src = HANDLERS['accounts/quota.post.ts']
    // 循环里一次调 checkNonNegative，覆盖 maxStorage / maxDownload 两个 key
    assert.ok(guardCount(src, 'checkNonNegative') >= 1, '额度校验不见了')
    assert.ok(
      /\['maxStorage', '存储上限'\], \['maxDownload', '下载上限'\]/.test(codeOnly(src)),
      '两个 key 的循环没了 —— 只剩一个字段被校验'
    )
    assert.ok(guardsResult(src, 'bad'), 'checkNonNegative 的返回值没被直接用作 if 条件')
    assert.ok(!shortCircuited(src, 'bad'), 'bad 在 if 条件里被短路了 —— 守卫等于没有')
  })

  test('改额度：expire_at 的校验口径与建号一致', () => {
    const src = HANDLERS['accounts/quota.post.ts']
    assert.ok(
      /v != null && !isSqlDateTimeString\(v\)/.test(src),
      '守卫必须是「非空才校验合法」'
    )
  })

  test('改额度：什么字段都没传要说清楚，而不是默默成功', () => {
    const src = HANDLERS['accounts/quota.post.ts']
    assert.ok(/if \(!sets\.length\)/.test(src), '缺「没有要修改的内容」这道守卫')
  })

  test('重置密码：校验密码强度', () => {
    const src = HANDLERS['accounts/reset-password.post.ts']
    assert.equal(guardCount(src, 'validatePassword'), 1)
    assert.ok(/if \(!newPassword\)/.test(src), '没有「请输入新密码」这道守卫')
  })

  test('三个接口都校验 id 是正整数', () => {
    for (const name of ['accounts/quota.post.ts', 'accounts/reset-password.post.ts', 'accounts/delete.post.ts']) {
      assert.ok(
        /!Number\.isInteger\(id\) \|\| id <= 0/.test(codeOnly(HANDLERS[name])),
        `${name} 没有校验 id`
      )
    }
  })

  test('归属判定一律走 requireOwnChild（不自己拼 WHERE）', () => {
    for (const name of ['accounts/quota.post.ts', 'accounts/reset-password.post.ts', 'accounts/delete.post.ts']) {
      assert.ok(/requireOwnChild\(db, meId, id\)/.test(HANDLERS[name]), `${name} 没走 requireOwnChild`)
      assert.ok(
        HANDLERS[name].includes('子账户不存在') && HANDLERS[name].includes('statusCode: 404'),
        `${name} 不是用 404 —— 403 会泄露「这个 id 存在」`
      )
    }
  })

  test('列表接口不接任何写操作（只有 GET 语义）', () => {
    const src = codeOnly(HANDLERS['accounts/index.get.ts'])
    assert.ok(!/readBody/.test(src), 'GET 接口不该读 body')
    assert.ok(!/INSERT|UPDATE|DELETE/i.test(src), '列表接口里有写语句')
  })
})
