// 分享链接判定的集成测试：跑真实的 CTE（复刻自 server/utils/share-link.ts），
// 数据在库副本上现造（tests/helpers/sqlite-fixture.mjs）。
//
// 为什么复刻而不是直接 import：share-link.ts 依赖 Nuxt 自动导入（createError）、
// h3（getRequestURL）和 `~~/` 路径别名，在 node --test 里跑不起来。
// 复刻的是 SQL 与合并逻辑本体，改 share-link.ts 时必须同步改这里 ——
// 每个函数上方都标了对应的源码位置。
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { createShareFixture } from './helpers/sqlite-fixture.mjs'
import {
  normalizeShareLink,
  SHARE_LINK_TOKEN_BYTES,
  SHARE_LINK_LANDING_PATH,
  SHARE_LINK_QUERY_KEY,
  LINK_PERMISSION,
  SHARE_NONE,
  SHARE_SHARED,
  SHARE_INHERIT
} from '../types/share.ts'

let fx
before(async () => { fx = await createShareFixture() })
after(() => fx.close())
beforeEach(() => fx.reset())

/**
 * server/utils/share-link.ts 的 BOUNDARY_CTE。
 *
 * 参数顺序 (?id, ?kind, ?id, ?kind, ?link)。两条种子行**都要**按 kind 过滤 ——
 * 两套 id 序列会撞号，只过滤一条的话另一种节点的行会混进同一个 depth，
 * `depth = b.d` 命中两行，取哪行看返回顺序（这正是下面「撞号」那个用例覆盖的）。
 */
async function linkGrants(link, kind, id) {
  const rows = await fx.all(
    `
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
    `,
    [id, kind, id, kind, link]
  )
  const row = rows[0]
  return !!row && Number(row.shared) !== 0 && Number(row.hasLink) === 1
}

const grantsFile = (link, id) => linkGrants(link, 'file', id)
const grantsFolder = (link, id) => linkGrants(link, 'folder', id)

/** share-link.ts listChildrenByLink：只给继承态的子项 */
async function listChildrenByLink(ownerId, parentId) {
  const folders = (await fx.all(
    'SELECT id, Shared FROM folders WHERE user_id = ? AND parent_id = ? AND Shared = ?',
    [ownerId, parentId, SHARE_INHERIT]
  ))
  const files = (await fx.all(
    'SELECT id, Shared FROM files WHERE user_id = ? AND folder_id = ? AND Shared = ?',
    [ownerId, parentId, SHARE_INHERIT]
  ))
  return {
    folders: folders.map((r) => Number(r.id)),
    files: files.map((r) => Number(r.id))
  }
}

/** share-link.ts listSubtreeByLink：ok 标志随下行走，遇到非继承后代清零 */
async function listSubtreeByLink(ownerId, rootId) {
  const files = await fx.all(
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
  const total = await fx.get(
    `
    WITH RECURSIVE tree(id) AS (
      SELECT id FROM folders WHERE id = ? AND user_id = ?
      UNION ALL
      SELECT f.id FROM folders f JOIN tree ON f.parent_id = tree.id WHERE f.user_id = ?
    )
    SELECT COUNT(*) AS total FROM files fl JOIN tree ON fl.folder_id = tree.id WHERE fl.user_id = ?
    `,
    [rootId, ownerId, ownerId, ownerId]
  )
  return { files, skipped: Math.max(0, Number(total?.total ?? files.length) - files.length) }
}

describe('链接的基本放行', () => {
  test('挂在目录上的链接能访问该目录自身', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    const link = await fx.mkLink('folder', 1)
    assert.equal(await grantsFolder(link, 1), true)
  })

  test('能覆盖继承态的子目录', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_INHERIT })
    await fx.mkFolder({ id: 3, parentId: 2, Shared: SHARE_INHERIT })
    const link = await fx.mkLink('folder', 1)
    assert.equal(await grantsFolder(link, 2), true)
    assert.equal(await grantsFolder(link, 3), true, '要一路传下去，不只是直接子节点')
  })

  test('能覆盖目录里的文件（含多层）', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_INHERIT })
    await fx.mkFile({ id: 10, folderId: 1 })
    await fx.mkFile({ id: 11, folderId: 2 })
    const link = await fx.mkLink('folder', 1)
    assert.equal(await grantsFile(link, 10), true)
    assert.equal(await grantsFile(link, 11), true)
  })

  test('挂在文件上的链接能访问该文件', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    // 文件自己必须是边界（非继承）链接才落在它身上 —— 见下面「继承态的链接是死的」
    await fx.mkFile({ id: 10, folderId: 1, Shared: SHARE_SHARED })
    const link = await fx.mkLink('file', 10)
    assert.equal(await grantsFile(link, 10), true)
  })

  test('文件链接到不了同目录的别的文件', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFile({ id: 10, folderId: 1, Shared: SHARE_SHARED })
    await fx.mkFile({ id: 11, folderId: 1, Shared: SHARE_SHARED })
    const link = await fx.mkLink('file', 10)
    assert.equal(await grantsFile(link, 11), false, '文件链接只对那一个文件生效')
  })

  test('两个 id 撞号时不会串（files.id 与 folders.id 是两套序列）', async () => {
    // 目录 10 上有链接，文件 10 恰好也是同一个数字
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 10, Shared: SHARE_SHARED })
    await fx.mkFile({ id: 10, folderId: 1 })
    const link = await fx.mkLink('folder', 10)
    assert.equal(await grantsFolder(link, 10), true, '目录 10 放行')
    assert.equal(await grantsFile(link, 10), false, '同号文件不该被目录的链接带出来')
  })
})

