// 启动时自动迁移：共享相关字段与授权表
// 逐项检测后再执行，天然幂等，可重复启动

const SQLITE_FILE_ACCESS = `
  CREATE TABLE file_access (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    permission INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,

    UNIQUE (file_id, user_id),
    CHECK (permission >= 0)
  )
`

const SQLITE_FOLDER_ACCESS = `
  CREATE TABLE folder_access (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id   INTEGER NOT NULL,
    user_id     INTEGER NOT NULL,
    permission  INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (folder_id) REFERENCES folders (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)   REFERENCES users (id)   ON DELETE CASCADE,

    UNIQUE (folder_id, user_id),
    CHECK (permission >= 0)
  )
`

const MYSQL_FILE_ACCESS = `
  CREATE TABLE file_access (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    file_id    BIGINT UNSIGNED NOT NULL,
    user_id    BIGINT UNSIGNED NOT NULL,
    permission INT NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY ux_file_access_file_user (file_id, user_id),
    KEY ix_file_access_user (user_id),
    CONSTRAINT fk_file_access_file FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE,
    CONSTRAINT fk_file_access_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  )
`

const MYSQL_FOLDER_ACCESS = `
  CREATE TABLE folder_access (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    folder_id   BIGINT UNSIGNED NOT NULL,
    user_id     BIGINT UNSIGNED NOT NULL,
    permission  INT NOT NULL DEFAULT 1,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY ux_folder_access_folder_user (folder_id, user_id),
    KEY ix_folder_access_user (user_id),
    CONSTRAINT fk_folder_access_folder FOREIGN KEY (folder_id) REFERENCES folders (id) ON DELETE CASCADE,
    CONSTRAINT fk_folder_access_user   FOREIGN KEY (user_id)   REFERENCES users (id)   ON DELETE CASCADE
  )
`

// SQLite / D1 才有 RAISE(ABORT)，MySQL 的等价约束交给 service 层
const OWNER_GUARD_TRIGGERS = [
  {
    name: 'trg_file_access_not_owner_ins',
    sql: `
      CREATE TRIGGER trg_file_access_not_owner_ins
      BEFORE INSERT ON file_access
      WHEN NEW.user_id = (SELECT user_id FROM files WHERE id = NEW.file_id)
      BEGIN
        SELECT RAISE(ABORT, 'file_access.user_id must differ from files.user_id');
      END`
  },
  {
    name: 'trg_file_access_not_owner_upd',
    sql: `
      CREATE TRIGGER trg_file_access_not_owner_upd
      BEFORE UPDATE OF file_id, user_id ON file_access
      WHEN NEW.user_id = (SELECT user_id FROM files WHERE id = NEW.file_id)
      BEGIN
        SELECT RAISE(ABORT, 'file_access.user_id must differ from files.user_id');
      END`
  },
  {
    name: 'trg_folder_access_not_owner_ins',
    sql: `
      CREATE TRIGGER trg_folder_access_not_owner_ins
      BEFORE INSERT ON folder_access
      WHEN NEW.user_id = (SELECT user_id FROM folders WHERE id = NEW.folder_id)
      BEGIN
        SELECT RAISE(ABORT, 'folder_access.user_id must differ from folders.user_id');
      END`
  },
  {
    name: 'trg_folder_access_not_owner_upd',
    sql: `
      CREATE TRIGGER trg_folder_access_not_owner_upd
      BEFORE UPDATE OF folder_id, user_id ON folder_access
      WHEN NEW.user_id = (SELECT user_id FROM folders WHERE id = NEW.folder_id)
      BEGIN
        SELECT RAISE(ABORT, 'folder_access.user_id must differ from folders.user_id');
      END`
  }
]

const SQLITE_SHARE_LINKS = `
  CREATE TABLE share_links (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    link        TEXT    NOT NULL,
    target_type TEXT    NOT NULL,
    target_id   INTEGER NOT NULL,
    created_at  TEXT    DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (link),
    CHECK (target_type IN ('file', 'folder'))
  )
`

const MYSQL_SHARE_LINKS = `
  CREATE TABLE share_links (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    link        VARCHAR(64) NOT NULL,
    target_type VARCHAR(8)  NOT NULL,
    target_id   BIGINT UNSIGNED NOT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY ux_share_links_link (link),
    KEY ix_share_links_target (target_type, target_id)
  )
`

