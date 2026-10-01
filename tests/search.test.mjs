// server/utils/search.ts 的搜索行为 + 搜索链路的接线（源码断言）。
//
// 为什么 SQL 是复刻：server/utils/search.ts 依赖 Nuxt 的路径别名（~~/），
// 在 node --test 下 import 不了（见 tests/helpers/sqlite-fixture.mjs 开头的说明）。
// 所以下面是**逐字复制**的查询，源位置标在每个函数上方。
// 算法一旦改动，两边都要改 —— 这是本项目所有集成测试的共同取舍。
//
// 数据用 sqlite 副本造（夹具），绝不碰开发库。
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { createShareFixture, OWNER, VISITOR } from './helpers/sqlite-fixture.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

/** 去掉注释，用于「源码里有没有某个写法」的断言（注释里提到常量名是常事） */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

// 复刻 server/utils/file.ts:13 的 escapeLike。
// 注意 '\\$1' 在 JS 字面量里就是「反斜杠 + 捕获组」，与源码逐字一致。
const escapeLike = (input) => input.replace(/([%_\\])/g, '\\$1')

const likePattern = (keyword) => `%${escapeLike(keyword)}%`

const LIMIT = 50

/**
 * 复刻 server/utils/search.ts 的 searchFolders。
 * 源位置：server/utils/search.ts 的 `WITH RECURSIVE hits AS (...)` 那段。
 */
async function searchFolders(fx, keyword, ownerId, limit = LIMIT) {
  const scoped = ownerId === null ? '' : 'AND f.user_id = ?'
  const args = [likePattern(keyword)]
  if (ownerId !== null) args.push(ownerId)
  args.push(limit + 1)

  const rows = await fx.all(
    `
      WITH RECURSIVE hits AS (
        SELECT f.id AS hitId, f.user_id AS ownerId, f.name AS name,
               f.parent_id AS parentId,
               u.username AS ownerUsername, u.email AS ownerEmail
        FROM folders f
        LEFT JOIN users u ON u.id = f.user_id
        WHERE f.name LIKE ? ESCAPE '\\' ${scoped}
        ORDER BY f.name COLLATE NOCASE ASC
        LIMIT ?
      ),
      up(rootId, ownerId, id, name, parentId, depth) AS (
        SELECT hitId, ownerId, hitId, name, parentId, 0 FROM hits
        UNION ALL
        SELECT up.rootId, up.ownerId, p.id, p.name, p.parent_id, up.depth + 1
        FROM folders p JOIN up ON p.id = up.parentId AND p.user_id = up.ownerId
      )
      SELECT h.hitId AS hitId, h.ownerId AS ownerId, h.name AS name,
             h.ownerUsername AS ownerUsername, h.ownerEmail AS ownerEmail,
             up.id AS pathId, up.name AS pathName, up.depth AS pathDepth
      FROM hits h
      LEFT JOIN up ON up.rootId = h.hitId
      ORDER BY h.hitId, up.depth DESC
    `,
    args
  )
  return collectHits(rows, limit, (row, path) => ({
    id: Number(row.hitId),
    name: String(row.name),
    ownerId: Number(row.ownerId),
    ownerLabel: row.ownerUsername || row.ownerEmail || null,
    path,
    relDir: path.slice(0, -1).map((n) => n.name).join('/')
  }))
}

/**
 * 复刻 server/utils/search.ts 的 searchFiles。
 * 源位置：server/utils/search.ts 的第二个 `WITH RECURSIVE hits AS (...)`。
 */