describe('边界：第一个非继承节点说了算', () => {
  test('子目录是「不分享」→ 墙挡住整棵子树', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_NONE })
    await fx.mkFolder({ id: 3, parentId: 2, Shared: SHARE_INHERIT })
    await fx.mkFile({ id: 30, folderId: 3 })
    const link = await fx.mkLink('folder', 1)
    assert.equal(await grantsFolder(link, 2), false)
    assert.equal(await grantsFolder(link, 3), false, '墙之下全部挡住')
    assert.equal(await grantsFile(link, 30), false)
  })

  test('子目录是「分享」但没有这条链接 → 边界挡住，上层链接穿透不了', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_SHARED })
    const link = await fx.mkLink('folder', 1)
    assert.equal(await grantsFolder(link, 2), false, '2 自己就是边界，它上面有没有链接无关')
  })

  test('文件自己设成「分享」→ 它自己那道边界挡住祖先的链接', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFile({ id: 10, folderId: 1, Shared: SHARE_SHARED })
    await fx.mkFile({ id: 11, folderId: 1, Shared: SHARE_INHERIT })
    const link = await fx.mkLink('folder', 1)
    assert.equal(await grantsFile(link, 10), false, '文件是边界，祖先链接到不了')
    assert.equal(await grantsFile(link, 11), true)
  })

  test('「不分享」挡住的是外来链接，挂在自己身上的链接仍归它自己判', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_NONE })
    const link = await fx.mkLink('folder', 2)
    assert.equal(await grantsFolder(link, 2), false, '不分享是墙，连自己的链接也不放行')
  })
})

describe('根目录是阻止', () => {
  test('整条链全是继承，链接在最底下 → 没人拍板，链接不生效', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_INHERIT })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_INHERIT })
    const link = await fx.mkLink('folder', 2)
    assert.equal(await grantsFolder(link, 2), false, '没人拍板时链接只是预设')
  })

  test('根层文件带链接 → 放行（文件自己是边界）', async () => {
    await fx.mkFile({ id: 10, folderId: null, Shared: SHARE_SHARED })
    const link = await fx.mkLink('file', 10)
    assert.equal(await grantsFile(link, 10), true)
  })

  test('根层文件是继承态 → 没有上游可继承，拒绝', async () => {
    await fx.mkFile({ id: 10, folderId: null, Shared: SHARE_INHERIT })
    const link = await fx.mkLink('file', 10)
    assert.equal(await grantsFile(link, 10), false)
  })

  test('根层目录是继承态时，自己设的链接也是死的', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_INHERIT })
    const link = await fx.mkLink('folder', 1)
    assert.equal(await grantsFolder(link, 1), false)
  })

  // 下面三条把链接的「边界」性质钉死。它和名单/公开的预设语义**不一样**，
  // 所以专门留一组测试说明，免得以后有人按预设那套去理解它。
  //
  // 名单/公开：写在继承节点上 → 预设，等上游有人拍板就自动生效。
  // 链接：    写在继承节点上 → 永远不生效。因为判定只查「第一个非继承节点」，
  //           继承节点自己永远不会被查到，挂在那儿的 token 没人认领。
  test('继承态目录上的链接：上游后来拍板也救不活', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_INHERIT })
    const link = await fx.mkLink('folder', 2)
    assert.equal(await grantsFolder(link, 2), false, '边界是 1，token 在 2 上，没人认领')

    // 把 2 自己改成分享 —— 这才是让它生效的正确做法
    await fx.run('UPDATE folders SET Shared = 1 WHERE id = 2')
    assert.equal(await grantsFolder(link, 2), true, 'token 所在节点自己成为边界后才生效')
  })

  test('边界上的链接对上游是「不分享」免疫（边界不看祖先）', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_NONE })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_SHARED })
    const link = await fx.mkLink('folder', 2)
    assert.equal(await grantsFolder(link, 2), true, '2 是边界，祖先是墙也不影响')
  })

  test('边界上的链接能覆盖其下所有继承后代', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_INHERIT })
    await fx.mkFolder({ id: 3, parentId: 2, Shared: SHARE_INHERIT })
    const link = await fx.mkLink('folder', 1)
    assert.equal(await grantsFolder(link, 2), true)
    assert.equal(await grantsFolder(link, 3), true)
  })
})

