// 分享链接**前端接线**所依赖的服务端语义，外加两条入口隔离不变量。
//
// 与 share-link.test.mjs 的分工：那边测的是「链接能不能覆盖某节点」
// （判定本身）；这里测的是**前端据此做的决定**成立 ——
//   1. resolve 的三态：什么该删本地存储、什么必须留
//   2. 两条入口隔离：用户入口看不到只能靠链接到的内容，反之亦然
//   3. paste 的 link 分支：链接只授权读源，绝不授权写进属主的树
//   4. 红点/图标认得出「有链接」和「链接是死的」
//
// 同样是复刻（见文件头与 tests/README.md 的说明）。
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { createShareFixture, OWNER, VISITOR } from './helpers/sqlite-fixture.mjs'
import {
  normalizeShareLink,
  linkActiveFromShareMode,
  shareDotReason,
  shouldShowPresetDot,
  shareDotTitle,
  SHARE_NONE,
  SHARE_SHARED,
  SHARE_INHERIT,
  PERM_READ,
  PERM_DOWNLOAD
} from '../types/share.ts'

let fx
before(async () => { fx = await createShareFixture() })
after(() => fx.close())
beforeEach(() => fx.reset())

/* ------------------------------------------------------------------ *
 * 1. resolve 的三态
 *
 * 复刻 server/api/share/link/resolve.get.ts 的判定顺序：
 *   findLinkRow → 有吗？没有就 404
 *   readTargetOwnerId → 目标还在吗？没了也 404
 *   linkGrants* → active
 * 前两步的 404 就是前端「从本地存储删掉」的唯一依据，所以必须钉死：
 * **只有这两种情况返回 404，active:false 不是 404。**
 * ------------------------------------------------------------------ */

const BOUNDARY_CTE = `
  WITH RECURSIVE up(kind, id, parent_id, shared, depth) AS (
    SELECT 'file', id, folder_id, Shared, 0 FROM files WHERE id = ? AND ? = 'file'
    UNION ALL
    SELECT 'folder', id, parent_id, Shared, 0 FROM folders WHERE id = ? AND ? = 'folder'
    UNION ALL
    SELECT 'folder', f.id, f.parent_id, f.Shared, up.depth + 1
    FROM up JOIN folders f ON f.id = up.parent_id
  ),
  boundary AS (SELECT MIN(depth) AS d FROM up WHERE shared IN (0, 1))
  SELECT u.kind AS kind, u.shared AS shared,
    EXISTS (
      SELECT 1 FROM share_links sl
      WHERE sl.link = ? AND sl.target_type = u.kind AND sl.target_id = u.id
    ) AS hasLink
  FROM up u, boundary b
  WHERE u.depth = b.d
`

/**
 * resolve.get.ts 的等价体。
 *
 * **无效也返回 200**，结论放在 `valid` 字段里 —— 复刻的是这个契约，
 * 不是 HTTP 状态码。服务端为什么这么设计见 resolve.get.ts 的注释。
 */
async function resolveLink(link) {
  const row = await fx.get(
    'SELECT id, target_type AS targetType, target_id AS targetId FROM share_links WHERE link = ?',
    [link]
  )
  if (!row) return { http: 200, valid: false, reason: 'token_not_found' }
  const table = row.targetType === 'file' ? 'files' : 'folders'
  const owner = await fx.get(`SELECT id FROM ${table} WHERE id = ?`, [row.targetId])
  if (!owner) return { http: 200, valid: false, reason: 'target_gone' }
  const nameCol = row.targetType === 'file' ? 'filename' : 'name'
  const target = await fx.get(`SELECT ${nameCol} AS name FROM ${table} WHERE id = ?`, [row.targetId])

  const rows = await fx.all(BOUNDARY_CTE, [
    row.targetId, row.targetType, row.targetId, row.targetType, link
  ])
  const r = rows[0]
  const active = !!r && Number(r.shared) !== 0 && Number(r.hasLink) === 1
  return {
    http: 200, valid: true, active, name: String(target?.name ?? ''),
    targetType: row.targetType, targetId: Number(row.targetId)
  }
}

