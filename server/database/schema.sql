-- ==========================================
-- Schema: users + folders + files (SQLite)
-- Tree structure via folders (self-reference)
-- ==========================================

PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

-- -------- Cleanup (idempotent) --------
DROP TRIGGER IF EXISTS trg_files_user_matches_folder_ins;
DROP TRIGGER IF EXISTS trg_files_user_matches_folder_upd;
DROP TRIGGER IF EXISTS trg_folders_user_matches_parent_ins;
DROP TRIGGER IF EXISTS trg_folders_user_matches_parent_upd;
DROP TRIGGER IF EXISTS trg_folders_no_cycles;
DROP TRIGGER IF EXISTS trg_file_access_not_owner_ins;
DROP TRIGGER IF EXISTS trg_file_access_not_owner_upd;
DROP TRIGGER IF EXISTS trg_folder_access_not_owner_ins;
DROP TRIGGER IF EXISTS trg_folder_access_not_owner_upd;
DROP TRIGGER IF EXISTS trg_share_links_purge_file;
DROP TRIGGER IF EXISTS trg_share_links_purge_folder;

DROP INDEX IF EXISTS ux_folders_user_parent_name;
DROP INDEX IF EXISTS ix_folders_user;
DROP INDEX IF EXISTS ix_folders_parent;
DROP INDEX IF EXISTS ux_files_user_folder_filename;
DROP INDEX IF EXISTS ix_files_user;
DROP INDEX IF EXISTS ix_files_folder;
DROP INDEX IF EXISTS ix_file_access_file;
DROP INDEX IF EXISTS ix_file_access_user;
DROP INDEX IF EXISTS ix_folder_access_folder;
DROP INDEX IF EXISTS ix_folder_access_user;
DROP INDEX IF EXISTS ix_share_links_target;

DROP TABLE IF EXISTS file_access;
DROP TABLE IF EXISTS folder_access;
DROP TABLE IF EXISTS share_links;
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS folders;
DROP TABLE IF EXISTS users;

-- -------- users --------
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
  IsAdmin       BOOLEAN DEFAULT 0,
  IsSuperAdmin  BOOLEAN DEFAULT 0,
  usedStorage   BIGINT DEFAULT 0,
  maxStorage    BIGINT DEFAULT 1,
  usedDownload  BIGINT DEFAULT 0,
  maxDownload   BIGINT DEFAULT 1,
  -- 「出生即过期」是**故意的**，不是 bug。
  --
  -- 自助注册的账号一律先做成哑巴：额度 1B、流量 1B（上面两个默认值）、
  -- 且 expire_at 等于创建时刻 → 一出生就是过期账号，任何操作都被拒。
  -- 管理员要开通，才显式给一个未来的 expire_at 与真实额度。
  --
  -- 也就是说「注册成功」≠「能用」，中间隔着管理员这一道。
  -- 改成 DEFAULT NULL 会让每个自助注册的人拿到一个**永不过期**的账号，
  -- 那就等于拆掉这道门。
  --
  -- **这三个默认值（1 / 1 / CURRENT_TIMESTAMP）谁都不许改。**
  expire_at     TEXT DEFAULT CURRENT_TIMESTAMP,
  canChangePassword BOOLEAN DEFAULT 1,

  -- -------- 子账户 --------
  -- 父账号 id。NULL = 不是任何人的子账户（绝大多数行都是这个）。
  -- **故意不加外键**：SQLite 的 ON DELETE CASCADE 会把子账户整行悄悄删掉，
  -- 而 COS 物理删和配额退额都不在 SQLite 的级联里 —— 留下孤儿对象和漂移的账。
  -- 改成应用层拦截：删父账号时若还有子账户就拒绝（manage/deleteUser）。
  --
  -- **只允许一层**：parent_id 指向的行自己的 parent_id 必须为 NULL，
  -- 由 server/api/accounts/index.post.ts 校验。所以配额链最长 2 环。
  parent_id     INTEGER,

  -- 能不能建子账户。由管理员在「用户管理」里给，不是自己开的。
  -- 默认 0：不给这个开关，任何登录用户都能建子账号、再把文件分享出去，
  -- 外面的访客下载消耗的是他（作为主账号）的池。
  canSubAccount BOOLEAN DEFAULT 0,

  -- 最多能建几个子账户。0 = 不限（与 maxStorage/maxDownload 的口径一致）。
  -- 防滥用主要靠 canSubAccount 这个管理员开关，这个是第二道。
  maxSubAccount INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ix_users_parent_id ON users (parent_id);