describe('无效链接一律拒绝', () => {
  test('库里没有的 token', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    assert.equal(await grantsFolder('a'.repeat(32), 1), false)
  })

  test('形状不对的 token 连库都不用查（normalizeShareLink 挡掉）', () => {
    assert.equal(normalizeShareLink('short'), null)
    assert.equal(normalizeShareLink(''), null)
    assert.equal(normalizeShareLink(null), null)
    assert.equal(normalizeShareLink(undefined), null)
    assert.equal(normalizeShareLink(123), null, '数字不是字符串')
    assert.equal(normalizeShareLink('a'.repeat(31)), null, '少一位')
    assert.equal(normalizeShareLink('a'.repeat(33)), null, '多一位')
    assert.equal(normalizeShareLink('g'.repeat(32)), null, '非 hex 字符')
    assert.equal(normalizeShareLink('A'.repeat(32)), null, '大写不是合法 token，不做大小写兜底')
    assert.equal(normalizeShareLink('a'.repeat(100000)), null, '超长串挡掉，别拿它当缓冲区')
  })

  test('合法 token 会 trim 掉首尾空白（复制粘贴常带）', () => {
    assert.equal(normalizeShareLink(`  ${'a'.repeat(32)}\n`), 'a'.repeat(32))
  })

  test('token 长度 = SHARE_LINK_TOKEN_BYTES × 2', () => {
    assert.equal(SHARE_LINK_TOKEN_BYTES, 16)
    assert.equal('a'.repeat(SHARE_LINK_TOKEN_BYTES * 2).length, 32)
  })

  test('链接权限锁死读 + 下载', () => {
    assert.equal(LINK_PERMISSION, 1 | 8)
    assert.equal(LINK_PERMISSION, 9)
  })

  /**
   * 服务端 buildShareLinkUrl 拼的形态：`<origin>/?share_link=<token>`。
   * 这里只断言后半段（origin 由运行时决定，测试里固定掉没意义），
   * 但形态必须与前端 index.vue 解析 query 的方式对得上。
   */
  test('落地地址形态与前端解析对得上', () => {
    const link = 'a'.repeat(32)
    const qs = new URLSearchParams({ [SHARE_LINK_QUERY_KEY]: link })
    assert.equal(SHARE_LINK_LANDING_PATH, '/')
    assert.equal(`${SHARE_LINK_LANDING_PATH}?${qs}`, `/?share_link=${link}`)
  })
})

describe('链接视角的子项列表', () => {
  test('只给继承态的子节点，非继承的被当边界挡掉', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_INHERIT })
    await fx.mkFolder({ id: 3, parentId: 1, Shared: SHARE_NONE })
    await fx.mkFolder({ id: 4, parentId: 1, Shared: SHARE_SHARED })
    await fx.mkFile({ id: 10, folderId: 1, Shared: SHARE_INHERIT })
    await fx.mkFile({ id: 11, folderId: 1, Shared: SHARE_NONE })
    const listed = await listChildrenByLink(fx.OWNER, 1)
    assert.deepEqual(listed.folders, [2], '继承的留下，不分享/分享的挡掉')
    assert.deepEqual(listed.files, [10])
  })
})