/**
 * useShareLinks.verifyLink 的判定表复刻。**只认 valid === false 才删**。
 *
 * 这是前端唯一会删用户收藏的地方，删了找不回来，所以规则要能被测试钉住。
 */
function shouldPruneLink(outcome) {
  if (outcome instanceof Error) return false   // 抛异常：这次没问成，不删
  return outcome?.valid === false
}

describe('resolve 的三态（决定前端删不删本地存储）', () => {
  test('分享态目录上的链接：200 + active:true + 目标名', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED, name: '资料' })
    const link = await fx.mkLink('folder', 1)
    const res = await resolveLink(link)
    assert.equal(res.http, 200)
    assert.equal(res.valid, true)
    assert.equal(res.active, true)
    assert.equal(res.name, '资料', '侧栏要显示名字')
    assert.equal(res.targetType, 'folder')
    assert.equal(res.targetId, 1)
  })

  test('文件链接同样返回文件名', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFile({ id: 10, folderId: 1, Shared: SHARE_SHARED, filename: '报告.pdf' })
    const link = await fx.mkLink('file', 10)
    const res = await resolveLink(link)
    assert.equal(res.http, 200)
    assert.equal(res.valid, true)
    assert.equal(res.active, true)
    assert.equal(res.name, '报告.pdf')
  })

  /**
   * 这一条是整个「明确无效才删」规则的支点。
   *
   * 继承态下的链接是死链：链接和目标都在，但判定会往上找非继承祖先，
   * 那个祖先身上没有这条 token → 拒绝。它**必须**是 200/active:false，
   * 不能是 404 —— 属主把上游改成「分享」之后链接就好了，
   * 这时候把访客侧栏里的条目删掉是破坏性的、不可恢复的。
   */
  test('死链是 200 + active:false，不是 404', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_INHERIT })
    const link = await fx.mkLink('folder', 1)
    const res = await resolveLink(link)
    assert.equal(res.http, 200)
    assert.equal(res.valid, true, '必须 valid=true —— valid=false 会让前端删掉收藏')
    assert.equal(res.active, false)
    assert.equal(res.name, 'f1', '名字照样要返回，侧栏要显示它')
    assert.equal(shouldPruneLink(res), false, '死链不能被删')
  })

  test('被「不分享」墙挡住的链接也是 active:false，不是 404', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_NONE })
    const link = await fx.mkLink('folder', 1)
    const res = await resolveLink(link)
    assert.equal(res.valid, true)
    assert.equal(res.active, false)
    assert.equal(shouldPruneLink(res), false)
  })

  test('token 不存在 → 200 + valid:false（前端据此删）', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    const res = await resolveLink('f'.repeat(32))
    assert.equal(res.http, 200, '「无效」是 body 里的字段，不是状态码')
    assert.equal(res.valid, false)
    assert.equal(res.reason, 'token_not_found')
    assert.equal(shouldPruneLink(res), true)
  })

  test('链接行还在但目标已被删 → 404', async () => {
    // 绕过触发器直接插，模拟「外键没开」的退化情形
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.run('INSERT INTO share_links (link, target_type, target_id) VALUES (?, ?, ?)', [
      'a'.repeat(32), 'folder', 999
    ])
    const res = await resolveLink('a'.repeat(32))
    assert.equal(res.valid, false)
    assert.equal(res.reason, 'target_gone', '与「被撤销」区分开：提示语不同')
    assert.equal(shouldPruneLink(res), true)
  })

  test('已撤销的链接 → 404', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    const link = await fx.mkLink('folder', 1)
    await fx.rmLink(link)
    const res = await resolveLink(link)
    assert.equal(res.valid, false)
    assert.equal(shouldPruneLink(res), true)
  })

  /**
   * 畸形 token 在**中间件**那一层就被挡掉，压根不进 handler。
   *
   * 实测（dev server，匿名）：`?link=zzz` / 不带 link / 33 位 / SQL 注入
   * 四种都是 **401**，不是 400 —— 因为中间件的白名单条件是
   * `LINK_PUBLIC_PATHS.has(path) && normalizeShareLink(link)`，
   * 形状不合法就不放行，于是落到 requireAuth。
   *
   * 这个结果是对的：前端「明确无效才删」的那条规则里，**401 不算无效**
   * （它只说明「这次没拿到凭据」，可能是没登录），所以不会误删收藏。
   * 实测确认过这一点，比在测试里断言一个推演出来的 400 更可靠。
   */
  /**
   * 误删是这里最坏的一种失败：用户的本地收藏删掉就找不回来了。
   *
   * 这组用例钉住「只有 valid === false 才删」—— 特别是**任何异常都不删**。
   * 之前那版是「statusCode === 404 就删」，而 404 能来自网关、代理、上层兜底、
   * 一次数据库抖动。只要响应是 404，用户的东西就没了，而服务端并没说过什么。
   */
  describe('判定表：什么情况下才删本地收藏', () => {
    test('五种情况里只有两种该删', () => {
      const table = [
        { name: '有效链接', outcome: { valid: true, active: true }, prune: false },
        { name: '死链（覆盖不到）', outcome: { valid: true, active: false }, prune: false },
        { name: 'token 不存在/被撤销', outcome: { valid: false, reason: 'token_not_found' }, prune: true },
        { name: '目标已删', outcome: { valid: false, reason: 'target_gone' }, prune: true },
        { name: '请求失败（5xx/超时/断网）', outcome: new Error('boom'), prune: false }
      ]
      for (const c of table) {
        assert.equal(shouldPruneLink(c.outcome), c.prune, `${c.name} 的判定不对`)
      }
    })

    test('异常一律不删 —— 这次没问成 ≠ 链接坏了', () => {
      for (const e of [new Error('500'), new Error('timeout'), new Error('network')]) {
        assert.equal(shouldPruneLink(e), false)
      }
    })

    test('404/410 这类状态码不参与判断', () => {
      // 模拟「服务端其实什么都没说，只是响应码是 404」的情况
      assert.equal(shouldPruneLink({ http: 404 }), false,
        '没有 valid 字段就说明结论缺失，不能当作无效')
      assert.equal(shouldPruneLink({ statusCode: 404, valid: undefined }), false)
      assert.equal(shouldPruneLink({ statusCode: 500 }), false)
      assert.equal(shouldPruneLink({ statusCode: 410 }), false)
      // 只有明确的 valid === false 才删，哪怕同时带着各种状态码
      assert.equal(shouldPruneLink({ statusCode: 200, valid: false }), true)
    })

    test('valid 为 undefined（老服务端/字段缺失）按不删处理', () => {
      assert.equal(shouldPruneLink({}), false, '拿不到结论就不要动手')
      assert.equal(shouldPruneLink({ valid: null }), false)
    })
  })

  test('畸形 token 不被 normalizeShareLink 认可 → 中间件不放行 → 401 而非 404', () => {
    assert.equal(normalizeShareLink('zzz'), null)
    assert.equal(normalizeShareLink('a'.repeat(31)), null)
    assert.equal(normalizeShareLink('A'.repeat(32)), null, '不 lowercase，形状不对就拒')
    assert.equal(normalizeShareLink('a'.repeat(32)), 'a'.repeat(32))
    assert.equal(normalizeShareLink(`' OR 1=1--`), null, 'SQL 片段过不了形状校验')
  })
})