async function searchFiles(fx, keyword, ownerId, limit = LIMIT) {
  const scoped = ownerId === null ? '' : 'AND f.user_id = ?'
  const args = [likePattern(keyword)]
  if (ownerId !== null) args.push(ownerId)
  args.push(limit + 1)

  const rows = await fx.all(
    `
      WITH RECURSIVE hits AS (
        SELECT f.id AS hitId, f.user_id AS ownerId, f.filename AS filename,
               f.file_key AS fileKey, f.file_size AS fileSize,
               f.content_type AS contentType, f.created_at AS createdAt,
               f.folder_id AS folderId,
               u.username AS ownerUsername, u.email AS ownerEmail
        FROM files f
        LEFT JOIN users u ON u.id = f.user_id
        WHERE f.filename LIKE ? ESCAPE '\\' ${scoped}
        ORDER BY f.filename COLLATE NOCASE ASC
        LIMIT ?
      ),
      up(rootId, ownerId, id, name, parentId, depth) AS (
        SELECT h.hitId, h.ownerId, p.id, p.name, p.parent_id, 0
        FROM hits h JOIN folders p ON p.id = h.folderId AND p.user_id = h.ownerId
        UNION ALL
        SELECT up.rootId, up.ownerId, p.id, p.name, p.parent_id, up.depth + 1
        FROM folders p JOIN up ON p.id = up.parentId AND p.user_id = up.ownerId
      )
      SELECT h.hitId AS hitId, h.ownerId AS ownerId, h.filename AS filename,
             h.fileKey AS fileKey, h.fileSize AS fileSize,
             h.contentType AS contentType, h.createdAt AS createdAt,
             h.folderId AS folderId,
             h.ownerUsername AS ownerUsername, h.ownerEmail AS ownerEmail,
             up.id AS pathId, up.name AS pathName, up.depth AS pathDepth
      FROM hits h
      LEFT JOIN up ON up.rootId = h.hitId
      ORDER BY h.hitId, up.depth DESC
    `,
    args
  )
  return collectHits(rows, limit, (row, path) => ({
    id: Number(row.hitId),
    filename: String(row.filename),
    fileKey: String(row.fileKey),
    fileSize: Number(row.fileSize),
    folderId: row.folderId === null || row.folderId === undefined ? null : Number(row.folderId),
    ownerId: Number(row.ownerId),
    ownerLabel: row.ownerUsername || row.ownerEmail || null,
    path,
    relDir: path.map((n) => n.name).join('/')
  }))
}

/** 复刻 foldPaths + 去重 + 截断判定（server/utils/search.ts） */
function collectHits(rows, limit, build) {
  const paths = new Map()
  for (const row of rows) {
    if (row.pathId === null || row.pathId === undefined) continue
    const hitId = Number(row.hitId)
    const list = paths.get(hitId) ?? []
    list.push({ id: Number(row.pathId), name: String(row.pathName) })
    paths.set(hitId, list)
  }
  const seen = new Set()
  const ordered = []
  for (const row of rows) {
    const hitId = Number(row.hitId)
    if (seen.has(hitId)) continue
    seen.add(hitId)
    ordered.push(build(row, paths.get(hitId) ?? []))
  }
  return { hits: ordered.slice(0, limit), truncated: ordered.length > limit }
}

let fx

before(async () => {
  fx = await createShareFixture()
})
after(() => fx.close())
beforeEach(() => fx.reset())

/**
 * 造一棵树：
 *
 *   OWNER                              VISITOR
 *    工作/                             别人的/
 *      2026/                             visitor.txt
 *        报告/
 *          Q1报告.docx
 *    100%/                             （测 LIKE 转义）
 *      100%完成.md
 *    根目录说明.txt                     （根层文件）
 */
async function seed() {
  await fx.mkFolder({ id: 10, name: '工作' })
  await fx.mkFolder({ id: 11, name: '2026', parentId: 10 })
  await fx.mkFolder({ id: 12, name: '报告', parentId: 11 })
  await fx.mkFolder({ id: 13, name: '100%' })
  await fx.mkFolder({ id: 14, name: '别人的', ownerId: VISITOR })

  await fx.mkFile({ id: 20, filename: 'Q1报告.docx', folderId: 12, fileSize: 2048 })
  await fx.mkFile({ id: 21, filename: '根目录说明.txt', folderId: null })
  await fx.mkFile({ id: 22, filename: '100%完成.md', folderId: 13 })
  await fx.mkFile({ id: 23, filename: 'visitor.txt', folderId: 14, ownerId: VISITOR })
}