describe('链接视角的整棵子树（整包下载清单）', () => {
  test('范围内全给，skipped 为 0', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_INHERIT })
    await fx.mkFile({ id: 10, folderId: 1, fileSize: 100 })
    await fx.mkFile({ id: 11, folderId: 2, fileSize: 200 })
    const r = await listSubtreeByLink(fx.OWNER, 1)
    assert.deepEqual(r.files.map((f) => Number(f.id)), [10, 11])
    assert.equal(r.skipped, 0)
  })

  test('墙之下的文件被排除，skipped 正确计数', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_NONE })
    await fx.mkFile({ id: 10, folderId: 1 })
    await fx.mkFile({ id: 20, folderId: 2 })
    await fx.mkFile({ id: 21, folderId: 2 })
    const r = await listSubtreeByLink(fx.OWNER, 1)
    assert.deepEqual(r.files.map((f) => Number(f.id)), [10])
    assert.equal(r.skipped, 2, '墙下的两个都要报数，否则前端只会说「文件夹为空」')
  })

  test('文件自己是非继承的也要排除', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFile({ id: 10, folderId: 1, Shared: SHARE_INHERIT })
    await fx.mkFile({ id: 11, folderId: 1, Shared: SHARE_SHARED })
    const r = await listSubtreeByLink(fx.OWNER, 1)
    assert.deepEqual(r.files.map((f) => Number(f.id)), [10])
    assert.equal(r.skipped, 1)
  })

  test('relDir 保留相对路径（zip 里的目录结构靠它）', async () => {
    await fx.mkFolder({ id: 1, name: 'root', Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 2, parentId: 1, name: 'sub', Shared: SHARE_INHERIT })
    await fx.mkFolder({ id: 3, parentId: 2, name: 'deep', Shared: SHARE_INHERIT })
    await fx.mkFile({ id: 10, folderId: 3, filename: 'a.txt' })
    const r = await listSubtreeByLink(fx.OWNER, 1)
    assert.equal(r.files[0].relDir, 'sub/deep')
  })

  test('ok 标志会穿透：墙之下再深也回不来', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 2, parentId: 1, Shared: SHARE_NONE })
    await fx.mkFolder({ id: 3, parentId: 2, Shared: SHARE_INHERIT })
    await fx.mkFolder({ id: 4, parentId: 3, Shared: SHARE_INHERIT })
    await fx.mkFile({ id: 40, folderId: 4 })
    const r = await listSubtreeByLink(fx.OWNER, 1)
    assert.equal(r.files.length, 0)
    assert.equal(r.skipped, 1)
  })
})

describe('链接的增删', () => {
  test('一个节点可以挂多个链接，互不影响', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    const a = await fx.mkLink('folder', 1)
    const b = await fx.mkLink('folder', 1)
    assert.notEqual(a, b, 'token 不能撞')
    assert.equal(await grantsFolder(a, 1), true)
    assert.equal(await grantsFolder(b, 1), true)

    // 精确撤销其中一个，另一个仍可用 —— 按目标整体替换做不到这点
    await fx.rmLink(a)
    assert.equal(await grantsFolder(a, 1), false)
    assert.equal(await grantsFolder(b, 1), true, '撤 A 不能误伤 B')
  })

  test('目标删掉后链接一起消失（触发器级联）', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    const link = await fx.mkLink('folder', 1)
    await fx.run('DELETE FROM folders WHERE id = 1')
    const rows = await fx.all('SELECT link FROM share_links WHERE link = ?', [link])
    assert.equal(rows.length, 0, '孤儿 token 留着等于给攻击者留一把没用的钥匙')
  })

  test('删文件也会清掉挂在它上面的链接', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFile({ id: 10, folderId: 1 })
    const link = await fx.mkLink('file', 10)
    await fx.run('DELETE FROM files WHERE id = 10')
    assert.equal((await fx.all('SELECT link FROM share_links WHERE link = ?', [link])).length, 0)
  })

  test('删目录只清自己的链接，别人的不动', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 2, Shared: SHARE_SHARED })
    const gone = await fx.mkLink('folder', 1)
    const kept = await fx.mkLink('folder', 2)
    await fx.run('DELETE FROM folders WHERE id = 1')
    assert.equal((await fx.all('SELECT link FROM share_links WHERE link = ?', [gone])).length, 0)
    assert.equal((await grantsFolder(kept, 2)), true, '精确按 target_type + target_id 清，不误伤')
  })

  test('UNIQUE(link) 挡住重复 token', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await fx.mkLink('folder', 1, 'b'.repeat(32))
    await assert.rejects(
      () => fx.mkLink('folder', 1, 'b'.repeat(32)),
      /UNIQUE|constraint/i,
      '同 token 插两次必须失败，否则两条链接指向不同目标'
    )
  })

  test('target_type 有 CHECK，脏值进不来', async () => {
    await fx.mkFolder({ id: 1, Shared: SHARE_SHARED })
    await assert.rejects(() => fx.mkLink('dir', 1), /CHECK|constraint/i)
  })
})
