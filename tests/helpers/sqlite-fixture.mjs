// 分享相关的集成测试夹具：把 data.sqlite 复制到临时目录，在副本上造数据。
//
// 为什么不直接 import server/utils/db.ts：它依赖 Nuxt 的自动导入（createError 等全局）
// 和 sqlite3 封装，在 node --test 里跑不起来。所以测试复刻算法本体
// （各测试文件里逐字复制 + 标注源码行号），共用这份数据夹具。
//
// **绝不碰开发库**：复制到 mkdtemp 出来的目录，用完删掉。
import { createRequire } from 'node:module'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = new URL('../..', import.meta.url).pathname
const sqlite3 = require(join(ROOT, 'node_modules/sqlite3'))

/** 属主。测试树里的目录/文件都归他，访客另建 */
export const OWNER = 901
export const VISITOR = 900

const SHARE_INHERIT = 2

/**
 * share_links 建表语句 + 级联删除触发器，与 server/database/schema.sql 和
 * server/plugins/db-migrate.ts 保持一致。
 *
 * 这里自己建而不依赖开发库已经被迁移过 —— 否则「有没有先跑过 dev server」
 * 会变成测试能不能跑的前置条件，报错还长得像业务 bug。
 *
 * 目标是多态引用（target_type + target_id），所以没有外键：单列外键表达不了，
 * 外键也不能同时声明在 files 和 folders 上。级联删除靠下面两个触发器。
 */
const SHARE_LINKS_DDL = [
  `
    CREATE TABLE IF NOT EXISTS share_links (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      link        TEXT    NOT NULL,
      target_type TEXT    NOT NULL,
      target_id   INTEGER NOT NULL,
      created_at  TEXT    DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (link),
      CHECK (target_type IN ('file', 'folder'))
    )
  `,
  'CREATE INDEX IF NOT EXISTS ix_share_links_target ON share_links(target_type, target_id)',
  `
    CREATE TRIGGER IF NOT EXISTS trg_share_links_purge_file
    AFTER DELETE ON files
    WHEN EXISTS (SELECT 1 FROM share_links WHERE target_type = 'file' AND target_id = OLD.id)
    BEGIN
      DELETE FROM share_links WHERE target_type = 'file' AND target_id = OLD.id;
    END
  `,
  `
    CREATE TRIGGER IF NOT EXISTS trg_share_links_purge_folder
    AFTER DELETE ON folders
    WHEN EXISTS (SELECT 1 FROM share_links WHERE target_type = 'folder' AND target_id = OLD.id)
    BEGIN
      DELETE FROM share_links WHERE target_type = 'folder' AND target_id = OLD.id;
    END
  `
]

/** 自动生成的 token（32 位小写 hex，与 SHARE_LINK_TOKEN_BYTES=16 对应） */
export function fakeLink(seed) {
  return String(seed).padStart(32, '0')
}

export async function createShareFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'share-fixture-'))
  const path = join(dir, 'test.sqlite')
  copyFileSync(join(ROOT, 'data.sqlite'), path)
  const raw = new sqlite3.Database(path)

  const all = (q, p = []) => new Promise((res, rej) => raw.all(q, p, (e, r) => (e ? rej(e) : res(r || []))))
  const run = (q, p = []) =>
    new Promise((res, rej) => raw.run(q, p, function (e) { e ? rej(e) : res(this.changes) }))
  const get = async (q, p = []) => (await all(q, p))[0] ?? null

  for (const stmt of SHARE_LINKS_DDL) await run(stmt)

  // 清掉开发库的数据，只留干净的 users 表骨架
  await run('DELETE FROM folder_access')
  await run('DELETE FROM file_access')
  await run('DELETE FROM share_links')
  await run('DELETE FROM files')
  await run('DELETE FROM folders')
  await run('DELETE FROM users WHERE id >= 900')
  for (const id of [OWNER, VISITOR]) {
    // password_hash 是 NOT NULL，给个占位值即可，本套测试不碰认证
    await run('INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)', [
      id, `u${id}`, `u${id}@x`, 'x'
    ])
  }

  let linkSeq = 0

  const fx = {
    OWNER,
    VISITOR,
    all,
    run,
    get,

    /** 清空全部测试数据，回到空树 */
    async reset() {
      await run('DELETE FROM folder_access')
      await run('DELETE FROM file_access')
      await run('DELETE FROM share_links')
      await run('DELETE FROM files')
      await run('DELETE FROM folders')
      linkSeq = 0
    },

    /** 建目录。不传则默认挂在根层、继承态、非公开 */
    async mkFolder({ id, parentId = null, Shared = SHARE_INHERIT, IsPublic = 0, ownerId = OWNER, name }) {
      await run(
        'INSERT INTO folders (id, user_id, name, parent_id, Shared, IsPublic) VALUES (?, ?, ?, ?, ?, ?)',
        [id, ownerId, name ?? `f${id}`, parentId, Shared, IsPublic]
      )
      return id
    },

    /** 建文件。fileSize 默认 1，fileKey 默认按 id 生成 */
    async mkFile({
      id,
      folderId = null,
      Shared = SHARE_INHERIT,
      IsPublic = 0,
      ownerId = OWNER,
      filename,
      fileSize = 1,
      fileKey
    }) {
      await run(
        `INSERT INTO files (id, user_id, folder_id, filename, file_key, file_size, file_url, Shared, IsPublic)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, ownerId, folderId, filename ?? `f${id}.txt`, fileKey ?? `k/${id}`, fileSize, `url/${id}`, Shared, IsPublic]
      )
      return id
    },

    /** 授权：folderId 授予 userId */
    async grantFolder(folderId, userId, permission) {
      await run('INSERT INTO folder_access (folder_id, user_id, permission) VALUES (?, ?, ?)', [
        folderId, userId, permission
      ])
    },

    /** 授权：fileId 授予 userId */
    async grantFile(fileId, userId, permission) {
      await run('INSERT INTO file_access (file_id, user_id, permission) VALUES (?, ?, ?)', [
        fileId, userId, permission
      ])
    },

    /** 挂一个链接。link 省略时自动生成一个不会撞的 */
    async mkLink(targetType, targetId, link) {
      const token = link ?? fakeLink(++linkSeq)
      await run('INSERT INTO share_links (link, target_type, target_id) VALUES (?, ?, ?)', [
        token, targetType, targetId
      ])
      return token
    },

    /** 删掉某个链接 */
    async rmLink(link) {
      await run('DELETE FROM share_links WHERE link = ?', [link])
    },

    async close() {
      await new Promise((res) => raw.close(res))
      rmSync(dir, { recursive: true, force: true })
    }
  }

  return fx
}
