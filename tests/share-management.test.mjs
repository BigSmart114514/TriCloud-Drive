// 分享管理列表 + 批量处置的行为。
//
// 为什么 SQL 是复刻：server/utils/share-settings.ts 与 server/api/share/bulk.post.ts
// 都依赖 Nuxt 的路径别名与自动导入（createError / readBody 等），在 node --test 下
// import 不了（同 tests/search.test.mjs 的做法）。源位置标在每个函数上方。
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

/** 去掉注释，用于「源码里有没有某个写法」的断言 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

const SHARE_NONE = 0
const SHARE_SHARED = 1
const SHARE_INHERIT = 2

/** 与 types/share.ts 的 linkActiveFromShareMode 同口径 */
const linkActiveFromShareMode = (shared) => Number(shared) === SHARE_SHARED

/* ------------------------------------------------------------------ *
 * 复刻：路径折叠（server/utils/folder-path.ts 的 collectHits）
 * ------------------------------------------------------------------ */

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

const folderRelDir = (path) => path.slice(0, -1).map((n) => n.name).join('/')
const fileRelDir = (path) => path.map((n) => n.name).join('/')

/* ------------------------------------------------------------------ *
 * 复刻：列表查询（server/utils/share-settings.ts）
 * ------------------------------------------------------------------ */

const NON_DEFAULT_SQL = `
  Shared <> 2
  OR IsPublic = 1
  OR EXISTS (SELECT 1 FROM folder_access fa WHERE fa.folder_id = f.id)
  OR EXISTS (SELECT 1 FROM share_links sl WHERE sl.target_type = 'folder' AND sl.target_id = f.id)
`
const NON_DEFAULT_SQL_FILE = `
  Shared <> 2
  OR IsPublic = 1
  OR EXISTS (SELECT 1 FROM file_access ga WHERE ga.file_id = f.id)
  OR EXISTS (SELECT 1 FROM share_links sl WHERE sl.target_type = 'file' AND sl.target_id = f.id)
`
const BOUNDARY_CTE = `
  boundaryDepth AS (
    SELECT rootId, MIN(depth) AS d FROM up WHERE shared IN (0, 1) GROUP BY rootId
  )
`
const BOUNDARY_JOIN = `
  LEFT JOIN boundaryDepth bd ON bd.rootId = h.hitId
  LEFT JOIN up b ON b.rootId = h.hitId AND b.depth = bd.d
`
const PRESET_ACTIVE_EXPR = `CASE WHEN b.shared = 1 THEN 1 ELSE 0 END`

function toRow(raw, path, targetType) {
  const mode = Number(raw.shared)
  const row = {
    id: Number(raw.hitId),
    targetType,
    name: String(raw.name),
    relDir: targetType === 'folder' ? folderRelDir(path) : fileRelDir(path),
    path,
    ownerId: Number(raw.ownerId),
    mode,
    isPublic: Number(raw.isPublic ?? 0) === 1,
    grantCount: Number(raw.grantCount ?? 0) || 0,
    linkCount: Number(raw.linkCount ?? 0) || 0,
    presetActive: Number(raw.isPresetActive ?? 0) === 1,
    linkActive: linkActiveFromShareMode(mode),
    createdAt: raw.createdAt ?? null
  }
  if (targetType === 'file') {
    row.folderId = raw.folderId === null || raw.folderId === undefined ? null : Number(raw.folderId)
  }
  return row
}

async function listFolders(fx, ownerId, limit) {
  const rows = await fx.all(
    `
      WITH RECURSIVE hits AS (
        SELECT f.id AS hitId, f.user_id AS ownerId, f.name AS name,
               f.parent_id AS parentId, f.Shared AS shared, f.IsPublic AS isPublic,
               f.created_at AS createdAt,
               (SELECT COUNT(*) FROM folder_access fa WHERE fa.folder_id = f.id) AS grantCount,
               (SELECT COUNT(*) FROM share_links sl
                 WHERE sl.target_type = 'folder' AND sl.target_id = f.id) AS linkCount
        FROM folders f
        WHERE f.user_id = ? AND (${NON_DEFAULT_SQL})
        ORDER BY f.name COLLATE NOCASE ASC
        LIMIT ?
      ),
      up(rootId, ownerId, id, name, parentId, shared, depth) AS (
        SELECT hitId, ownerId, hitId, name, parentId, shared, 0 FROM hits
        UNION ALL
        SELECT up.rootId, up.ownerId, p.id, p.name, p.parent_id, p.Shared, up.depth + 1
        FROM folders p JOIN up ON p.id = up.parentId AND p.user_id = up.ownerId
      ),
      ${BOUNDARY_CTE}
      SELECT h.hitId AS hitId, h.ownerId AS ownerId, h.name AS name,
             h.shared AS shared, h.isPublic AS isPublic, h.createdAt AS createdAt,
             h.grantCount AS grantCount, h.linkCount AS linkCount,
             up.id AS pathId, up.name AS pathName, up.depth AS pathDepth,
             ${PRESET_ACTIVE_EXPR} AS isPresetActive
      FROM hits h
      LEFT JOIN up ON up.rootId = h.hitId
      ${BOUNDARY_JOIN}
      ORDER BY h.hitId, up.depth DESC
    `,
    [ownerId, limit + 1]
  )
  return collectHits(rows, limit, (row, path) => toRow(row, path, 'folder'))
}

