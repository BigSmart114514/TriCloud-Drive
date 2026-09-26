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

    // 1) files / folders 的共享标记
    for (const [table, column] of [
      ['files', 'Shared'],
      ['files', 'IsPublic'],
      ['folders', 'Shared'],
      ['folders', 'IsPublic']
    ]) {
      if (await columnExists(db, table, column)) continue
      await db
        .prepare(`ALTER TABLE ${table} ADD COLUMN ${column} BOOLEAN NOT NULL DEFAULT 0`)
        .bind()
        .run()
      console.log(`[db-migrate] ${table}.${column} added`)
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

    // 3) 所有者守卫触发器
    if (!mysql) {
      for (const trigger of OWNER_GUARD_TRIGGERS) {
        if (await triggerExists(db, trigger.name)) continue
        await db.prepare(trigger.sql).bind().run()
        console.log(`[db-migrate] ${trigger.name} created`)
      }
    }
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