/**
 * 目标删除时清掉它的分享链接。
 *
 * 用触发器而不是外键：share_links 的目标是**多态引用**（target_type + target_id），
 * 单列外键表达不了，外键也不能同时声明在 files 和 folders 上。所以级联删除
 * 只能靠触发器 —— 而这个行为不能省：留下孤儿 token 会让「它到底指向什么」
 * 变成不确定的事，持有者拿着它能探到 id 已复用后的别的东西。
 *
 * 两种方言的这段语法一样，所以不像 OWNER_GUARD_TRIGGERS 那样只对 SQLite 建。
 */
const SHARE_LINK_PURGE_TRIGGERS = [
  {
    name: 'trg_share_links_purge_file',
    sql: `
      CREATE TRIGGER trg_share_links_purge_file
      AFTER DELETE ON files
      WHEN EXISTS (SELECT 1 FROM share_links WHERE target_type = 'file' AND target_id = OLD.id)
      BEGIN
        DELETE FROM share_links WHERE target_type = 'file' AND target_id = OLD.id;
      END`
  },
  {
    name: 'trg_share_links_purge_folder',
    sql: `
      CREATE TRIGGER trg_share_links_purge_folder
      AFTER DELETE ON folders
      WHEN EXISTS (SELECT 1 FROM share_links WHERE target_type = 'folder' AND target_id = OLD.id)
      BEGIN
        DELETE FROM share_links WHERE target_type = 'folder' AND target_id = OLD.id;
      END`
  }
]

