// 分享权限解析的集成测试：跑真实的 resolveAccess 算法（复刻自
// server/utils/db.ts），数据在库副本上现造。
//
// 为什么复刻而不是直接 import：db.ts 依赖 Nuxt 的自动导入（createError 等）
// 和 sqlite3 封装，没法在 node --test 里直接跑。复刻的是算法本身，
// 改 db.ts 时必须同步改这里 —— 所以下面每个场景都标注了对应的源码位置。
//
// 跑法：node tests/resolve-access.test.mjs
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = new URL('..', import.meta.url).pathname
const sqlite3 = require(join(ROOT, 'node_modules/sqlite3'))

const PERM_READ = 1
const PERM_WRITE = 2
const SHARE_NONE = 0
const SHARE_SHARED = 1
const SHARE_INHERIT = 2

// —— 以下三个函数逐字复制自 types/share.ts ——
function normalizeShareMode(value) {
  if (value === null || value === undefined || value === '') return SHARE_INHERIT
  if (typeof value === 'object' || typeof value === 'boolean') return SHARE_INHERIT
  const n = Number(value)
  if (n === SHARE_NONE || n === SHARE_SHARED || n === SHARE_INHERIT) return n
  return SHARE_INHERIT
}
function normalizePermission(mask) {
  const m = Number(mask) || 0
  if (m & 4) return 7
  if (m & 2) return 3
  if (m & 1) return 1
  return 0
}
const toBool = (v) => v === true || v === 1 || v === '1'

// —— 复刻自 server/utils/db.ts ——
const NO_ACCESS = { mode: SHARE_INHERIT, mask: 0, source: 'none', hasBoundary: false }

/** db.ts decideAncestor（db.ts:195） */
function decideAncestor(mode, isPublic, row) {
  if (mode === SHARE_INHERIT) return NO_ACCESS
  if (mode === SHARE_NONE) {
    return { mode, mask: 0, source: 'none', hasBoundary: true }
  }
  const own = row && row.permission != null ? normalizePermission(row.permission) : 0
  return {
    mode,
    mask: normalizePermission(own | (isPublic ? PERM_READ : 0)),
    source: own > 0 ? 'inherited' : isPublic ? 'public' : 'none',
    hasBoundary: true
  }
}

/** db.ts combineWithAncestor（db.ts:256） */
function combineWithAncestor(self, ancestor, belowMask, belowPub, belowGrants, hasBoundary) {
  const own = self.permission != null ? normalizePermission(self.permission) : 0
  const direct = normalizePermission(own | (self.isPublic ? PERM_READ : 0))
  const mode = normalizeShareMode(self.mode)

  if (mode === SHARE_NONE) {
    return { mode: SHARE_NONE, mask: 0, source: 'none', hasBoundary }
  }
  if (mode === SHARE_SHARED) {
    return { mode: SHARE_SHARED, mask: direct, source: 'self', hasBoundary }
  }
  // 没人拍板 → 预设（自身的名单/公开）不生效
  if (!hasBoundary) {
    return { mode: SHARE_NONE, mask: 0, source: 'none', hasBoundary: false }
  }
  // 祖先是「不分享」→ 墙，连自身的直接授权一起挡
  if (ancestor.mode === SHARE_NONE) {
    return { mode: SHARE_NONE, mask: 0, source: 'none', hasBoundary: true }
  }
  const isPublicAny = self.isPublic || ancestor.isPublic || belowPub
  const source =
    own > 0 ? 'self'
      : ancestor.mask > 0 ? ancestor.source
        : belowGrants > 0 ? 'inherited'
          : isPublicAny ? 'public'
            : 'none'
  return {
    mode: SHARE_INHERIT,
    isPublic: isPublicAny,
    mask: normalizePermission(direct | ancestor.mask | belowMask),
    source,
    hasBoundary: true
  }
}