async function listFiles(fx, ownerId, limit) {
  const rows = await fx.all(
    `
      WITH RECURSIVE hits AS (
        SELECT f.id AS hitId, f.user_id AS ownerId, f.filename AS name,
               f.folder_id AS folderId, f.Shared AS shared, f.IsPublic AS isPublic,
               f.created_at AS createdAt, f.file_size AS fileSize,
               f.content_type AS contentType,
               (SELECT COUNT(*) FROM file_access ga WHERE ga.file_id = f.id) AS grantCount,
               (SELECT COUNT(*) FROM share_links sl
                 WHERE sl.target_type = 'file' AND sl.target_id = f.id) AS linkCount
        FROM files f
        WHERE f.user_id = ? AND (${NON_DEFAULT_SQL_FILE})
        ORDER BY f.filename COLLATE NOCASE ASC
        LIMIT ?
      ),
      up(rootId, ownerId, id, name, parentId, shared, depth) AS (
        SELECT h.hitId, h.ownerId, p.id, p.name, p.parent_id, p.Shared, 0
        FROM hits h JOIN folders p ON p.id = h.folderId AND p.user_id = h.ownerId
        UNION ALL
        SELECT up.rootId, up.ownerId, p.id, p.name, p.parent_id, p.Shared, up.depth + 1
        FROM folders p JOIN up ON p.id = up.parentId AND p.user_id = up.ownerId
      ),
      ${BOUNDARY_CTE}
      SELECT h.hitId AS hitId, h.ownerId AS ownerId, h.name AS name,
             h.shared AS shared,
             h.isPublic AS isPublic, h.createdAt AS createdAt, h.fileSize AS fileSize,
             h.contentType AS contentType, h.folderId AS folderId,
             h.grantCount AS grantCount, h.linkCount AS linkCount,
             up.id AS pathId, up.name AS pathName, up.depth AS pathDepth,
             ${PRESET_ACTIVE_EXPR} AS isPresetActive
      FROM hits h
      LEFT JOIN up ON up.rootId = h.hitId
      ${BOUNDARY_JOIN}
      ORDER BY h.hitId, up.depth DESC
    `,
    [ownerId, limit + 1]
  )
  return collectHits(rows, limit, (row, path) => toRow(row, path, 'file'))
}

async function summarize(fx, ownerId) {
  const r = await fx.get(
    `
      SELECT
        (SELECT COUNT(*) FROM folders f
          WHERE f.user_id = ? AND (${NON_DEFAULT_SQL})) AS folderCount,
        (SELECT COUNT(*) FROM files f
          WHERE f.user_id = ? AND (${NON_DEFAULT_SQL_FILE})) AS fileCount,
        (SELECT COUNT(*) FROM folders f
          WHERE f.user_id = ? AND f.IsPublic = 1 AND (${NON_DEFAULT_SQL})) AS publicFolderCount,
        (SELECT COUNT(*) FROM files f
          WHERE f.user_id = ? AND f.IsPublic = 1 AND (${NON_DEFAULT_SQL_FILE})) AS publicFileCount,
        (SELECT COUNT(*) FROM folders f
          WHERE f.user_id = ? AND f.Shared = 0 AND (${NON_DEFAULT_SQL})) AS privateFolderCount,
        (SELECT COUNT(*) FROM files f
          WHERE f.user_id = ? AND f.Shared = 0 AND (${NON_DEFAULT_SQL_FILE})) AS privateFileCount,
        (SELECT COUNT(*) FROM share_links sl JOIN folders f ON f.id = sl.target_id
          WHERE sl.target_type = 'folder' AND f.user_id = ?) AS folderLinkCount,
        (SELECT COUNT(*) FROM share_links sl JOIN files f ON f.id = sl.target_id
          WHERE sl.target_type = 'file' AND f.user_id = ?) AS fileLinkCount,
        (SELECT COUNT(*) FROM share_links sl JOIN folders f ON f.id = sl.target_id
          WHERE sl.target_type = 'folder' AND f.user_id = ? AND f.Shared <> 1) AS deadFolderLinkCount,
        (SELECT COUNT(*) FROM share_links sl JOIN files f ON f.id = sl.target_id
          WHERE sl.target_type = 'file' AND f.user_id = ? AND f.Shared <> 1) AS deadFileLinkCount
    `,
    [ownerId, ownerId, ownerId, ownerId, ownerId, ownerId, ownerId, ownerId, ownerId, ownerId]
  )
  const n = (k) => Number(r?.[k] ?? 0) || 0
  const folderCount = n('folderCount')
  const fileCount = n('fileCount')
  return {
    total: folderCount + fileCount,
    folderCount,
    fileCount,
    publicCount: n('publicFolderCount') + n('publicFileCount'),
    privateCount: n('privateFolderCount') + n('privateFileCount'),
    linkCount: n('folderLinkCount') + n('fileLinkCount'),
    deadLinkCount: n('deadFolderLinkCount') + n('deadFileLinkCount')
  }
}

async function listShareSettings(fx, ownerId, limit = 200) {
  const folders = await listFolders(fx, ownerId, limit)
  const files = await listFiles(fx, ownerId, limit)
  return {
    folders: folders.hits,
    files: files.hits,
    summary: await summarize(fx, ownerId),
    truncated: folders.truncated || files.truncated
  }
}

/* ------------------------------------------------------------------ *
 * 复刻：批量处置（server/api/share/bulk.post.ts）
 * ------------------------------------------------------------------ */

const ACCESS_TABLE = { file: 'file_access', folder: 'folder_access' }
const ACCESS_COLUMN = { file: 'file_id', folder: 'folder_id' }

/**
 * 归属校验。口径与 server/utils/share.ts 的 resolveShareTarget 一致：
 * 目标不存在 → 404，不是属主 → 403。
 *
 * 夹具没有 getSync，所以这里是 async 版；生产那份也是 async，形状相同。
 */
async function assertOwned(fx, type, id, actingUserId) {
  const table = type === 'file' ? 'files' : 'folders'
  const row = await fx.get(`SELECT id, user_id AS userId FROM ${table} WHERE id = ?`, [id])
  if (!row) {
    const e = new Error(type === 'file' ? '文件不存在' : '文件夹不存在')
    e.statusCode = 404
    throw e
  }
  if (Number(row.userId) !== actingUserId) {
    const e = new Error('只有属主可以管理分享')
    e.statusCode = 403
    throw e
  }
  return { type, table, id, ownerId: Number(row.userId) }
}

async function setShareMode(fx, target, mode) {
  if (Number(mode) === SHARE_NONE) {
    await fx.run(`UPDATE ${target.table} SET Shared = ?, IsPublic = 0 WHERE id = ?`, [mode, target.id])
  } else {
    await fx.run(`UPDATE ${target.table} SET Shared = ? WHERE id = ?`, [mode, target.id])
  }
}