/* ------------------------------------------------------------------ *
 * 2. 两条入口隔离
 *
 * 用户要求：链接在侧栏里一链接一行，不与用户合并；
 * 「用户入口下看不到链接的文件，链接入口下没有非链接授权的文件」。
 * 两条都要有测试保护 —— 代码上已成立，但没有测试的话下次重构很容易破。
 * ------------------------------------------------------------------ */

/**
 * share/people.get.ts 的 SQL（复刻）：谁能出现在「分享给我的人」侧栏里。
 *
 * 关键：候选集来自 folder_access / file_access / IsPublic，
 * **完全没有 share_links**。所以只挂链接、没公开也没授权的内容天然不在其中。
 */
async function peopleWithContentFor(visitorId) {
  const rows = await fx.all(
    `
    SELECT f.id, f.name, 'folder' AS kind FROM folders f
    WHERE f.IsPublic = 1
       OR EXISTS (SELECT 1 FROM folder_access fa WHERE fa.folder_id = f.id AND fa.user_id = ?)
    UNION ALL
    SELECT fl.id, fl.filename, 'file' AS kind FROM files fl
    WHERE fl.IsPublic = 1
       OR EXISTS (SELECT 1 FROM file_access ga WHERE ga.file_id = fl.id AND ga.user_id = ?)
    `,
    [visitorId, visitorId]
  )
  return rows.map((r) => `${r.kind}:${Number(r.id)}`)
}