const names = (rows, key) => rows.map((r) => r[key])

describe('范围：mine 只搜自己的树', () => {
  test('只返回该属主的条目，别人的同名条目不进来', async () => {
    await seed()
    await fx.mkFile({ id: 24, filename: '根目录说明.txt', folderId: null, ownerId: VISITOR })

    const mine = await searchFiles(fx, '根目录说明', OWNER)
    assert.deepEqual(names(mine.hits, 'filename'), ['根目录说明.txt'])
    assert.equal(mine.hits[0].ownerId, OWNER)

    // 同样关键词、换成 VISITOR 的范围 → 看到的是他那条
    const theirs = await searchFiles(fx, '根目录说明', VISITOR)
    assert.deepEqual(names(theirs.hits, 'filename'), ['根目录说明.txt'])
    assert.equal(theirs.hits[0].ownerId, VISITOR)
  })

  test('全站（ownerId=null）两类属主都返回', async () => {
    await seed()
    const site = await searchFiles(fx, 'txt', null)
    const owners = [...new Set(site.hits.map((h) => h.ownerId))].sort()
    assert.deepEqual(owners, [VISITOR, OWNER])
  })

  test('ownerLabel 来自 username，取不到时退回邮箱', async () => {
    await seed()
    const site = await searchFiles(fx, 'visitor', null)
    assert.equal(site.hits[0].ownerLabel, `u${VISITOR}`)
  })
})

describe('路径：relDir 与 path', () => {
  test('目录命中：path 从根到它自己，relDir 是父路径（不含自己）', async () => {
    await seed()
    const res = await searchFolders(fx, '报告', OWNER)
    const hit = res.hits[0]
    assert.deepEqual(hit.path.map((n) => n.name), ['工作', '2026', '报告'])
    assert.deepEqual(hit.path.map((n) => n.id), [10, 11, 12])
    assert.equal(hit.relDir, '工作/2026')
  })

  test('文件命中：path 到所在目录为止，relDir 就是整条路径', async () => {
    await seed()
    const res = await searchFiles(fx, 'Q1', OWNER)
    const hit = res.hits[0]
    assert.deepEqual(hit.path.map((n) => n.name), ['工作', '2026', '报告'])
    assert.equal(hit.relDir, '工作/2026/报告')
    assert.equal(hit.folderId, 12)
  })

  test('根层文件：path 为空、relDir 为空（不是「根」这样的占位串）', async () => {
    await seed()
    const res = await searchFiles(fx, '根目录说明', OWNER)
    assert.deepEqual(res.hits[0].path, [])
    assert.equal(res.hits[0].relDir, '')
    assert.equal(res.hits[0].folderId, null)
  })

  test('层级顺序是从根到目标，不是反过来', async () => {
    await seed()
    const res = await searchFiles(fx, 'Q1', OWNER)
    assert.equal(res.hits[0].path[0].name, '工作')
    assert.equal(res.hits[0].path.at(-1).name, '报告')
  })
})

describe('LIKE 通配符必须被转义', () => {
  test('% 不当通配符：只命中名字里真含 % 的条目，而不是所有条目', async () => {
    await seed()
    const folders = await searchFolders(fx, '%', OWNER)
    const files = await searchFiles(fx, '%', OWNER)
    // 种子数据里只有 100% / 100%完成.md 的文字里真含 %
    assert.deepEqual(names(folders.hits, 'name'), ['100%'])
    assert.deepEqual(names(files.hits, 'filename'), ['100%完成.md'])
  })

  test('_ 不当单字符通配符', async () => {
    await seed()
    const folders = await searchFolders(fx, '_', OWNER)
    assert.equal(folders.hits.length, 0, '搜 _ 命中了目录 = 通配符没转义')
  })

  test('名字里真含 % 的条目，能被含 % 的关键词搜到', async () => {
    await seed()
    const folders = await searchFolders(fx, '100%', OWNER)
    assert.deepEqual(names(folders.hits, 'name'), ['100%'])
    const files = await searchFiles(fx, '100%', OWNER)
    assert.deepEqual(names(files.hits, 'filename'), ['100%完成.md'])
  })

  test('名字里真含 _ 的条目也能搜到（转义不能把正常字符吃掉）', async () => {
    await seed()
    await fx.mkFolder({ id: 15, name: 'a_b' })
    const res = await searchFolders(fx, 'a_b', OWNER)
    assert.deepEqual(names(res.hits, 'name'), ['a_b'])
  })
})