async function setPublic(fx, target, isPublic) {
  if (isPublic) {
    await fx.run(
      `UPDATE ${target.table} SET IsPublic = 1, Shared = CASE WHEN Shared = ? THEN ? ELSE Shared END WHERE id = ?`,
      [SHARE_NONE, SHARE_SHARED, target.id]
    )
  } else {
    await fx.run(`UPDATE ${target.table} SET IsPublic = 0 WHERE id = ?`, [target.id])
  }
}

async function replaceAccess(fx, target, entries) {
  const table = ACCESS_TABLE[target.type]
  const column = ACCESS_COLUMN[target.type]
  const wanted = new Map()
  for (const e of entries) wanted.set(e.userId, e.permission)
  const current = await fx.all(
    `SELECT user_id AS userId, permission FROM ${table} WHERE ${column} = ?`,
    [target.id]
  )
  const have = new Map()
  for (const row of current) have.set(Number(row.userId), Number(row.permission))
  for (const userId of have.keys()) {
    if (wanted.has(userId)) continue
    await fx.run(`DELETE FROM ${table} WHERE ${column} = ? AND user_id = ?`, [target.id, userId])
  }
  for (const [userId, permission] of wanted) {
    if (have.get(userId) === permission) continue
    const res = await fx.run(
      `UPDATE ${table} SET permission = ? WHERE ${column} = ? AND user_id = ?`,
      [permission, target.id, userId]
    )
    if (!Number(res?.changes ?? 0)) {
      await fx.run(
        `INSERT INTO ${table} (${column}, user_id, permission) VALUES (?, ?, ?)`,
        [target.id, userId, permission]
      )
    }
  }
}

async function deleteShareLinksByTarget(fx, type, id, actingUserId) {
  try {
    await assertOwned(fx, type, id, actingUserId)
  } catch (e) {
    if (e?.statusCode !== 404) throw e
  }
  const res = await fx.run('DELETE FROM share_links WHERE target_type = ? AND target_id = ?', [type, id])
  return Number(res?.changes ?? 0) || 0
}

const MAX_TARGETS = 200

async function bulk(fx, ownerId, action, targets) {
  if (!['reset', 'unpublish', 'removeLinks'].includes(action)) {
    const e = new Error('action 不支持')
    e.statusCode = 400
    throw e
  }
  if (!targets.length) {
    const e = new Error('没有选中任何项目')
    e.statusCode = 400
    throw e
  }
  if (targets.length > MAX_TARGETS) {
    const e = new Error(`一次最多处理 ${MAX_TARGETS} 项`)
    e.statusCode = 400
    throw e
  }

  const results = []
  for (const item of targets) {
    const targetType = item?.targetType
    const targetId = Number(item?.targetId)
    try {
      if (targetType !== 'file' && targetType !== 'folder') {
        const e = new Error('targetType 必须是 file 或 folder')
        e.statusCode = 400
        throw e
      }
      if (!Number.isInteger(targetId) || targetId < 1) {
        const e = new Error('非法的 targetId')
        e.statusCode = 400
        throw e
      }
      const target = await assertOwned(fx, targetType, targetId, ownerId)
      if (action === 'reset') {
        await setShareMode(fx, target, SHARE_INHERIT)
        await setPublic(fx, target, false)
        await replaceAccess(fx, target, [])
        await deleteShareLinksByTarget(fx, targetType, targetId, ownerId)
      } else if (action === 'unpublish') {
        await setPublic(fx, target, false)
      } else {
        await deleteShareLinksByTarget(fx, targetType, targetId, ownerId)
      }
      results.push({ targetType, targetId, ok: true })
    } catch (e) {
      results.push({
        targetType: String(targetType ?? ''),
        targetId: Number.isInteger(targetId) ? targetId : null,
        ok: false,
        message: e?.message || '操作失败'
      })
    }
  }
  const okCount = results.filter((r) => r.ok).length
  return { okCount, failCount: results.length - okCount, results }
}

/* ------------------------------------------------------------------ *
 * 复刻：祖先链（server/api/folders/lineage.get.ts）
 * ------------------------------------------------------------------ */

async function lineage(fx, ownerId, folderId) {
  const own = await fx.get('SELECT id FROM folders WHERE id = ? AND user_id = ?', [folderId, ownerId])
  if (!own) {
    const e = new Error('文件夹不存在')
    e.statusCode = 404
    throw e
  }
  const rows = await fx.all(
    `
      WITH RECURSIVE up(id, name, parent_id, depth) AS (
        SELECT id, name, parent_id, 0 FROM folders WHERE id = ? AND user_id = ?
        UNION ALL
        SELECT p.id, p.name, p.parent_id, up.depth + 1
        FROM folders p JOIN up ON p.id = up.parent_id
      )
      SELECT id, name FROM up ORDER BY depth DESC
    `,
    [folderId, ownerId]
  )
  return rows.map((r) => ({ id: Number(r.id), name: String(r.name) }))
}

/* ------------------------------------------------------------------ *
 * 测试
 * ------------------------------------------------------------------ */

let fx

before(async () => {
  fx = await createShareFixture()
})
after(() => fx.close())
beforeEach(() => fx.reset())

const names = (rows) => rows.map((r) => r.name)