/** share-link.ts listChildrenByLink：只给继承态的子项 */
async function listChildrenByLink(ownerId, parentId) {
  const folders = await fx.all(
    'SELECT id FROM folders WHERE user_id = ? AND parent_id = ? AND Shared = ?',
    [ownerId, parentId, SHARE_INHERIT]
  )
  const files = await fx.all(
    'SELECT id FROM files WHERE user_id = ? AND folder_id = ? AND Shared = ?',
    [ownerId, parentId, SHARE_INHERIT]
  )
  return {
    folders: folders.map((r) => Number(r.id)),
    files: files.map((r) => Number(r.id))
  }
}

describe('用户入口与链接入口互相不可见', () => {
  test('只挂链接、没公开也没授权 → 不出现在「分享给我的人」里', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_INHERIT })
    await fx.mkLink('folder', 1)
    // 目录 2 对访客没有任何按人授权，也没公开
    const visible = await peopleWithContentFor(VISITOR)
    assert.equal(visible.includes('folder:2'), false,
      '链接不是授权。把它算进用户入口等于绕过链接的边界判定')
    assert.equal(visible.length, 0, '整棵树都不该出现在用户入口')
  })

  test('链接挂在文件上、该文件没授权 → 也不进用户入口', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFile({ id: 10, folderId: 1, Shared: SHARE_INHERIT })
    await fx.mkLink('file', 10)
    const visible = await peopleWithContentFor(VISITOR)
    assert.equal(visible.includes('file:10'), false)
  })

  test('公开的内容不进链接入口（除非它自己就是继承态）', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    // 公开 + 非继承 = 它自己那道边界，链接到不了
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_SHARED, IsPublic: 1 })
    await fx.mkLink('folder', 1)
    const children = await listChildrenByLink(OWNER, 1)
    assert.equal(children.folders.includes(2), false,
      '「链接入口下没有非链接授权文件/文件夹」——非继承节点一律不进')
    // 而用户入口里它在（公开对所有已登录用户可读）
    assert.equal((await peopleWithContentFor(VISITOR)).includes('folder:2'), true)
  })

  test('直接授权给访客但非继承的目录，同样不进链接入口', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_SHARED })
    await fx.grantFolder(2, VISITOR, PERM_READ | PERM_DOWNLOAD)
    await fx.mkLink('folder', 1)
    assert.equal((await listChildrenByLink(OWNER, 1)).folders.includes(2), false)
    assert.equal((await peopleWithContentFor(VISITOR)).includes('folder:2'), true)
  })

  test('两个入口看到的是两批不同的东西，各自定义成立', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_INHERIT })       // 仅链接可达
    await fx.mkFolder({ id: 3, parentId: 1, Shared: SHARE_SHARED, IsPublic: 1 }) // 仅用户入口可达
    const link = await fx.mkLink('folder', 1)

    const viaLink = await listChildrenByLink(OWNER, 1)
    const viaUser = await peopleWithContentFor(VISITOR)
    assert.equal(viaLink.folders.includes(2), true)
    assert.equal(viaLink.folders.includes(3), false)
    assert.equal(viaUser.includes('folder:3'), true)
    assert.equal(viaUser.includes('folder:2'), false)
    assert.equal(await fx.get('SELECT link FROM share_links WHERE link = ?', [link]) !== null, true)
  })
})