export default defineNitroPlugin(async () => {
  // D1 没有 event 上下文，只能用 wrangler d1 execute 迁移，这里跳过避免误建空 sqlite 文件
  if ((process.env.NITRO_PRESET || '').startsWith('cloudflare')) {
    console.log('[db-migrate] skipped on Cloudflare, apply via wrangler d1 execute')
    return
  }

  const db = getDb({ context: {} } as any)
  if (!db) return

  try {
    if (!(await tableExists(db, 'files'))) return
    const mysql = isMysqlDb()

    // 1) 共享标记
    for (const table of ['files', 'folders']) {
      for (const column of ['Shared', 'IsPublic']) {
        if (await columnExists(db, table, column)) continue
        await db
          .prepare(`ALTER TABLE ${table} ADD COLUMN ${column} BOOLEAN NOT NULL DEFAULT 0`)
          .bind()
          .run()
        console.log(`[db-migrate] ${table}.${column} added`)
      }
    }

    // 2) 授权表
    if (!(await tableExists(db, 'file_access'))) {
      await db.prepare(mysql ? MYSQL_FILE_ACCESS : SQLITE_FILE_ACCESS).bind().run()
      console.log('[db-migrate] file_access created')
    }
    // 老库里的 file_access 没有 permission 列
    if (!(await columnExists(db, 'file_access', 'permission'))) {
      await db
        .prepare('ALTER TABLE file_access ADD COLUMN permission INTEGER NOT NULL DEFAULT 1')
        .bind()
        .run()
      console.log('[db-migrate] file_access.permission added')
    }

    if (!(await tableExists(db, 'folder_access'))) {
      await db.prepare(mysql ? MYSQL_FOLDER_ACCESS : SQLITE_FOLDER_ACCESS).bind().run()
      console.log('[db-migrate] folder_access created')
    }

    // MySQL 的 UNIQUE 键左前缀已覆盖按目标查询，这两条只在 SQLite/D1 补
    for (const [table, index, column] of [
      ['file_access', 'ix_file_access_file', 'file_id', true],
      ['file_access', 'ix_file_access_user', 'user_id', false],
      ['folder_access', 'ix_folder_access_folder', 'folder_id', true],
      ['folder_access', 'ix_folder_access_user', 'user_id', false]
    ] as [string, string, string, boolean][]) {
      if (mysql && !column) continue
      if (await indexExists(db, index)) continue
      await db.prepare(`CREATE INDEX ${index} ON ${table}(${column})`).bind().run()
      console.log(`[db-migrate] ${index} created`)
    }

    // 3) 分享链接表
    //
    // 新表而不是新列，所以只需 tableExists 判断，天然幂等。
    // 单独一张表而不是往 files/folders 上加列：链接是 0..n 的（挂几个 token 都行），
    // 而 token 是随机串、要按 token 查、还要跟删除级联 —— 列存不下，拆不开。
    //
    // 只建表，不回填任何数据：链接是运行时生成的，没有「旧链接」可迁。
    if (!(await tableExists(db, 'share_links'))) {
      await db.prepare(mysql ? MYSQL_SHARE_LINKS : SQLITE_SHARE_LINKS).bind().run()
      console.log('[db-migrate] share_links created')
    }
    // MySQL 的 DDL 里已经带了 ix_share_links_target，只在 SQLite/D1 补
    if (!mysql && !(await indexExists(db, 'ix_share_links_target'))) {
      await db.prepare('CREATE INDEX ix_share_links_target ON share_links(target_type, target_id)').bind().run()
      console.log('[db-migrate] ix_share_links_target created')
    }

    // 4) 所有者守卫触发器
    if (!mysql) {
      for (const trigger of OWNER_GUARD_TRIGGERS) {
        if (await triggerExists(db, trigger.name)) continue
        await db.prepare(trigger.sql).bind().run()
        console.log(`[db-migrate] ${trigger.name} created`)
      }
    }

    // 5) 分享链接的级联删除。两种方言语法相同，所以不加 !mysql 守卫
    for (const trigger of SHARE_LINK_PURGE_TRIGGERS) {
      if (await triggerExists(db, trigger.name)) continue
      await db.prepare(trigger.sql).bind().run()
      console.log(`[db-migrate] ${trigger.name} created`)
    }

    // 6) 共享模式三态化：**这里原本有一段数据回填，已于 2026-09-29 整段删除，不要再加回来。**
    //
    //    删掉的原因（踩过的坑，记下来免得重犯）：
    //    那段回填的前提是「旧两态语义下 Shared=1 ⟺ folder_access 里有授权行」，
    //    于是把 `WHERE Shared IN (0,1)` 的行按「有无授权行」改写成 1 或 2。
    //    但三态化之后这两个字段是**互不干涉**的（见 folders 表的列注释）：
    //    Shared 只决定要不要切断继承，名单在 folder_access 里。
    //    0=不分享 / 1=分享 都是「边界」，名单为空完全合法：
    //      「此目录不对任何人开放，但也不继承上级」就是 1 + 空名单。
    //
    //    插件里没有迁移版本表，所以 `Shared IN (0,1)` 分不清
    //    「还没迁移的旧行」和「迁移早已跑过、用户后来又设成的行」，
    //    于是每次启动都会把后者当成前者，静默把边界降级成继承 ——
    //    上级授权就此漏进来，属于放大权限。IsPublic 不动，界面上还看不出异常。
    //    这段「天然幂等」的自我评价对它是错的。
    //
    //    生产库当时还没有任何分享数据，没有可保留的旧语义，直接不迁移即可。
    //    新库的 folders.Shared 建表就是 DEFAULT 2 且带 CHECK (Shared IN (0,1,2))，
    //    见下面 columnExists 那段与建表 SQL，不需要任何数据搬运。
  } catch (error: any) {
    console.error('[db-migrate] failed:', error?.message || error)
  }
})

function isMysqlDb() {
  const config = useRuntimeConfig()
  const m = config?.mysql || {}
  return Boolean(
    (m.host && m.user && m.password !== undefined && m.database) ||
    config?.mysqlUrl ||
    (process.env.MYSQL_HOST && process.env.MYSQL_USER && process.env.MYSQL_DATABASE) ||
    process.env.DATABASE_URL?.startsWith?.('mysql://')
  )
}

async function tableExists(db: any, table: string) {
  const sql = isMysqlDb()
    ? 'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?'
    : "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
  const res = await db.prepare(sql).bind(table).all()
  return Boolean(res?.results?.length)
}

async function columnExists(db: any, table: string, column: string) {
  if (isMysqlDb()) {
    const res = await db
      .prepare(
        'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?'
      )
      .bind(table)
      .all()
    return Boolean(res?.results?.some((row: any) => row.name === column))
  }
  const res = await db.prepare(`PRAGMA table_info(${table})`).bind().all()
  return Boolean(res?.results?.some((row: any) => row.name === column))
}

async function indexExists(db: any, index: string) {
  const sql = isMysqlDb()
    ? 'SELECT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME = ?'
    : "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?"
  const res = await db.prepare(sql).bind(index).all()
  return Boolean(res?.results?.length)
}

async function triggerExists(db: any, name: string) {
  const res = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?")
    .bind(name)
    .all()
  return Boolean(res?.results?.length)
}