describe('判据：四种命中', () => {
  test('默认态（四项都无）不进列表', async () => {
    await fx.mkFolder({ id: 10, name: '普通目录' })
    await fx.mkFolder({ id: 11, name: '子目录', parentId: 10 })
    await fx.mkFile({ id: 20, filename: '普通文件.txt', folderId: 10 })
    const res = await listShareSettings(fx, OWNER)
    assert.deepEqual(names(res.folders), [])
    assert.deepEqual(names(res.files), [])
    assert.equal(res.summary.total, 0)
  })

  test('三态非继承（不分享 / 分享）都进列表', async () => {
    await fx.mkFolder({ id: 10, name: '拒绝', Shared: SHARE_NONE })
    await fx.mkFolder({ id: 11, name: '按名单', Shared: SHARE_SHARED })
    const res = await listShareSettings(fx, OWNER)
    // 用集合比而不是数组比：中文名的排序在不同 collation 下不一致，
    // 这里要验的是「两条都在」，不是「谁在前」
    assert.deepEqual(names(res.folders).slice().sort(), ['按名单', '拒绝'].sort())
  })

  test('继承 + 公开：只靠 IsPublic 就该进列表', async () => {
    await fx.mkFolder({ id: 10, name: '公开目录', IsPublic: 1 })
    await fx.mkFile({ id: 20, filename: '公开文件.txt', IsPublic: 1 })
    const res = await listShareSettings(fx, OWNER)
    assert.deepEqual(names(res.folders), ['公开目录'])
    assert.deepEqual(names(res.files), ['公开文件.txt'])
  })

  test('继承 + 有人被授权：只靠名单就该进列表', async () => {
    await fx.mkFolder({ id: 10, name: '授权目录' })
    await fx.grantFolder(10, VISITOR, 1)
    await fx.mkFile({ id: 20, filename: '授权文件.txt' })
    await fx.grantFile(20, VISITOR, 1)
    const res = await listShareSettings(fx, OWNER)
    assert.deepEqual(names(res.folders), ['授权目录'])
    assert.deepEqual(names(res.files), ['授权文件.txt'])
    assert.equal(res.folders[0].grantCount, 1)
    assert.equal(res.files[0].grantCount, 1)
  })

  test('继承 + 有链接：只靠链接就该进列表', async () => {
    await fx.mkFolder({ id: 10, name: '有链接' })
    await fx.mkLink('folder', 10)
    const res = await listShareSettings(fx, OWNER)
    assert.deepEqual(names(res.folders), ['有链接'])
    assert.equal(res.folders[0].linkCount, 1)
  })

  test('四项条件互相独立：任一成立即命中', async () => {
    await fx.mkFolder({ id: 10, name: 'a', Shared: SHARE_NONE })
    await fx.mkFolder({ id: 11, name: 'b', IsPublic: 1 })
    await fx.mkFolder({ id: 12, name: 'c' })
    await fx.grantFolder(12, VISITOR, 1)
    await fx.mkFolder({ id: 13, name: 'd' })
    await fx.mkLink('folder', 13)
    const res = await listShareSettings(fx, OWNER)
    assert.deepEqual(names(res.folders).sort(), ['a', 'b', 'c', 'd'])
  })
})

describe('范围：只列我自己的', () => {
  test('别人的非默认项一个都不出现', async () => {
    await fx.mkFolder({ id: 10, name: '我的目录', IsPublic: 1 })
    await fx.mkFolder({ id: 11, name: '别人的目录', IsPublic: 1, ownerId: VISITOR })
    await fx.mkFile({ id: 20, filename: '别人的文件.txt', IsPublic: 1, ownerId: VISITOR })
    const res = await listShareSettings(fx, OWNER)
    assert.deepEqual(names(res.folders), ['我的目录'])
    assert.deepEqual(names(res.files), [])
    assert.equal(res.summary.total, 1)
  })

  test('同一个关键词下换成别人的范围，看到的是他那一批', async () => {
    await fx.mkFolder({ id: 11, name: '目录', IsPublic: 1, ownerId: VISITOR })
    const res = await listShareSettings(fx, VISITOR)
    assert.deepEqual(names(res.folders), ['目录'])
  })
})

describe('每项给出的事实', () => {
  test('路径、relDir、根层文件', async () => {
    await fx.mkFolder({ id: 10, name: '甲' })
    await fx.mkFolder({ id: 11, name: '乙', parentId: 10 })
    await fx.mkFolder({ id: 12, name: '丙', parentId: 11, IsPublic: 1 })
    await fx.mkFile({ id: 20, filename: '深.pdf', folderId: 12, IsPublic: 1 })
    await fx.mkFile({ id: 21, filename: '根.pdf', IsPublic: 1 })

    const res = await listShareSettings(fx, OWNER)
    const folder = res.folders.find((f) => f.name === '丙')
    assert.deepEqual(folder.path.map((n) => n.name), ['甲', '乙', '丙'])
    assert.equal(folder.relDir, '甲/乙')

    // 列表行的字段名是 name（目录名 / 文件名统一），不是 filename
    const deep = res.files.find((f) => f.name === '深.pdf')
    assert.deepEqual(deep.path.map((n) => n.name), ['甲', '乙', '丙'])
    assert.equal(deep.relDir, '甲/乙/丙')
    assert.equal(deep.folderId, 12)

    const root = res.files.find((f) => f.name === '根.pdf')
    assert.deepEqual(root.path, [])
    assert.equal(root.relDir, '')
    assert.equal(root.folderId, null)
  })

  test('人数、链接数、公开各自独立计数', async () => {
    await fx.mkFolder({ id: 10, name: '多项', Shared: SHARE_SHARED, IsPublic: 1 })
    await fx.grantFolder(10, VISITOR, 1)
    await fx.grantFolder(10, 902, 7)
    await fx.mkLink('folder', 10)
    await fx.mkLink('folder', 10)
    const res = await listShareSettings(fx, OWNER)
    const row = res.folders[0]
    assert.equal(row.grantCount, 2)
    assert.equal(row.linkCount, 2)
    assert.equal(row.isPublic, true)
    assert.equal(row.mode, SHARE_SHARED)
  })

  test('文件夹与文件的目标类型分别标对', async () => {
    await fx.mkFolder({ id: 10, name: '目录', IsPublic: 1 })
    await fx.mkFile({ id: 20, filename: '文件.txt', IsPublic: 1 })
    const res = await listShareSettings(fx, OWNER)
    assert.equal(res.folders[0].targetType, 'folder')
    assert.equal(res.files[0].targetType, 'file')
  })
})