let db
let dir
let sql

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'resolve-access-'))
  const path = join(dir, 'test.sqlite')
  copyFileSync(join(ROOT, 'data.sqlite'), path)
  db = new sqlite3.Database(path)
  sql = {
    all: (q, p) => new Promise((res, rej) => db.all(q, p, (e, r) => (e ? rej(e) : res(r)))),
    run: (q, p) =>
      new Promise((res, rej) => db.run(q, p, function (e) { e ? rej(e) : res(this.changes) }))
  }

  // 建一棵干净的测试树（每个测试内部会 reset）
  await sql.run('DELETE FROM folder_access')
  await sql.run('DELETE FROM folders')
  await sql.run('DELETE FROM users WHERE id >= 900')
  for (const id of [900, 901]) {
    // password_hash 是 NOT NULL，给个占位值即可，本测试不碰认证
    await sql.run(
      'INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)',
      [id, `u${id}`, `u${id}@x`, 'x']
    )
  }
})

after(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** 建目录：id, ownerId, name, parentId, Shared, IsPublic */
async function mkFolder(id, parentId, Shared, IsPublic = 0) {
  await sql.run(
    'INSERT INTO folders (id, user_id, name, parent_id, Shared, IsPublic) VALUES (?, 901, ?, ?, ?, ?)',
    [id, `f${id}`, parentId, Shared, IsPublic]
  )
}
/** 授权：folderId 授予 userId permission */
async function grant(folderId, userId, permission) {
  await sql.run('INSERT INTO folder_access (folder_id, user_id, permission) VALUES (?, ?, ?)', [
    folderId, userId, permission
  ])
}
async function reset() {
  await sql.run('DELETE FROM folder_access')
  await sql.run('DELETE FROM folders')
}

/** db.ts FolderService.isPresetActive（db.ts:696）：只问「有没有拍板者、是不是墙」 */
async function isPresetActive(folderId) {
  const rows = await sql.all(
    `WITH RECURSIVE up(id, parent_id, shared, depth) AS (
       SELECT id, parent_id, Shared, 0 FROM folders WHERE id = ?
       UNION ALL
       SELECT f.id, f.parent_id, f.Shared, up.depth + 1
       FROM folders f JOIN up ON f.id = up.parent_id
     )
     SELECT shared, depth FROM up ORDER BY depth ASC`,
    [folderId]
  )
  if (!rows.length) return false
  const boundary = rows.find(
    (r) => Number(r.depth) > 0 && (Number(r.shared) === 0 || Number(r.shared) === 1)
  )
  if (!boundary) return false
  return Number(boundary.shared) !== 0
}

/** db.ts resolveAccess（db.ts:511）的真实 SQL + 合并逻辑 */
async function resolveAccess(userId, folderId) {
  const rows = await sql.all(
    `WITH RECURSIVE up(id, parent_id, shared, pub, depth) AS (
       SELECT id, parent_id, Shared, IsPublic, 0 FROM folders WHERE id = ?
       UNION ALL
       SELECT f.id, f.parent_id, f.Shared, f.IsPublic, up.depth + 1
       FROM folders f JOIN up ON f.id = up.parent_id
     ),
     boundary AS (
       SELECT COALESCE(
         (SELECT MIN(depth) FROM up WHERE shared IN (0,1) AND depth > 0),
         (SELECT MAX(depth) FROM up)
       ) AS depth
     ),
     picked AS (
       SELECT up.id, up.shared, up.pub, up.depth,
         CASE WHEN up.depth = 0 THEN 0
              WHEN up.shared IN (0,1) AND up.depth <= boundary.depth THEN 1
              ELSE 2 END AS pri
       FROM up, boundary WHERE up.depth = 0 OR up.depth <= boundary.depth
     )
     SELECT p.pri, p.depth, p.shared, p.pub, fa.permission
     FROM picked p
     LEFT JOIN folder_access fa ON fa.folder_id = p.id AND fa.user_id = ?
     ORDER BY p.depth ASC`,
    [folderId, userId]
  )
  const self = rows.find((r) => Number(r.depth) === 0)
  if (!self) return { mask: 0, note: '找不到自身' }

  let belowGrants = 0
  let belowPub = false
  for (const r of rows) {
    if (Number(r.pri) !== 2) continue
    if (r.permission != null) {
      belowGrants = normalizePermission(belowGrants | normalizePermission(r.permission))
    }
    if (toBool(r.pub)) belowPub = true
  }
  const belowMask = normalizePermission(belowGrants | (belowPub ? PERM_READ : 0))

  const anc = rows.find(
    (r) => Number(r.depth) > 0 && (Number(r.shared) === 0 || Number(r.shared) === 1)
  )
  const ancestor = anc ? decideAncestor(normalizeShareMode(anc.shared), toBool(anc.pub), anc) : NO_ACCESS

  return combineWithAncestor(
    { mode: self.shared, isPublic: toBool(self.pub), permission: self.permission },
    ancestor, belowMask, belowPub, belowGrants, !!anc
  )
}

describe('分享态（Shared=1）—— 明确表态，不看祖先', () => {
  test('公开 → 所有已登录用户可读', async () => {
    await reset()
    await mkFolder(1, null, SHARE_SHARED, 1)
    const r = await resolveAccess(900, 1)
    assert.equal(r.mask, PERM_READ)
  })

  test('名单里有人 → 名单内放行，名单外挡住', async () => {
    await reset()
    await mkFolder(1, null, SHARE_SHARED, 0)
    await grant(1, 900, PERM_READ | PERM_WRITE | 4)
    assert.equal((await resolveAccess(900, 1)).mask, 7, '名单内')
    assert.equal((await resolveAccess(902, 1)).mask, 0, '名单外')
  })

  // 回归：祖先设了「不分享」，但这个节点是「分享」，属主明确表态就该生效。
  // 墙只挡继承链，不挡子节点自己的分享态。
  test('祖先不分享不影响分享态子节点', async () => {
    await reset()
    await mkFolder(1, null, SHARE_NONE, 0)
    await mkFolder(2, 1, SHARE_SHARED, 1)
    assert.equal((await resolveAccess(900, 2)).mask, PERM_READ)
  })
})

describe('不分享态（Shared=0）—— 拒绝型边界', () => {
  test('任何人（除属主）都读不到', async () => {
    await reset()
    await mkFolder(1, null, SHARE_NONE, 0)
    await grant(1, 900, 7)
    assert.equal((await resolveAccess(900, 1)).mask, 0)
  })

  test('子树全部被挡，含子树自己的直接授权', async () => {
    await reset()
    await mkFolder(1, null, SHARE_NONE, 0)
    await mkFolder(2, 1, SHARE_INHERIT, 0)
    await grant(2, 900, 7)
    assert.equal((await resolveAccess(900, 2)).mask, 0, '墙要挡住下游的直接授权')
  })

  test('子节点自己设「分享」才能绕过（属主的显式决定）', async () => {
    await reset()
    await mkFolder(1, null, SHARE_NONE, 0)
    await mkFolder(2, 1, SHARE_SHARED, 1)
    assert.equal((await resolveAccess(900, 2)).mask, PERM_READ)
  })
})

describe('继承态（Shared=2）—— 预设语义', () => {
  // 这是本轮修的核心 bug：CTE 用 COALESCE 把「没找到边界」兜底成根，
  // 导致「没人拍板」和「找到了继承态边界」在 ancestor 里同形。
  // 修法是 anc 是否命中（!!anc）单独传下去。
  test('整条链全是继承，没人拍板 → 预设的公开不生效', async () => {
    await reset()
    await mkFolder(1, null, SHARE_INHERIT, 1) // 根目录自己设了公开
    const r = await resolveAccess(900, 1)
    assert.equal(r.mask, 0, '没人拍板时公开只是预设，不该生效')
  })

  test('整条链全是继承，名单也是预设', async () => {
    await reset()
    await mkFolder(1, null, SHARE_INHERIT, 0)
    await mkFolder(2, 1, SHARE_INHERIT, 0)
    await grant(2, 900, 7)
    assert.equal((await resolveAccess(900, 2)).mask, 0, '没人拍板时名单也不生效')
  })

  // 关键正向验证：预设不是删除，是「等上游拍板」。边界一出现就自动生效，
  // 不需要重设任何东西。
  test('上游一旦有人拍板，预设自动生效（无需重设）', async () => {
    await reset()
    await mkFolder(1, null, SHARE_INHERIT, 1) // 根：继承 + 公开
    await mkFolder(2, 1, SHARE_INHERIT, 0)
    assert.equal((await resolveAccess(900, 1)).mask, 0, '先确认没人拍板时是 0')

    // 只改根目录这一处，下游立刻跟着生效
    await sql.run('UPDATE folders SET Shared = 1 WHERE id = 1')
    assert.equal((await resolveAccess(900, 1)).mask, PERM_READ, '根目录拍板后公开生效')
    assert.equal((await resolveAccess(900, 2)).mask, PERM_READ, '子节点跟着继承')
  })

  test('预设的名单同样在上游拍板后生效', async () => {
    await reset()
    await mkFolder(1, null, SHARE_INHERIT, 0)
    await mkFolder(2, 1, SHARE_INHERIT, 0)
    await grant(2, 900, PERM_READ | PERM_WRITE | 4)
    assert.equal((await resolveAccess(900, 2)).mask, 0)

    await sql.run('UPDATE folders SET Shared = 1 WHERE id = 1')
    assert.equal((await resolveAccess(900, 2)).mask, 7, '名单的 7 位在拍板后生效')
  })

  // 回归：祖先是「不分享」时，墙必须挡住下游的直接授权。
  // 之前 decideAncestor 只返回 mask:0，而 `direct | 0` 不改变任何东西，
  // 于是 direct 里的 own 照样并进去，穿墙了。
  test('上游「不分享」时，下游的直接授权被墙挡住', async () => {
    await reset()
    await mkFolder(1, null, SHARE_NONE, 0)
    await mkFolder(2, 1, SHARE_INHERIT, 0)
    await grant(2, 900, 7)
    const r = await resolveAccess(900, 2)
    assert.equal(r.mask, 0, 'mask:0 只是数值，| 0 挡不住 direct，必须显式判 ancestor.mode')
  })

  test('中间段（节点与边界之间的继承态目录）上的授权能被读到', async () => {
    await reset()
    await mkFolder(1, null, SHARE_SHARED, 0)
    await mkFolder(2, 1, SHARE_INHERIT, 0)
    await mkFolder(3, 2, SHARE_INHERIT, 0)
    await grant(2, 900, PERM_READ) // 写在中间的 2 上
    assert.equal((await resolveAccess(900, 3)).mask, PERM_READ, '中间段必须被读到')
  })

  test('中间段上的公开也能被读到', async () => {
    await reset()
    await mkFolder(1, null, SHARE_SHARED, 0)
    await mkFolder(2, 1, SHARE_INHERIT, 1) // 中间这段公开
    await mkFolder(3, 2, SHARE_INHERIT, 0)
    assert.equal((await resolveAccess(900, 3)).mask, PERM_READ)
  })

  test('多级全继承且中途有边界，边界以上被挡住', async () => {
    await reset()
    await mkFolder(1, null, SHARE_SHARED, 1)
    await mkFolder(2, 1, SHARE_SHARED, 1)
    await mkFolder(3, 2, SHARE_INHERIT, 0)
    assert.equal((await resolveAccess(900, 3)).mask, PERM_READ, '最近的边界是 2，它公开了')
  })
})

describe('isPresetActive —— 红点判定用的「预设生效了吗」', () => {
  test('根目录 + 继承 → 没人拍板 → false（根目录算阻止）', async () => {
    await reset()
    await mkFolder(1, null, SHARE_INHERIT, 1)
    assert.equal(await isPresetActive(1), false)
  })

  test('上游是「分享」→ 预设生效', async () => {
    await reset()
    await mkFolder(1, null, SHARE_SHARED, 1)
    await mkFolder(2, 1, SHARE_INHERIT, 0)
    assert.equal(await isPresetActive(2), true)
  })

  // 用户明确要求：上游的边界墙是阻止时红点要点。根目录自身算不算墙
  // 由 depth > 0 排除，所以「根目录设不分享」不影响它自己和子项的判定
  // —— 子项看的是「最近的那个祖先边界」。
  test('上游是「不分享」→ 墙 → 预设不生效', async () => {
    await reset()
    await mkFolder(1, null, SHARE_NONE, 0)
    await mkFolder(2, 1, SHARE_INHERIT, 0)
    assert.equal(await isPresetActive(2), false)
  })

  test('取最近的边界：中间有「分享」时，远处那道墙不算数', async () => {
    await reset()
    await mkFolder(1, null, SHARE_NONE, 0) // 远处是墙
    await mkFolder(2, 1, SHARE_SHARED, 1) // 但这里是分享，就以近的为准
    await mkFolder(3, 2, SHARE_INHERIT, 0)
    assert.equal(await isPresetActive(3), true, '最近的边界是 2（分享）')
  })

  test('节点自己是边界不影响它自己的判定（depth > 0 排除了自身）', async () => {
    await reset()
    await mkFolder(1, null, SHARE_SHARED, 0)
    await mkFolder(2, 1, SHARE_SHARED, 1) // 自己就是边界
    // 2 自己的祖先是 1（分享）→ 生效。虽然它是明确的表态、红点规则本来
    // 也不会点它，但这个方法本身要给出正确的祖先判定。
    assert.equal(await isPresetActive(2), true)
  })

  test('全继承多级 → 没人拍板 → false', async () => {
    await reset()
    await mkFolder(1, null, SHARE_INHERIT, 0)
    await mkFolder(2, 1, SHARE_INHERIT, 0)
    await mkFolder(3, 2, SHARE_INHERIT, 1)
    assert.equal(await isPresetActive(3), false)
  })

  test('不存在的目录 → false（查不到就不打扰）', async () => {
    await reset()
    assert.equal(await isPresetActive(999999), false)
  })

  // 一致性：isPresetActive 为 false 时，resolveAccess 对继承态节点必须给 0。
  // 两者是同一套判定的两种实现（一个轻量一个完整），不一致就会红点骗人。
  test('与 resolveAccess 判定一致（继承态节点）', async () => {
    const cases = [
      { tree: [[1, null, SHARE_INHERIT, 1], [2, 1, SHARE_INHERIT, 0]], want: false },
      { tree: [[1, null, SHARE_SHARED, 1], [2, 1, SHARE_INHERIT, 0]], want: true },
      { tree: [[1, null, SHARE_NONE, 0], [2, 1, SHARE_INHERIT, 0]], want: false },
      { tree: [[1, null, SHARE_SHARED, 0], [2, 1, SHARE_NONE, 0], [3, 2, SHARE_INHERIT, 0]], want: false }
    ]
    for (const c of cases) {
      await reset()
      for (const [id, parent, S, P] of c.tree) await mkFolder(id, parent, S, P)
      const leaf = c.tree[c.tree.length - 1][0]
      const active = await isPresetActive(leaf)
      assert.equal(active, c.want, `目录 ${leaf} 的 presetActive 应为 ${c.want}`)
      const r = await resolveAccess(900, leaf)
      if (!c.want) {
        assert.equal(r.mask, 0, `presetActive=false 时 mask 必须是 0（目录 ${leaf}）`)
      }
    }
  })
})