/* ------------------------------------------------------------------ *
 * 3. paste 的 link 分支
 *
 * 复刻 paste.post.ts 的 link 源解析 + listSubtreeByLink 收集，
 * 以及「目标目录判定不变」这条安全边界。
 * ------------------------------------------------------------------ */

/** paste.post.ts 的链接分支：逐个验 token 能不能覆盖，缺一个就整体拒绝 */
async function resolveLinkSources(link, folderIds, fileIds) {
  const target = await fx.get(
    'SELECT target_id AS targetId FROM share_links WHERE link = ? AND target_type = ?',
    [link, 'folder']
  )
  if (!target) return { ok: false, message: '链接无效' }
  const ownerId = OWNER
  const okFolders = []
  for (const id of folderIds) {
    if (!(await grantsFolder(link, id))) continue
    const row = await fx.get('SELECT id FROM folders WHERE id = ? AND user_id = ?', [id, ownerId])
    if (row) okFolders.push(Number(row.id))
  }
  const okFiles = []
  for (const id of fileIds) {
    if (!(await grantsFile(link, id))) continue
    const row = await fx.get('SELECT id FROM files WHERE id = ? AND user_id = ?', [id, ownerId])
    if (row) okFiles.push(Number(row.id))
  }
  if (okFolders.length !== folderIds.length || okFiles.length !== fileIds.length) {
    return { ok: false, message: '部分内容不存在，或不在该分享链接的范围内' }
  }
  return { ok: true, okFolders, okFiles, ownerId }
}

/** BOUNDARY_CTE 的薄封装，与 share-link.test.mjs 同源 */
async function linkGrants(link, kind, id) {
  const rows = await fx.all(BOUNDARY_CTE, [id, kind, id, kind, link])
  const row = rows[0]
  return !!row && Number(row.shared) !== 0 && Number(row.hasLink) === 1
}
const grantsFile = (link, id) => linkGrants(link, 'file', id)
const grantsFolder = (link, id) => linkGrants(link, 'folder', id)

/** share-link.ts listSubtreeByLink */
async function listSubtreeByLink(ownerId, rootId) {
  return fx.all(
    `
    WITH RECURSIVE tree(id, name, rel_dir, ok) AS (
      SELECT id, name, '' AS rel_dir, 1 FROM folders WHERE id = ? AND user_id = ?
      UNION ALL
      SELECT f.id, f.name,
             CASE WHEN tree.rel_dir = '' THEN f.name ELSE tree.rel_dir || '/' || f.name END,
             CASE WHEN tree.ok = 0 OR f.Shared IN (0, 1) THEN 0 ELSE 1 END
      FROM folders f JOIN tree ON f.parent_id = tree.id
      WHERE f.user_id = ?
    )
    SELECT tree.rel_dir AS relDir, fl.id AS id, fl.filename AS filename
    FROM tree JOIN files fl ON fl.folder_id = tree.id
    WHERE fl.user_id = ? AND tree.ok = 1 AND fl.Shared = ?
    ORDER BY relDir, filename
    `,
    [rootId, ownerId, ownerId, ownerId, SHARE_INHERIT]
  )
}

