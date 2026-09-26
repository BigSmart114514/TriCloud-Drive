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

DROP TABLE IF EXISTS file_access;
DROP TABLE IF EXISTS folder_access;
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
  expire_at     TEXT DEFAULT CURRENT_TIMESTAMP,
  canChangePassword BOOLEAN DEFAULT 1
);

-- -------- folders (tree) --------
CREATE TABLE folders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  parent_id   INTEGER,                         -- NULL = 用户根层
  name        TEXT NOT NULL,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT DEFAULT CURRENT_TIMESTAMP,

  -- 共享：Shared=是否为共享边界（向上查找在此终止）；IsPublic=该目录免登录可读
  -- 不变量：Shared=1 当且仅当 folder_access 中至少有一行
  -- 注意：边界是「命中即停」，所以公开的子目录会截断祖先的授权（只留只读）
  Shared      BOOLEAN NOT NULL DEFAULT 0,
  IsPublic    BOOLEAN NOT NULL DEFAULT 0,

  FOREIGN KEY (user_id)   REFERENCES users(id)     ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES folders(id)   ON DELETE CASCADE,

  CHECK (name <> ''),
  CHECK (parent_id IS NULL OR parent_id <> id)     -- 禁止自己作为自己的父级
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

  -- 共享：Shared=是否存在直接授权（仅用于不变量与 UI 标记，不作为边界）
  --       IsPublic=是否免登录可读（只增不减，与祖先授权取并集）
  -- 不变量：Shared=1 当且仅当 file_access 中至少有一行
  Shared       BOOLEAN NOT NULL DEFAULT 0,
  IsPublic     BOOLEAN NOT NULL DEFAULT 0,

  FOREIGN KEY (user_id)   REFERENCES users (id)     ON DELETE CASCADE,
  FOREIGN KEY (folder_id) REFERENCES folders (id)   ON DELETE CASCADE
  -- 如果希望删除文件夹时保留文件，请改为：ON DELETE SET NULL
);

-- 同一用户 + 同一文件夹下，文件名唯一
CREATE UNIQUE INDEX ux_files_user_folder_filename
  ON files (user_id, COALESCE(folder_id, -1), filename);

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