describe('匹配与排序', () => {
  test('ASCII 大小写不敏感', async () => {
    await seed()
    const res = await searchFiles(fx, 'q1', OWNER)
    assert.deepEqual(names(res.hits, 'filename'), ['Q1报告.docx'])
  })

  test('中文子串能命中', async () => {
    await seed()
    const res = await searchFolders(fx, '报告', OWNER)
    assert.equal(res.hits.length, 1)
  })

  test('目录按名称排序', async () => {
    await seed()
    await fx.mkFolder({ id: 16, name: '工作 2' })
    const res = await searchFolders(fx, '工作', OWNER)
    assert.deepEqual(names(res.hits, 'name'), ['工作', '工作 2'])
  })
})

describe('截断', () => {
  test('超过上限时截断并置 truncated，不报总数', async () => {
    await seed()
    const res = await searchFolders(fx, '0', OWNER, 1)
    assert.equal(res.hits.length, 1)
    assert.equal(res.truncated, true)
  })

  test('没超上限时 truncated 为 false', async () => {
    await seed()
    const res = await searchFolders(fx, '报告', OWNER, 50)
    assert.equal(res.truncated, false)
    assert.equal(res.hits.length, 1)
  })
})

describe('接口层的权限边界', () => {
  const src = read('server/api/files/search.get.ts')
  const code = stripComments(src)

  test('全站搜索要求 isSuperAdmin，而不是 isAdmin', () => {
    assert.ok(
      /scope === 'site' && !me\.isSuperAdmin/.test(code),
      'scope=site 必须只认超管 —— isAdmin 里普通管理员也是 true'
    )
    assert.ok(!/isAdmin/.test(code), '接口里不该出现 isAdmin 判定')
  })

  test('全站搜索必须登录（匿名不能搜）', () => {
    assert.ok(code.includes('requireAuth'), '没有鉴权入口')
  })

  test('mine 范围用服务端的 me.userId 圈定，不接受任何请求参数指定范围', () => {
    assert.ok(
      /scope === 'mine' \? Number\(me\.userId\) : null/.test(code),
      'mine 的 ownerId 必须来自 me，不能来自请求'
    )
    assert.ok(
      !code.includes('targetUserId'),
      '搜索不该有 targetUserId —— 多一个可调参数就多一类越权'
    )
  })

  test('关键词有长度上限（LIKE 的扫描成本随模式串增长）', () => {
    assert.ok(/MAX_KEYWORD_LENGTH/.test(code))
    assert.ok(/关键词过长/.test(src))
  })
})

describe('SQL 的写法约束', () => {
  const src = read('server/utils/search.ts')

  test('用 escapeLike 转义，并声明 ESCAPE', () => {
    assert.ok(src.includes('escapeLike('), '没转义 LIKE 模式')
    assert.ok(src.includes("ESCAPE '\\\\'"), '转义了却没声明 ESCAPE，反斜杠会被当普通字符')
  })

  test('两处查询都按 hitId, depth DESC 排 —— foldPaths 依赖这个顺序', () => {
    const n = (src.match(/ORDER BY h\.hitId, up\.depth DESC/g) || []).length
    assert.equal(n, 2, `两个查询都要排，现在只有 ${n} 个`)
  })

  test('文件命中从 folder_id 起头上溯（根层文件因此 path 为空）', () => {
    assert.ok(
      /FROM hits h JOIN folders p ON p\.id = h\.folderId AND p\.user_id = h\.ownerId/.test(src),
      '文件的上溯种子必须来自 folder_id，且带上属主条件'
    )
  })

  test('上溯每一跳都带属主条件（MySQL 路径没有「父子同属主」触发器）', () => {
    // 去注释再数：模块头的说明里也写了这个条件，按原文数会多算一处
    const code = stripComments(read('server/utils/search.ts'))
    const n = (code.match(/p\.user_id = up\.ownerId/g) || []).length
    assert.equal(n, 2, `两个查询的递归步各要一处属主条件，现在 ${n} 处`)
  })
})