describe('paste 的 link 分支：只授权读源', () => {
  test('链接能复制范围内的条目', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_INHERIT })
    await fx.mkFile({ id: 10, folderId: 1 })
    await fx.mkFile({ id: 11, folderId: 2 })
    const link = await fx.mkLink('folder', 1)
    const res = await resolveLinkSources(link, [2], [10, 11])
    assert.equal(res.ok, true)
    assert.deepEqual(res.okFolders, [2])
    assert.deepEqual(res.okFiles.sort(), [10, 11])
  })

  test('墙后面的目录复制不了（整体拒绝，不做部分成功）', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_SHARED }) // 自己那道边界
    await fx.mkFile({ id: 10, folderId: 1 })
    const link = await fx.mkLink('folder', 1)
    const res = await resolveLinkSources(link, [1, 2], [])
    assert.equal(res.ok, false, '少一个就整体拒，否则会出现「搬了一半」的中间态')
    assert.match(res.message, /不在该分享链接的范围内/)
  })

  test('非继承文件复制不了', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFile({ id: 10, folderId: 1, Shared: SHARE_SHARED })
    const link = await fx.mkLink('folder', 1)
    assert.equal((await resolveLinkSources(link, [], [10])).ok, false)
  })

  test('不属于链接属主的 id 拒绝（id 撞号也挡住）', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED, ownerId: OWNER })
    await fx.mkFolder({ id: 2, Shared: SHARE_INHERIT, ownerId: VISITOR })
    const link = await fx.mkLink('folder', 1)
    // 目录 2 在访客树下、id 与链接目标同号。linkGrants 会因为边界判定拒绝它，
    // 即便判定放过，findOwnedById(OWNER, 2) 也取不到行
    const res = await resolveLinkSources(link, [2], [])
    assert.equal(res.ok, false)
  })

  test('死链什么都复制不了', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_INHERIT })
    const link = await fx.mkLink('folder', 1)
    assert.equal((await resolveLinkSources(link, [1], [])).ok, false)
  })

  test('子树收集复用 listSubtreeByLink，墙后的文件不会被带走', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED, name: 'root' })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_INHERIT, name: 'in' })
    await fx.mkFolder({ id: 3, parentId: 2, Shared: SHARE_SHARED, name: 'wall' })
    await fx.mkFolder({ id: 4, parentId: 3, Shared: SHARE_INHERIT, name: 'behind' })
    await fx.mkFile({ id: 10, folderId: 1, filename: 'a.txt' })
    await fx.mkFile({ id: 11, folderId: 2, filename: 'b.txt' })
    await fx.mkFile({ id: 12, folderId: 4, filename: 'secret.txt' })

    const rows = await listSubtreeByLink(OWNER, 1)
    const ids = rows.map((r) => Number(r.id)).sort((x, y) => x - y)
    assert.deepEqual(ids, [10, 11], '墙后的 secret.txt 不能被复制走')
    const relDirs = rows.map((r) => String(r.relDir))
    assert.equal(relDirs.includes('in/wall/behind'), false)
    assert.equal(relDirs.includes('in'), true)
  })

  /**
   * 已知取舍，写成测试钉住：listSubtreeByLink 只 JOIN files、不返回目录，
   * 所以链接视角复制**会丢空目录**。整包下载同样丢，是既有行为。
   */
  test('链接复制丢空目录（已知取舍，与整包下载一致）', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED, name: 'root' })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_INHERIT, name: 'empty' })
    await fx.mkFile({ id: 10, folderId: 1, filename: 'a.txt' })
    const rows = await listSubtreeByLink(OWNER, 1)
    assert.equal(rows.length, 1)
    assert.equal(rows.some((r) => String(r.relDir) === 'empty'), false,
      '空目录不在清单里 → 复制后不会重建。这是有意的，不是 bug')
  })

  test('目标目录判定与链接无关：paste 的目标仍走正常写权限', async () => {
    // 链接只换「源」的解析。目标目录那一行代码没动过，
    // 这里验证前提成立：findAccessibleById 的写权限判定对链接没有捷径
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED, ownerId: OWNER })
    const link = await fx.mkLink('folder', 1)
    // 属主的目录对访客没有写权限
    const access = await fx.get(
      'SELECT COUNT(*) AS n FROM folder_access WHERE folder_id = 1 AND user_id = ?',
      [VISITOR]
    )
    assert.equal(Number(access.n), 0, '访客对属主目录没有任何按人授权 → 目标判定会拒')
    assert.equal(await grantsFolder(link, 1), true, '但源是可读的 —— 读源与写目标分开判')
  })
})