describe('是否生效：两个问题分别判', () => {
  test('presetActive：祖先是「分享」→ 我在子目录设的名单生效', async () => {
    await fx.mkFolder({ id: 10, name: '父', Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 11, name: '子', parentId: 10, IsPublic: 1 })
    const res = await listShareSettings(fx, OWNER)
    const child = res.folders.find((f) => f.name === '子')
    assert.equal(child.presetActive, true, '父是分享，子上的设置就该生效')
  })

  test('presetActive：祖先是「不分享」→ 被挡住', async () => {
    await fx.mkFolder({ id: 10, name: '父', Shared: SHARE_NONE })
    await fx.mkFolder({ id: 11, name: '子', parentId: 10, IsPublic: 1 })
    const res = await listShareSettings(fx, OWNER)
    const child = res.folders.find((f) => f.name === '子')
    assert.equal(child.presetActive, false, '被「不分享」挡住 = 不生效')
  })

  test('presetActive：整条链全是继承 → 没人拍板 → 不生效', async () => {
    await fx.mkFolder({ id: 10, name: '甲' })
    await fx.mkFolder({ id: 11, name: '乙', parentId: 10, IsPublic: 1 })
    const res = await listShareSettings(fx, OWNER)
    assert.equal(res.folders[0].presetActive, false)
  })

  test('presetActive：自己就是「分享」→ 生效（不需要祖先表态）', async () => {
    await fx.mkFolder({ id: 10, name: '根', IsPublic: 1, Shared: SHARE_SHARED })
    const res = await listShareSettings(fx, OWNER)
    assert.equal(res.folders[0].presetActive, true)
  })

  test('linkActive：自己不是「分享」→ 它身上的链接打不开', async () => {
    await fx.mkFolder({ id: 10, name: '继承挂链' })
    await fx.mkLink('folder', 10)
    const res = await listShareSettings(fx, OWNER)
    assert.equal(res.folders[0].linkActive, false, '继承态的链接是预设，现在打不开')
  })

  test('linkActive：祖先是「分享」也救不回来（祖先身上没有这条链接）', async () => {
    await fx.mkFolder({ id: 10, name: '父', Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 11, name: '子', parentId: 10 })
    await fx.mkLink('folder', 11)
    const res = await listShareSettings(fx, OWNER)
    const child = res.folders.find((f) => f.name === '子')
    assert.equal(child.linkActive, false, '链接挂在子身上，边界在父身上 → 死链')
  })

  test('linkActive：自己就是「分享」→ 生效', async () => {
    await fx.mkFolder({ id: 10, name: '分享挂链', Shared: SHARE_SHARED })
    await fx.mkLink('folder', 10)
    const res = await listShareSettings(fx, OWNER)
    assert.equal(res.folders[0].linkActive, true)
  })

  test('两个问题可以同时为假：链接死 + 名单也没生效', async () => {
    await fx.mkFolder({ id: 10, name: '父', Shared: SHARE_NONE })
    await fx.mkFolder({ id: 11, name: '子', parentId: 10, IsPublic: 1 })
    await fx.mkLink('folder', 11)
    const res = await listShareSettings(fx, OWNER)
    const child = res.folders.find((f) => f.name === '子')
    assert.equal(child.linkActive, false)
    assert.equal(child.presetActive, false)
  })
})

describe('摘要', () => {
  test('各类计数与总数一致', async () => {
    await fx.mkFolder({ id: 10, name: '公开目录', IsPublic: 1 })
    await fx.mkFolder({ id: 11, name: '私密目录', Shared: SHARE_NONE })
    await fx.mkFolder({ id: 12, name: '普通目录' })
    await fx.mkFile({ id: 20, filename: '公开文件.txt', IsPublic: 1 })
    const res = await listShareSettings(fx, OWNER)
    assert.equal(res.summary.total, 3)
    assert.equal(res.summary.folderCount, 2)
    assert.equal(res.summary.fileCount, 1)
    assert.equal(res.summary.publicCount, 2)
    assert.equal(res.summary.privateCount, 1)
  })

  test('死链单独计数', async () => {
    await fx.mkFolder({ id: 10, name: '活的', Shared: SHARE_SHARED })
    await fx.mkLink('folder', 10)
    await fx.mkFolder({ id: 11, name: '死的' })
    await fx.mkLink('folder', 11)
    await fx.mkLink('folder', 11)
    const res = await listShareSettings(fx, OWNER)
    assert.equal(res.summary.linkCount, 3)
    assert.equal(res.summary.deadLinkCount, 2)
  })

  test('摘要不受列表上限影响（列表被截断时总数仍然是真话）', async () => {
    for (let i = 0; i < 5; i++) await fx.mkFolder({ id: 100 + i, name: `D${i}`, IsPublic: 1 })
    const res = await listShareSettings(fx, OWNER, 2)
    assert.equal(res.folders.length, 2)
    assert.equal(res.truncated, true)
    assert.equal(res.summary.total, 5, '截断的是列表，不是事实')
  })
})