describe('前端接线', () => {
  test('搜索弹窗走 Teleport to body（body 之外会被 ui-glass 的 backdrop-filter 困住）', () => {
    const src = read('app/components/SearchDialog.vue')
    assert.ok(src.includes('<Teleport to="body">'))
  })

  test('搜索弹窗的 Escape 监听挂在 window 上（@keydown.esc 绑不到焦点时是空操作）', () => {
    const src = read('app/components/SearchDialog.vue')
    assert.ok(src.includes("window.addEventListener('keydown', onKeydown)"))
    assert.ok(src.includes('onBeforeUnmount'))
  })

  test('弹窗去抖且丢弃过期响应（慢的旧请求可能后到）', () => {
    const src = read('app/components/SearchDialog.vue')
    assert.ok(src.includes('searchTimer'), '没有去抖')
    assert.ok(/requestId/.test(src), '没有请求序号，后到的旧响应会覆盖新结果')
    assert.ok(src.includes('searched'), '没有 searched 标记：会在没搜过时说「没有匹配项」')
  })

  test('FileList 的额外交互位不受 showActions 控制', () => {
    const src = read('app/components/FileList.vue')
    assert.ok(
      src.includes('v-if="$slots[\'file-extra-actions\']"'),
      '额外交互位必须按 slot 是否存在渲染 —— 搜索结果的 showActions 是 false'
    )
  })

  test('FileList 的路径行会带上属主（仅全站搜索传 ownerLabel）', () => {
    const src = read('app/components/FileList.vue')
    assert.ok(src.includes('const pathLabelOf'), '缺少 pathLabelOf')
    assert.ok(/ownerLabel/.test(src), '没消费 ownerLabel')
  })

  test('预览拿得到管理身份（否则文件管理页预览别人文件是 404）', () => {
    const browser = read('app/components/FileBrowser.vue')
    assert.ok(/:use-admin="useAdmin"/.test(browser), 'FileBrowser 没把 useAdmin 传给 FilePreviewer')

    const previewer = read('app/components/FilePreviewer.vue')
    assert.ok(!previewer.includes('props.currentFolderId'), '预览仍依赖当前浏览目录')
    assert.ok(previewer.includes('folderId: props.file.folderId ?? null'), '保存没写回文件自己的目录')
    const withAdmin = previewer.match(/props\.useAdmin,/g) || []
    assert.equal(withAdmin.length, 2, `加载与下载两处都要带 useAdmin，现在 ${withAdmin.length} 处`)
  })

  test('首页的搜索入口在看别人/链接时隐藏，且范围是 mine', () => {
    const src = read('app/pages/index.vue')
    assert.ok(/v-if="isLoggedIn && !viewingOthers"/.test(src), '入口没有按「在看别人的东西」隐藏')
    assert.ok(/scope="mine"/.test(src), '首页搜索范围不是 mine')
    assert.ok(src.includes('navigateToPath'), '结果点击没有落地')
  })

  test('文件管理页只给超管全站搜索，普通管理员拿不到入口', () => {
    const src = read('app/pages/manage/files.vue')
    assert.ok(/v-if="isSuper"/.test(src), '入口必须按 isSuper 给 —— isAdmin 会把普通管理员也放进来')
    assert.ok(/scope="site"/.test(src))
    assert.ok(src.includes(':initial-jump="pendingJump"'), '跨属主重建后跳转指令没带回去')
    assert.ok(src.includes('@jump-consumed'), '跳转指令没清空，下次重建会重复空降')
  })
})