/* ------------------------------------------------------------------ *
 * 4. 图标与红点
 *
 * 左上角 link 标：linkCount > 0。
 * 红点：linkCount > 0 且自己不是分享态 → reason='link'。
 * ------------------------------------------------------------------ */

describe('link 图标与红点', () => {
  test('linkActiveFromShareMode：只有分享态才有效', () => {
    assert.equal(linkActiveFromShareMode(SHARE_SHARED), true)
    assert.equal(linkActiveFromShareMode(SHARE_INHERIT), false, '继承态是预设，不生效')
    assert.equal(linkActiveFromShareMode(SHARE_NONE), false, '自己就是墙')
    assert.equal(linkActiveFromShareMode(null), false, '缺失按继承（fail-closed）')
    assert.equal(linkActiveFromShareMode(undefined), false)
  })

  test('分享态 + 有链接 → 有图标、无红点', () => {
    assert.equal(shouldShowPresetDot({
      Shared: SHARE_SHARED, linkCount: 1, presetActive: true
    }), false)
  })

  test('继承态 + 有链接 → 图标 + 红点（reason=link）', () => {
    const r = shareDotReason({ Shared: SHARE_INHERIT, linkCount: 1 })
    assert.equal(r, 'link')
  })

  test('不分享态 + 有链接 → 也要红点（锁角标只说「不给看」，没说链接打不开）', () => {
    assert.equal(shareDotReason({ Shared: SHARE_NONE, linkCount: 1 }), 'link')
  })

  test('linkCount 为 0 → 不因链接亮红点（原有预设判定不受影响）', () => {
    assert.equal(shareDotReason({ Shared: SHARE_INHERIT, linkCount: 0 }), null)
  })

  test('没有链接但名单没生效 → reason 仍是 preset（老行为没变）', () => {
    assert.equal(
      shareDotReason({
        Shared: SHARE_INHERIT, grantCount: 1, IsPublic: false, presetActive: false
      }),
      'preset'
    )
  })

  test('两种原因的悬浮文案不同', () => {
    assert.notEqual(shareDotTitle('link'), shareDotTitle('preset'))
    assert.match(shareDotTitle('link'), /分享链接/)
    assert.match(shareDotTitle('preset'), /你设置的分享/)
  })

  /**
   * 悬浮文案只对属主显示（FileList 用 showShareBadge 门控），所以两条都要
   * 落在「怎么改能生效」上 —— 原来那条把「预设」「拍板」这类实现细节漏给了用户。
   */
  test('死链的悬浮文案说的是「怎么改」而不是「为什么」', () => {
    const t = shareDotTitle('link')
    assert.match(t, /设为「分享」/, '得给出可操作的下一步')
    for (const jargon of ['预设', '拍板', '节点', '继承态下']) {
      assert.equal(t.includes(jargon), false, `不该把「${jargon}」漏给用户`)
    }
  })

  test('名单预设的悬浮文案也不含实现细节', () => {
    const t = shareDotTitle('preset')
    assert.match(t, /上级目录/, '要说清往哪找')
    assert.equal(t.includes('拍板'), false)
  })

  test('linkCount 缺失按 0 处理（老接口不返回它时不能凭空亮红点）', () => {
    assert.equal(shareDotReason({ Shared: SHARE_INHERIT }), null)
    assert.equal(shareDotReason({ Shared: SHARE_INHERIT, linkCount: null }), null)
  })

  test('「不分享」的既有判定不受影响', () => {
    assert.equal(shareDotReason({ Shared: SHARE_NONE, linkCount: 0 }), null)
    assert.equal(shareDotReason({ Shared: SHARE_SHARED, IsPublic: true, linkCount: 0 }), null)
  })
})