describe('批量：恢复默认', () => {
  test('清掉四项，这一项随即从列表消失', async () => {
    await fx.mkFolder({ id: 10, name: '要清的', Shared: SHARE_SHARED, IsPublic: 1 })
    await fx.grantFolder(10, VISITOR, 1)
    await fx.mkLink('folder', 10)

    const before = await listShareSettings(fx, OWNER)
    assert.equal(before.folders.length, 1)

    const res = await bulk(fx, OWNER, 'reset', [{ targetType: 'folder', targetId: 10 }])
    assert.equal(res.okCount, 1)

    const row = await fx.get('SELECT Shared, IsPublic FROM folders WHERE id = 10', [])
    assert.equal(Number(row.Shared), SHARE_INHERIT, '三态回到继承')
    assert.equal(Number(row.IsPublic), 0, '公开被取消')
    assert.equal((await fx.all('SELECT * FROM folder_access WHERE folder_id = 10')).length, 0, '名单清空')
    assert.equal((await fx.all('SELECT * FROM share_links WHERE target_id = 10')).length, 0, '链接撤销')

    const after = await listShareSettings(fx, OWNER)
    assert.equal(after.folders.length, 0, '恢复默认后不该还留在列表里')
  })

  test('文件同样能恢复默认', async () => {
    await fx.mkFile({ id: 20, filename: 'x.txt', Shared: SHARE_SHARED, IsPublic: 1 })
    await fx.grantFile(20, VISITOR, 1)
    await fx.mkLink('file', 20)
    const res = await bulk(fx, OWNER, 'reset', [{ targetType: 'file', targetId: 20 }])
    assert.equal(res.okCount, 1)
    assert.equal((await listShareSettings(fx, OWNER)).files.length, 0)
  })

  test('不动子树：恢复父目录的默认，儿子的设置仍在他自己身上', async () => {
    await fx.mkFolder({ id: 10, name: '父', Shared: SHARE_SHARED })
    await fx.mkFolder({ id: 11, name: '子', parentId: 10, IsPublic: 1 })
    await bulk(fx, OWNER, 'reset', [{ targetType: 'folder', targetId: 10 }])
    const child = await fx.get('SELECT Shared, IsPublic FROM folders WHERE id = 11', [])
    assert.equal(Number(child.Shared), SHARE_INHERIT)
    assert.equal(Number(child.IsPublic), 1, '清父目录不该顺手清儿子的设置')
  })
})

describe('批量：取消公开 / 撤销链接', () => {
  test('unpublish 只动 IsPublic，名单和三态不变', async () => {
    await fx.mkFolder({ id: 10, name: '半公开', Shared: SHARE_SHARED, IsPublic: 1 })
    await fx.grantFolder(10, VISITOR, 5)
    const res = await bulk(fx, OWNER, 'unpublish', [{ targetType: 'folder', targetId: 10 }])
    assert.equal(res.okCount, 1)
    const row = await fx.get('SELECT Shared, IsPublic FROM folders WHERE id = 10', [])
    assert.equal(Number(row.IsPublic), 0)
    assert.equal(Number(row.Shared), SHARE_SHARED, '三态不该被 unpublish 改动')
    assert.equal((await fx.all('SELECT * FROM folder_access WHERE folder_id = 10')).length, 1, '名单不该被动')
  })

  test('removeLinks 撤掉这一项上的全部链接，别的设置不动', async () => {
    await fx.mkFolder({ id: 10, name: '多链', Shared: SHARE_SHARED })
    await fx.grantFolder(10, VISITOR, 1)
    await fx.mkLink('folder', 10)
    await fx.mkLink('folder', 10)
    await fx.mkFolder({ id: 11, name: '别的', Shared: SHARE_SHARED })
    const keep = await fx.mkLink('folder', 11)

    const res = await bulk(fx, OWNER, 'removeLinks', [{ targetType: 'folder', targetId: 10 }])
    assert.equal(res.okCount, 1)
    assert.equal((await fx.all('SELECT * FROM share_links WHERE target_id = 10')).length, 0)
    assert.ok(await fx.get('SELECT * FROM share_links WHERE link = ?', [keep]), '别人的链接不该被动')
    const row = await fx.get('SELECT Shared FROM folders WHERE id = 10', [])
    assert.equal(Number(row.Shared), SHARE_SHARED)
    assert.equal((await fx.all('SELECT * FROM folder_access WHERE folder_id = 10')).length, 1)
  })

  test('撤链接后这一项因无设置而离开列表', async () => {
    await fx.mkFolder({ id: 10, name: '只有链' })
    await fx.mkLink('folder', 10)
    await bulk(fx, OWNER, 'removeLinks', [{ targetType: 'folder', targetId: 10 }])
    assert.equal((await listShareSettings(fx, OWNER)).folders.length, 0)
  })
})

describe('批量：归属校验逐项做', () => {
  test('混入别人的 id：那一项失败，其余照做', async () => {
    await fx.mkFolder({ id: 10, name: '我的A', Shared: SHARE_NONE })
    await fx.mkFolder({ id: 11, name: '我的B', Shared: SHARE_NONE })
    await fx.mkFolder({ id: 12, name: '别人的', Shared: SHARE_NONE, ownerId: VISITOR })

    const res = await bulk(fx, OWNER, 'reset', [
      { targetType: 'folder', targetId: 10 },
      { targetType: 'folder', targetId: 12 },
      { targetType: 'folder', targetId: 11 }
    ])
    assert.equal(res.okCount, 2)
    assert.equal(res.failCount, 1)

    const theirs = await fx.get('SELECT Shared FROM folders WHERE id = 12', [])
    assert.equal(Number(theirs.Shared), SHARE_NONE, '别人的项一个字节都不能动')

    const mine = await fx.get('SELECT Shared FROM folders WHERE id = 10', [])
    assert.equal(Number(mine.Shared), SHARE_INHERIT)
  })

  test('别人的链接撤不掉', async () => {
    await fx.mkFolder({ id: 12, name: '别人的', Shared: SHARE_SHARED, ownerId: VISITOR })
    await fx.mkLink('folder', 12, 'a'.repeat(32))
    const res = await bulk(fx, OWNER, 'removeLinks', [{ targetType: 'folder', targetId: 12 }])
    assert.equal(res.failCount, 1)
    assert.ok(await fx.get('SELECT * FROM share_links WHERE link = ?', ['a'.repeat(32)]))
  })

  test('已删除的目标：算失败，不影响其余', async () => {
    await fx.mkFolder({ id: 10, name: '在的', Shared: SHARE_NONE })
    const res = await bulk(fx, OWNER, 'reset', [
      { targetType: 'folder', targetId: 9999 },
      { targetType: 'folder', targetId: 10 }
    ])
    assert.equal(res.okCount, 1)
    assert.equal(res.failCount, 1)
  })
})