-- -------- folders (tree) --------
CREATE TABLE folders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  parent_id   INTEGER,                         -- NULL = 用户根层
  name        TEXT NOT NULL,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT DEFAULT CURRENT_TIMESTAMP,

  -- 共享三态：0=不分享(拒绝型边界) 1=分享(边界，名单内放行) 2=继承(非边界，继续上溯)
  -- 注意：Shared 只管「要不要切断继承」，授权名单在 folder_access 里，二者互不干涉
  -- IsPublic 只是「给所有已登录用户 READ」的快捷写法，等价于一条 everyone 的授权。
  -- 注意是**已登录**：所有 /api/**（除 login/register/logout 外）都过 requireAuth，
  -- IsPublic 从来没有、也不会开出一个免登录的匿名入口。见 server/middleware/01.api-auth.ts
  Shared      INTEGER NOT NULL DEFAULT 2,
  IsPublic    BOOLEAN NOT NULL DEFAULT 0,

  FOREIGN KEY (user_id)   REFERENCES users(id)     ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES folders(id)   ON DELETE CASCADE,

  CHECK (name <> ''),
  CHECK (parent_id IS NULL OR parent_id <> id),    -- 禁止自己作为自己的父级
  CHECK (Shared IN (0, 1, 2))
);

-- 同一用户 + 同一父级下，文件夹名唯一（COALESCE 处理 NULL 父级）
CREATE UNIQUE INDEX ux_folders_user_parent_name
  ON folders (user_id, COALESCE(parent_id, -1), name);

CREATE INDEX ix_folders_user   ON folders(user_id);
CREATE INDEX ix_folders_parent ON folders(parent_id);

-- -------- files --------
CREATE TABLE files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  folder_id    INTEGER,                         -- NULL = 用户根层
  filename     TEXT NOT NULL,
  file_key     TEXT NOT NULL,
  file_size    BIGINT NOT NULL,
  file_url     TEXT NOT NULL,
  content_type TEXT,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,

  -- 共享三态：0=不分享(拒绝型边界) 1=分享(边界，名单内放行) 2=继承(非边界，继续上溯)
  -- Shared 只管要不要切断继承；本文件的直接授权在 file_access 里，与祖先授权取并集
  -- IsPublic 等价于「对所有已登录用户 READ」。不含未登录 —— 见上面 folders 那段说明
  Shared       INTEGER NOT NULL DEFAULT 2,
  IsPublic     BOOLEAN NOT NULL DEFAULT 0,

  FOREIGN KEY (user_id)   REFERENCES users (id)     ON DELETE CASCADE,
  FOREIGN KEY (folder_id) REFERENCES folders (id)   ON DELETE CASCADE
  -- 如果希望删除文件夹时保留文件，请改为：ON DELETE SET NULL

  CHECK (Shared IN (0, 1, 2))
);

-- 同一用户 + 同一文件夹下，文件名唯一
CREATE UNIQUE INDEX ux_files_user_folder_filename
  ON files (user_id, COALESCE(folder_id, -1), filename);

-- file_key（COS 真实对象路径）全局唯一。
-- 与上面那条互补：那条管「同一目录里不能重名」，这条管「同一个对象不能被
-- 两行指认」。少了它，权限判定（按 file_key 查一行）命中哪一行由 SQLite 自己
-- 决定，行为不确定。老库补这个索引走 server/plugins/db-migrate.ts（有重复行
-- 时会跳过并告警，不拖垮启动）。
CREATE UNIQUE INDEX ux_files_file_key ON files (file_key);

CREATE INDEX ix_files_user   ON files(user_id);
CREATE INDEX ix_files_folder ON files(folder_id);

-- -------- 授权表（位掩码：1=read 2=write 4=delete，包含关系 read ⊂ write ⊂ delete）--------
-- 授权信息只存在「最上层被标记的节点」上，子级靠 folder_access + 向上查找继承
-- file_access：直接授权到某个文件
CREATE TABLE file_access (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id    INTEGER NOT NULL,                  -- 一对多：指向 files.id
  user_id    INTEGER NOT NULL,
  permission INTEGER NOT NULL DEFAULT 1,        -- 位掩码，见上
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,

  UNIQUE (file_id, user_id),                    -- 同一人对同一文件只授权一次
  CHECK (permission >= 0)                       -- 不设上限，将来加位无需重建表
);

CREATE INDEX ix_file_access_file ON file_access(file_id);
CREATE INDEX ix_file_access_user ON file_access(user_id);

-- folder_access：授权到某个文件夹，其下所有文件/子文件夹继承（直到遇到下一个边界节点）
CREATE TABLE folder_access (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id   INTEGER NOT NULL,                 -- 一对多：指向 folders.id
  user_id     INTEGER NOT NULL,
  permission  INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (folder_id) REFERENCES folders (id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)   REFERENCES users (id)   ON DELETE CASCADE,

  UNIQUE (folder_id, user_id),
  CHECK (permission >= 0)
);

CREATE INDEX ix_folder_access_folder ON folder_access(folder_id);
CREATE INDEX ix_folder_access_user   ON folder_access(user_id);

-- -------- 分享链接（匿名 bearer token）--------
-- 与 file_access / folder_access 最大的不同：**没有 user_id**。持有 token 的人
-- 没有任何身份，所以权限是写死的（LINK_PERMISSION = 读 + 下载），不是逐人配的。
--
-- 链接挂在文件或文件夹上，并**向下继承**：从目标往上找第一个非继承节点，
-- 那儿挂着这条 token 才算数（见 server/utils/share-link.ts 的 linkGrants*）。
-- 祖先的链接因此能覆盖整棵子树，但遇到任何非继承后代就停 —— 那儿是道边界。
--
-- 不存 owner_id：扣费要的文件属主在 download 流程里本来就有，
-- 少一个会和 files/folders 漂移的冗余字段。
--
-- **没有外键** —— 目标是一对多的多态引用（target_type + target_id），
-- 单列外键表达不了，外键也不能写在两个表上（那样 UNIQUE/索引都要变成两套）。
-- 级联删除交给下面两个触发器做。目标没了 token 留着也没用（还多一把没用的钥匙），
-- 而 resolveLinkTarget 对「行还在但目标没了」也会按失效链接处理，两层都兜住。
CREATE TABLE share_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  link        TEXT    NOT NULL,                  -- 32 位小写 hex，见 SHARE_LINK_TOKEN_BYTES
  target_type TEXT    NOT NULL,                  -- 'file' | 'folder'
  target_id   INTEGER NOT NULL,
  created_at  TEXT    DEFAULT CURRENT_TIMESTAMP,

  UNIQUE (link),
  CHECK (target_type IN ('file', 'folder'))
);

CREATE INDEX ix_share_links_target ON share_links(target_type, target_id);

-- 级联删除：目标没了，链接一起消失。
-- 用触发器而不是外键，是因为多态引用没法声明外键，而级联这个行为不能省 ——
-- 留着孤儿链接会让「这个 token 到底指向什么」变成不确定的事。
CREATE TRIGGER trg_share_links_purge_file
AFTER DELETE ON files
WHEN EXISTS (SELECT 1 FROM share_links WHERE target_type = 'file' AND target_id = OLD.id)
BEGIN
  DELETE FROM share_links WHERE target_type = 'file' AND target_id = OLD.id;
END;

CREATE TRIGGER trg_share_links_purge_folder
AFTER DELETE ON folders
WHEN EXISTS (SELECT 1 FROM share_links WHERE target_type = 'folder' AND target_id = OLD.id)
BEGIN
  DELETE FROM share_links WHERE target_type = 'folder' AND target_id = OLD.id;
END;

-- -------- Triggers: 数据一致性 --------
-- 1) files.user_id 必须与其所属 folder 的 user_id 一致
CREATE TRIGGER trg_files_user_matches_folder_ins
BEFORE INSERT ON files
WHEN NEW.folder_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM folders f
      WHERE f.id = NEW.folder_id AND f.user_id = NEW.user_id
    )
    THEN RAISE(ABORT, 'files.user_id must match folders.user_id')
  END;
END;

CREATE TRIGGER trg_files_user_matches_folder_upd
BEFORE UPDATE OF folder_id, user_id ON files
WHEN NEW.folder_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM folders f
      WHERE f.id = NEW.folder_id AND f.user_id = NEW.user_id
    )
    THEN RAISE(ABORT, 'files.user_id must match folders.user_id')
  END;
END;

-- 2) 子文件夹与父文件夹必须属于同一用户
CREATE TRIGGER trg_folders_user_matches_parent_ins
BEFORE INSERT ON folders
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM folders p
      WHERE p.id = NEW.parent_id AND p.user_id = NEW.user_id
    )
    THEN RAISE(ABORT, 'folders.user_id must match parent user_id')
  END;
END;

CREATE TRIGGER trg_folders_user_matches_parent_upd
BEFORE UPDATE OF parent_id, user_id ON folders
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM folders p
      WHERE p.id = NEW.parent_id AND p.user_id = NEW.user_id
    )
    THEN RAISE(ABORT, 'folders.user_id must match parent user_id')
  END;
END;

-- 3) 防止形成环（循环父子关系）
CREATE TRIGGER trg_folders_no_cycles
BEFORE UPDATE OF parent_id ON folders
WHEN NEW.parent_id IS NOT NULL
BEGIN
  WITH RECURSIVE ancestors(id) AS (
    SELECT NEW.parent_id
    UNION ALL
    SELECT f.parent_id
    FROM folders f
    JOIN ancestors a ON f.id = a.id
    WHERE f.parent_id IS NOT NULL
  )
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM ancestors WHERE id = NEW.id)
    THEN RAISE(ABORT, 'Cycle detected in folder hierarchy')
  END;
END;

-- 4) 授权表：不能把文件/文件夹授权给所有者本人（冗余记录）
--    INSERT 和 UPDATE 都要拦，否则改 file_id/user_id 可绕过
CREATE TRIGGER trg_file_access_not_owner_ins
BEFORE INSERT ON file_access
WHEN NEW.user_id = (SELECT user_id FROM files WHERE id = NEW.file_id)
BEGIN
  SELECT RAISE(ABORT, 'file_access.user_id must differ from files.user_id');
END;

CREATE TRIGGER trg_file_access_not_owner_upd
BEFORE UPDATE OF file_id, user_id ON file_access
WHEN NEW.user_id = (SELECT user_id FROM files WHERE id = NEW.file_id)
BEGIN
  SELECT RAISE(ABORT, 'file_access.user_id must differ from files.user_id');
END;

CREATE TRIGGER trg_folder_access_not_owner_ins
BEFORE INSERT ON folder_access
WHEN NEW.user_id = (SELECT user_id FROM folders WHERE id = NEW.folder_id)
BEGIN
  SELECT RAISE(ABORT, 'folder_access.user_id must differ from folders.user_id');
END;

CREATE TRIGGER trg_folder_access_not_owner_upd
BEFORE UPDATE OF folder_id, user_id ON folder_access
WHEN NEW.user_id = (SELECT user_id FROM folders WHERE id = NEW.folder_id)
BEGIN
  SELECT RAISE(ABORT, 'folder_access.user_id must differ from folders.user_id');
END;

COMMIT;