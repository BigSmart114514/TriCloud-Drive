// 启动时自动迁移：为 files 补齐共享相关字段与 file_access 表
// 逐项检测后再执行，天然幂等，可重复启动

const SQLITE_FILE_ACCESS = `
  CREATE TABLE file_access (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,

    UNIQUE (file_id, user_id)
  )
`

const MYSQL_FILE_ACCESS = `
  CREATE TABLE file_access (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    file_id    BIGINT UNSIGNED NOT NULL,
    user_id    BIGINT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY ux_file_access_file_user (file_id, user_id),
    CONSTRAINT fk_file_access_file FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE,
    CONSTRAINT fk_file_access_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  )
`

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

    for (const column of ['Shared', 'IsPublic']) {
      if (await columnExists(db, 'files', column)) continue
      await db
        .prepare(`ALTER TABLE files ADD COLUMN ${column} BOOLEAN NOT NULL DEFAULT 0`)
        .bind()
        .run()
      console.log(`[db-migrate] files.${column} added`)
    }

    if (!(await tableExists(db, 'file_access'))) {
      await db
        .prepare(isMysqlDb() ? MYSQL_FILE_ACCESS : SQLITE_FILE_ACCESS)
        .bind()
        .run()
      console.log('[db-migrate] file_access created')
      await db
        .prepare('CREATE INDEX ix_file_access_file ON file_access(file_id)')
        .bind()
        .run()
    }

    if (!isMysqlDb() && !(await triggerExists(db, 'trg_file_access_not_owner_ins'))) {
      await db
        .prepare(`
          CREATE TRIGGER trg_file_access_not_owner_ins
          BEFORE INSERT ON file_access
          WHEN NEW.user_id = (SELECT user_id FROM files WHERE id = NEW.file_id)
          BEGIN
            SELECT RAISE(ABORT, 'file_access.user_id must differ from files.user_id');
          END
        `)
        .bind()
        .run()
      console.log('[db-migrate] trg_file_access_not_owner_ins created')
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

async function triggerExists(db: any, name: string) {
  const res = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?")
    .bind(name)
    .all()
  return Boolean(res?.results?.length)
}