describe('批量：参数校验', () => {
  test('非法 action → 400', async () => {
    await assert.rejects(() => bulk(fx, OWNER, 'nuke', [{ targetType: 'folder', targetId: 10 }]), /action/)
  })

  test('空列表 → 400', async () => {
    await assert.rejects(() => bulk(fx, OWNER, 'reset', []), /没有选中/)
  })

  test('超过上限 → 400，不截断', async () => {
    const many = Array.from({ length: MAX_TARGETS + 1 }, (_, i) => ({ targetType: 'folder', targetId: i + 1 }))
    await assert.rejects(() => bulk(fx, OWNER, 'reset', many), /最多/)
  })

  test('非法 targetId / targetType → 单项失败，不是整批 500', async () => {
    const res = await bulk(fx, OWNER, 'reset', [
      { targetType: 'folder', targetId: 0 },
      { targetType: 'whatever', targetId: 1 }
    ])
    assert.equal(res.okCount, 0)
    assert.equal(res.failCount, 2)
  })
})

describe('祖先链（?at= 的数据来源）', () => {
  test('根在前，含自己', async () => {
    await fx.mkFolder({ id: 10, name: '甲' })
    await fx.mkFolder({ id: 11, name: '乙', parentId: 10 })
    await fx.mkFolder({ id: 12, name: '丙', parentId: 11 })
    const chain = await lineage(fx, OWNER, 12)
    assert.deepEqual(chain.map((n) => n.name), ['甲', '乙', '丙'])
    assert.deepEqual(chain.map((n) => n.id), [10, 11, 12])
  })

  test('根层目录的链就是它自己', async () => {
    await fx.mkFolder({ id: 10, name: '根目录项' })
    assert.deepEqual((await lineage(fx, OWNER, 10)).map((n) => n.name), ['根目录项'])
  })

  test('别人的目录 → 404（祖先链含目录名，没有授权模型）', async () => {
    await fx.mkFolder({ id: 12, name: '别人的', ownerId: VISITOR })
    await assert.rejects(() => lineage(fx, OWNER, 12), /不存在/)
  })

  test('不存在的 id → 404', async () => {
    await assert.rejects(() => lineage(fx, OWNER, 9999), /不存在/)
  })
})

