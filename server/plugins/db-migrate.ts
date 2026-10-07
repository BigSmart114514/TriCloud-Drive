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

const SQLITE_BUCKET_PURGE_LOG = `
  CREATE TABLE bucket_purge_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT    NOT NULL,
    user_id    INTEGER NOT NULL,
    count      INTEGER NOT NULL DEFAULT 0,
    bytes      INTEGER NOT NULL DEFAULT 0,
    actor_id   INTEGER NOT NULL,
    payload    TEXT    NOT NULL,
    created_at TEXT    DEFAULT CURRENT_TIMESTAMP
  )
`

const MYSQL_BUCKET_PURGE_LOG = `
  CREATE TABLE bucket_purge_log (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    kind       VARCHAR(32) NOT NULL,
    user_id    BIGINT UNSIGNED NOT NULL,
    count      BIGINT UNSIGNED NOT NULL DEFAULT 0,
    bytes      BIGINT UNSIGNED NOT NULL DEFAULT 0,
    actor_id   BIGINT UNSIGNED NOT NULL,
    payload    TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY ix_bucket_purge_user (user_id)
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

    // 2) 子账户
    // 三列都是「加不改」：ALTER TABLE ADD COLUMN 对已有库安全，对新库是空操作
    // （schema.sql 里已经带了），两种情况都靠 columnExists 判定。
    // parent_id 故意不加外键，理由写在 schema.sql 的 users 表定义里。
    for (const col of ['parent_id', 'canSubAccount', 'maxSubAccount']) {
      if (await columnExists(db, 'users', col)) continue
      const ddl = col === 'parent_id'
        ? 'ALTER TABLE users ADD COLUMN parent_id INTEGER'
        : col === 'canSubAccount'
          ? 'ALTER TABLE users ADD COLUMN canSubAccount BOOLEAN DEFAULT 0'
          : 'ALTER TABLE users ADD COLUMN maxSubAccount INTEGER DEFAULT 0'
      await db.prepare(ddl).bind().run()
      console.log(`[db-migrate] users.${col} added`)
    }
    {
      const res = await db
        .prepare(isMysqlDb()
          ? "SELECT 1 AS ok FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'ix_users_parent_id'"
          : "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ix_users_parent_id'")
        .bind()
        .all()
      if (!res?.results?.length) {
        await db.prepare('CREATE INDEX ix_users_parent_id ON users (parent_id)').bind().run()
        console.log('[db-migrate] ix_users_parent_id created')
      }
    }

    // 3) 授权表
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

    // 4) 分享链接表
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

    // 5) file_key 唯一索引
    //
    // 为什么要：file_key 是 COS 里的真实对象路径，权限判定又是「按它查一行」。
    // 没有唯一约束时同一个路径可以有多行，命中哪一行由 SQLite 自己决定
    // （原查询连 ORDER BY 都没有）—— 行为不确定本身就是缺陷。
    //
    // 与 ux_files_user_folder_filename 互补：那个管「同一目录里不能重名」，
    // 这个管「同一个对象不能被两行指认」。上传用 uuid、复制用时间戳+随机数，
    // 正常路径不会撞，所以加约束不影响任何现存写入。
    if (!(await indexExists(db, 'ux_files_file_key'))) {
      if (await hasDuplicateFileKeys(db)) {
        // 有重复就不建：建索引会报错拖垮启动。写入侧的前缀校验（file-key.ts）
        // 和 download.post.ts 签 fileRecord.fileKey 已经挡住了越权，这里只是
        // 收窄重复行的影响面，不补也不会开出新洞。
        console.warn(
          '[db-migrate] files.file_key 有重复行，跳过 ux_files_file_key（请人工去重后重启）'
        )
      } else {
        try {
          await db.prepare('CREATE UNIQUE INDEX ux_files_file_key ON files(file_key)').bind().run()
          console.log('[db-migrate] ux_files_file_key created')
        } catch (e) {
          // 唯一约束不是安全边界的一部分，不该因为它起不来
          console.warn('[db-migrate] ux_files_file_key 创建失败，继续启动：', e)
        }
      }
    }

    // 6) 所有者守卫触发器
    if (!mysql) {
      for (const trigger of OWNER_GUARD_TRIGGERS) {
        if (await triggerExists(db, trigger.name)) continue
        await db.prepare(trigger.sql).bind().run()
        console.log(`[db-migrate] ${trigger.name} created`)
      }
    }

    // 7) 分享链接的级联删除。两种方言语法相同，所以不加 !mysql 守卫
    for (const trigger of SHARE_LINK_PURGE_TRIGGERS) {
      if (await triggerExists(db, trigger.name)) continue
      await db.prepare(trigger.sql).bind().run()
      console.log(`[db-migrate] ${trigger.name} created`)
    }

    // 8) 共享模式三态化：**这里原本有一段数据回填，已于 2026-09-29 整段删除，不要再加回来。**
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

    // 9) 存储桶清理审计
    //
    // 为什么要有：这个项目原本**没有审计表**（purge-user.ts 只有 console.warn，
    // 而那在容器/serverless 上随时可能没），而存储桶管理的两个删除方向都是
    // 不可逆的 —— 孤儿对象删掉字节就没了，悬空行删掉文件名/位置/时间就没了。
    // 一键删 N 条而不留记录，等于「删错了也没法回答用户」。
    //
    // kind 区分两种删除（'orphan-object' / 'dangling-row'）而不是建两张表：
    // 查询「这个用户被清理过什么」时两种要一起看，拆开反而要多写一次 join。
    //
    // payload 存 JSON 快照而不是外键到 files —— 悬空行被删掉之后外键就没了，
    // 审计表会跟着一起失去意义。存快照才能回答「当时删掉的到底是什么」。
    //
    // 故意**不建外键到 users**：删用户时审计记录必须留下来，
    // 而 ON DELETE CASCADE 会把它一起带走 —— 恰好在「用户投诉文件丢了」
    // 的时候把唯一的账本清掉。
    if (!(await tableExists(db, 'bucket_purge_log'))) {
      await db.prepare(mysql ? MYSQL_BUCKET_PURGE_LOG : SQLITE_BUCKET_PURGE_LOG).bind().run()
      console.log('[db-migrate] bucket_purge_log created')
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

/**
 * file_key 是否有重复行。
 *
 * 加 UNIQUE 索引前必须先查：sqlite 的 CREATE UNIQUE INDEX 撞到重复行会直接
 * 报错，迁移插件抛出去，服务起不来。老库里若有重复（file_key 曾经没有任何
 * 唯一约束），这里返回 true 让调用方跳过 + 告警，而不是让整个实例挂掉。
 *
 * 查不出来（.catch 吞了）时返回 false：不拦，让调用方去建。建失败也是同一个
 * catch 路径，等价于跳过 —— 宁可少一个索引，也不要因为索引把服务卡住。
 */
async function hasDuplicateFileKeys(db: any): Promise<boolean> {
  const res = await db
    .prepare('SELECT file_key FROM files GROUP BY file_key HAVING COUNT(*) > 1 LIMIT 1')
    .bind()
    .all()
    .catch(() => null)
  if (res === null) return false
  return Boolean(res?.results?.length)
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