describe('源码约束', () => {
  const settingsApi = read('server/api/share/settings.get.ts')
  const bulkApi = read('server/api/share/bulk.post.ts')

  test('列表接口只认「我自己」，不读任何用户参数', () => {
    const code = stripComments(settingsApi)
    assert.ok(code.includes('requireAuth'), '没有鉴权入口')
    assert.ok(/Number\(me\.userId\)/.test(code), '范围必须来自 me')
    assert.ok(!code.includes('targetUserId'), '不该有 targetUserId —— 多一个可调参数就多一类越权')
    assert.ok(!code.includes('useAdmin'), '没有管理员变体：改别人分享设置是属主专属权力')
  })

  test('批量接口逐项校验属主，不做整体校验', () => {
    const code = stripComments(bulkApi)
    const loopIdx = code.indexOf('for (const item of')
    assert.ok(loopIdx >= 0, '没有逐项循环')
    // 从循环体里找，不是全文找 —— import 语句里也出现过这个名字
    const body = code.slice(loopIdx, loopIdx + 800)
    assert.ok(body.includes('resolveShareTarget'), '归属校验必须在逐项循环里')
  })

  test('批量 action 是白名单，不接受任意字符串', () => {
    const code = stripComments(bulkApi)
    assert.ok(/hasOwnProperty\.call\(ACTIONS/.test(code), 'action 没有过白名单')
  })

  test('批量上限是拒绝而不是截断（截断等于「看起来全做了」）', () => {
    const code = stripComments(bulkApi)
    assert.ok(/statusCode: 400/.test(code) && code.includes('MAX_TARGETS'))
  })

  test('批量是串行的（sqlite 同一 handle 并发会崩）', () => {
    const code = stripComments(bulkApi)
    assert.ok(!code.includes('Promise.all'), '批量里出现 Promise.all = 并发跑 sqlite 语句')
  })

  test('listShareSettings 内部串行', () => {
    const code = stripComments(read('server/utils/share-settings.ts'))
    assert.ok(!code.includes('Promise.all'), '列表查询并发跑 sqlite 会崩')
  })

  test('链接是否生效不额外查库：走纯函数', () => {
    const code = stripComments(read('server/utils/share-settings.ts'))
    assert.ok(code.includes('linkActiveFromShareMode'), '没有复用 linkActiveFromShareMode')
  })

  test('撤链接按目标也要校验属主（与按 token 同一口径）', () => {
    const code = stripComments(read('server/utils/share-link.ts'))
    const i = code.indexOf('deleteShareLinksByTarget')
    const body = code.slice(i, i + 1200)
    assert.ok(body.includes('resolveShareTarget'), '按目标删链接没有反查属主')
  })

  test('祖先链接口同样只认「我自己的树」', () => {
    const code = stripComments(read('server/api/folders/lineage.get.ts'))
    assert.ok(code.includes('requireAuth'))
    assert.ok(!code.includes('targetUserId'))
  })

  test('列表接口不带 fileKey（这一页只开设置，不预览不下载）', () => {
    const code = stripComments(read('server/utils/share-settings.ts'))
    assert.ok(!code.includes('fileKey'), '分享管理列表不该吐 COS 真实对象路径')
  })
})

describe('前端接线', () => {
  test('导航栏对所有登录用户显示分享管理', () => {
    const src = read('app/components/AppNavbar.vue')
    assert.ok(/to="\/shares"/.test(src), '导航栏没有分享管理入口')
    assert.ok(/aria-label="分享管理"/.test(src), '移动端只剩图标时要有名字')
    // 门槛必须是「登录」而不是「管理员」：这一页所有用户都有
    assert.ok(!/v-if="isAdmin"[\s\S]{0,200}shares/.test(src), '入口被管理员条件挡住了')
  })

  test('页面挂的是自己写的列表组件', () => {
    const src = read('app/pages/shares.vue')
    assert.ok(src.includes('<ShareSettingList'))
    assert.ok(/ShareDialog[\s\S]*@changed/.test(src), '弹窗改完要重拉列表，否则这行显示的是过期状态')
  })

  test('「返回首页」收在 AppNavbar 里，各页面不再各抄一份', () => {
    const navbar = read('app/components/AppNavbar.vue')
    assert.ok(/aria-label="返回首页"/.test(navbar), '导航栏里没有返回首页')
    // 首页自己不需要（在这里等于无处可去）
    assert.ok(/v-if="!isHome"/.test(navbar), '返回首页没有排除首页')
    assert.ok(/route\.path === '\/'/.test(navbar), 'isHome 的判据写错了')

    // 抄一份的第二现场：这些页面都不该再有 #extra 版的返回首页
    for (const page of [
      'app/pages/shares.vue',
      'app/pages/services/change-password.vue',
      'app/pages/manage/user.vue',
      'app/pages/manage/files.vue'
    ]) {
      assert.ok(
        !read(page).includes('aria-label="返回首页"'),
        `${page} 还留着重复的返回首页`
      )
    }
  })

  test('弹窗不能靠 v-if 挂载，否则离场动画不播', () => {
    // ShareDialog 的淡出是内部 Transition + :open 驱动的，组件必须留在原地。
    // v-if 把组件从 vdom 摘掉 = 弹窗瞬间消失，一帧过渡都没有。
    const src = read('app/pages/shares.vue')
    const block = src.slice(src.indexOf('<ShareDialog'))
    assert.ok(
      !/<ShareDialog\s+v-if=/.test(block) && !/\n\s+v-if=/.test(block.slice(0, block.indexOf(':open'))),
      'ShareDialog 上有 v-if —— 离场动画会被跳过'
    )
    assert.ok(/:open="activeRow !== null"/.test(src), '应该用 :open 表达「有没有选中项」')
  })

  test('搜索框文案是「查找名字或位置」', () => {
    const src = read('app/pages/shares.vue')
    assert.ok(src.includes('placeholder="查找名字或位置"'))
  })

  test('页头只有标题，不再放一句解释（说明文案属于「作者写给自己看的」）', () => {
    const src = read('app/pages/shares.vue')
    const head = src.slice(src.indexOf('<h1'), src.indexOf('</div>', src.indexOf('<h1')))
    assert.ok(!/这里列出|点任意一项/.test(head), '页头还留着解释句')
  })

  test('行点击打开分享设置，勾选不冒泡', () => {
    const src = read('app/components/ShareSettingList.vue')
    assert.ok(/@click="emit\('open', row\)"/.test(src), '整行点击不是打开分享设置')
    assert.ok(/@click\.stop="emit\('locate', row\)"/.test(src), '「在文件里打开」必须 stop，否则会连带打开设置')
    assert.ok(/@change="emit\('toggle', row\)"/.test(src))
    assert.ok(!src.includes('emit(\'delete'), '这一页不该出现删除')
  })

  test('页面监听的每个事件，组件都真的 emit 了（名字对不上 = 静默失效）', () => {
    // 这个洞踩过一次：组件把 open-setting 改名成 open（为了和 locate/toggle 对齐），
    // 页面的 @open-setting 没人通知，点行毫无反应，而两边都「看着没问题」。
    // 所以从源码里把两边的名字对出来，不靠人眼。
    const page = read('app/pages/shares.vue')
    const list = read('app/components/ShareSettingList.vue')

    const declared = new Set(
      [...list.matchAll(/^\s{2}(\w+): \[/gm)].map((m) => m[1])
    )
    const emitted = new Set([...list.matchAll(/emit\('(\w+)'/g)].map((m) => m[1]))
    const listened = new Set(
      [...page.matchAll(/@(\w+)="(openSetting|locate|toggleRow)"/g)].map((m) => m[1])
    )

    assert.ok(listened.size >= 3, `页面只监听了 ${listened.size} 个事件`)
    for (const name of listened) {
      assert.ok(declared.has(name), `@${name} 组件的 defineEmits 里没有`)
      assert.ok(emitted.has(name), `@${name} 组件从未 emit —— 点了没反应`)
    }
    for (const name of emitted) {
      assert.ok(listened.has(name), `组件 emit 了 '${name}'，页面没监听`)
    }
  })

  test('「在文件里打开」走可收藏的 URL', () => {
    const src = read('app/pages/shares.vue')
    assert.ok(/query: \{ at: String\(folderId\) \}/.test(src), '落点没走 ?at=')
    const index = read('app/pages/index.vue')
    assert.ok(/atParam/.test(index) && index.includes('/api/folders/lineage'), '首页没解析 ?at=')
  })

  test('解析祖先链用 useRequestFetch（裸 $fetch 在 SSR 不带 cookie，深链会静默失效）', () => {
    const index = read('app/pages/index.vue')
    assert.ok(index.includes('useRequestFetch()'), 'SSR 取祖先链没转发 cookie')
  })

  test('清掉 ?at= 只在客户端做（SSR 阶段 navigateTo 会 302，指令还没进 payload 就丢了）', () => {
    const index = read('app/pages/index.vue')
    const block = index.slice(index.indexOf('const applyAtJump'))
    const body = block.slice(0, block.indexOf('\n\nwatch('))
    assert.ok(
      /if \(import\.meta\.client\)/.test(body),
      'navigateTo 没限制在客户端 —— SSR 下会 302 掉深链'
    )
  })

  test('三个跳转入口共用 initialJump 一条通道', () => {
    const browser = read('app/components/FileBrowser.vue')
    assert.ok(
      /watch\(\s*\(\) => props\.initialJump/.test(browser),
      'initialJump 必须能接住挂载后才到的指令（属主没变时组件不重建）'
    )
    assert.ok(!/defineExpose\([\s\S]*navigateToPath/.test(browser), '不该再暴露 navigateToPath —— 统一走通道')

    const manage = read('app/pages/manage/files.vue')
    assert.ok(/:initial-jump="pendingJump"/.test(manage), '文件管理页没接通道')
    assert.ok(!manage.includes('browserRef'), '还有直接调方法的旧路径')
  })

  test('FileList 没被动过（这一页自建列表）', () => {
    const src = read('app/components/FileList.vue')
    assert.ok(!src.includes('share-setting'), 'FileList 不该为这一页加东西')
  })
})
