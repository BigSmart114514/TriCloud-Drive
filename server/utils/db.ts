import { placeholders, uniqPositiveInts } from './functions'
import { fileNotFoundError, folderNotFindError } from '~~/types/error'

export interface User {
  id: number
  email: string
  username: string
  password_hash: string
  created_at: string
  IsAdmin: boolean
  IsSuperAdmin: boolean
  usedStorage: number
  maxStorage: number
  usedDownload: number
  maxDownload: number
  expire_at: string
  canChangePassword: boolean
}

export interface Database {
  prepare(query: string): {
    bind(...args: any[]): {
      first(): Promise<any>
      all(): Promise<{ results: any[] }>
      run(): Promise<{ success: boolean; meta: any }>
    }
  }
}

export class UserService {
  private db: Database

  constructor(db: Database) {
    this.db = db
  }

  async createUser(email: string, username: string, passwordHash: string): Promise<User | null> {
    try {
      const result = await this.db
        .prepare('INSERT INTO users (email, username, password_hash) VALUES (?, ?, ?) RETURNING *')
        .bind(email, username, passwordHash)
        .first()
      
      return result as User
    } catch (error) {
      console.error('Error creating user:', error)
      return null
    }
  }

  async getUserByEmail(email: string): Promise<User | null> {
    try {
      const user = await this.db
        .prepare('SELECT * FROM users WHERE email = ?')
        .bind(email)
        .first()
      
      return user as User || null
    } catch (error) {
      console.error('Error getting user by email:', error)
      return null
    }
  }
  async getUserByUsername(username: string): Promise<User | null> {
    try {
      const user = await this.db
        .prepare('SELECT * FROM users WHERE username = ?')
        .bind(username)
        .first()
      
      return user as User || null
    } catch (error) {
      console.error('Error getting user by username:', error)
      return null
    }
  }

  async getUserById(id: number): Promise<User | null> {
    try {
      const user = await this.db
        .prepare('SELECT * FROM users WHERE id = ?')
        .bind(id)
        .first()
      
      return user as User || null
    } catch (error) {
      console.error('Error getting user by id:', error)
      return null
    }
  }
}

export interface OwnedFolder {
  id: number
  userId: number
  name: string
  parentId: number | null
  createdAt: string
  updatedAt: string | null
}

export interface OwnedFile {
  id: number
  userId: number
  folderId: number | null
  filename: string
  fileKey: string
  fileSize: number
  fileUrl: string
  contentType: string | null
  createdAt: string
  Shared: boolean
  IsPublic: boolean
  allowedUsers: number[]
}

export interface ManifestFile {
  id: number
  filename: string
  fileKey: string
  fileSize: number
  relDir: string
}

function toBool(value: any): boolean {
  return value === true || value === 1 || value === '1'
}

function toOwnedFolder(row: any): OwnedFolder {
  return {
    id: Number(row.id),
    userId: Number(row.userId ?? row.user_id),
    name: row.name,
    parentId: row.parentId === null || row.parentId === undefined ? null : Number(row.parentId),
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at ?? null
  }
}

function toOwnedFile(row: any): OwnedFile {
  return {
    id: Number(row.id),
    userId: Number(row.userId ?? row.user_id),
    folderId: row.folderId === null || row.folderId === undefined ? null : Number(row.folderId),
    filename: row.filename,
    fileKey: row.fileKey ?? row.file_key,
    fileSize: Number(row.fileSize ?? row.file_size),
    fileUrl: row.fileUrl ?? row.file_url,
    contentType: row.contentType ?? row.content_type ?? null,
    createdAt: row.createdAt ?? row.created_at,
    Shared: toBool(row.Shared),
    IsPublic: toBool(row.IsPublic),
    allowedUsers: []
  }
}

const FOLDER_COLUMNS = 'id, user_id AS userId, name, parent_id AS parentId, created_at AS createdAt, updated_at AS updatedAt'

/**
 * 文件夹归属校验：所有读写都必须经过这里，SQL 里始终带 user_id
 * find* 返回 null，assert* 直接抛 404
 */
export class FolderService {
  private db: Database

  constructor(db: Database) {
    this.db = db
  }

  async findOwnedById(userId: number, folderId: number): Promise<OwnedFolder | null> {
    const row = await this.db
      .prepare(`SELECT ${FOLDER_COLUMNS} FROM folders WHERE id = ? AND user_id = ?`)
      .bind(folderId, userId)
      .first()
    return row ? toOwnedFolder(row) : null
  }

  /** folderId 为 null 表示根层，根层天然归属当前用户，直接放行 */
  async assertOwned(userId: number, folderId: number | null): Promise<OwnedFolder | null> {
    if (folderId === null || folderId === undefined) return null
    const folder = await this.findOwnedById(userId, folderId)
    if (!folder) throw folderNotFindError
    return folder
  }

  async findOwnedMany(userId: number, folderIds: number[]): Promise<OwnedFolder[]> {
    if (!folderIds.length) return []
    const res = await this.db
      .prepare(
        `SELECT ${FOLDER_COLUMNS} FROM folders WHERE user_id = ? AND id IN (${placeholders(folderIds.length)})`
      )
      .bind(userId, ...folderIds)
      .all()
    return (res?.results || []).map(toOwnedFolder)
  }

  async assertOwnedMany(userId: number, folderIds: number[]): Promise<OwnedFolder[]> {
    const ids = uniqPositiveInts(folderIds)
    const owned = await this.findOwnedMany(userId, ids)
    if (owned.length !== ids.length) throw folderNotFindError
    return owned
  }

  async listChildren(userId: number, parentId: number | null): Promise<OwnedFolder[]> {
    const sql = parentId === null
      ? `SELECT ${FOLDER_COLUMNS} FROM folders WHERE user_id = ? AND parent_id IS NULL ORDER BY name COLLATE NOCASE ASC`
      : `SELECT ${FOLDER_COLUMNS} FROM folders WHERE user_id = ? AND parent_id = ? ORDER BY name COLLATE NOCASE ASC`
    const args = parentId === null ? [userId] : [userId, parentId]
    const res = await this.db.prepare(sql).bind(...args).all()
    return (res?.results || []).map(toOwnedFolder)
  }

  async listChildrenByParentIds(userId: number, parentIds: number[]): Promise<OwnedFolder[]> {
    if (!parentIds.length) return []
    const res = await this.db
      .prepare(
        `SELECT ${FOLDER_COLUMNS} FROM folders WHERE user_id = ? AND parent_id IN (${placeholders(parentIds.length)})`
      )
      .bind(userId, ...parentIds)
      .all()
    return (res?.results || []).map(toOwnedFolder)
  }

  /** 逐层向下展开子树，每一跳都带 user_id，跨用户目录不会被带出 */
  async listDescendantIds(userId: number, folderId: number): Promise<number[]> {
    const res = await this.db
      .prepare(`
        WITH RECURSIVE cte(id) AS (
          SELECT id FROM folders WHERE id = ? AND user_id = ?
          UNION ALL
          SELECT f.id FROM folders f
          JOIN cte ON f.parent_id = cte.id
          WHERE f.user_id = ?
        )
        SELECT id FROM cte
      `)
      .bind(folderId, userId, userId)
      .all()
    return (res?.results || []).map((row: any) => Number(row.id))
  }

  async getParentId(userId: number, folderId: number): Promise<number | null> {
    const row = await this.db
      .prepare('SELECT parent_id AS parentId FROM folders WHERE user_id = ? AND id = ?')
      .bind(userId, folderId)
      .first()
    if (!row || row.parentId === null || row.parentId === undefined) return null
    return Number(row.parentId)
  }

  async findByName(userId: number, parentId: number | null, name: string): Promise<OwnedFolder | null> {
    const sql = parentId === null
      ? `SELECT ${FOLDER_COLUMNS} FROM folders WHERE user_id = ? AND parent_id IS NULL AND name = ? LIMIT 1`
      : `SELECT ${FOLDER_COLUMNS} FROM folders WHERE user_id = ? AND parent_id = ? AND name = ? LIMIT 1`
    const args = parentId === null ? [userId, name] : [userId, parentId, name]
    const row = await this.db.prepare(sql).bind(...args).first()
    return row ? toOwnedFolder(row) : null
  }

  async updateName(userId: number, folderId: number, name: string): Promise<number> {
    const res = await this.db
      .prepare('UPDATE folders SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
      .bind(name, folderId, userId)
      .run()
    return Number(res?.meta?.changes ?? 0)
  }

  async deleteOwned(userId: number, folderIds: number[]): Promise<number> {
    if (!folderIds.length) return 0
    const res = await this.db
      .prepare(`DELETE FROM folders WHERE user_id = ? AND id IN (${placeholders(folderIds.length)})`)
      .bind(userId, ...folderIds)
      .run()
    return Number(res?.meta?.changes ?? 0)
  }

  /** 整棵子树的打包清单（带相对路径），每一跳都限定 user_id */
  async listSubtreeManifest(userId: number, folderId: number): Promise<ManifestFile[]> {
    const res = await this.db
      .prepare(`
        WITH RECURSIVE tree(id, name, parent_id, rel_dir) AS (
          SELECT id, name, parent_id, '' AS rel_dir
          FROM folders
          WHERE id = ? AND user_id = ?
          UNION ALL
          SELECT f.id, f.name, f.parent_id,
            CASE
              WHEN tree.rel_dir = '' THEN f.name
              ELSE tree.rel_dir || '/' || f.name
            END AS rel_dir
          FROM folders f
          JOIN tree ON f.parent_id = tree.id
          WHERE f.user_id = ?
        )
        SELECT fl.id       AS id,
               fl.filename AS filename,
               fl.file_key AS fileKey,
               fl.file_size AS fileSize,
               tree.rel_dir AS relDir
        FROM files fl
        JOIN tree ON fl.folder_id = tree.id
        WHERE fl.user_id = ?
        ORDER BY relDir, filename
      `)
      .bind(folderId, userId, userId, userId)
      .all()
    return (res?.results || []) as ManifestFile[]
  }

  async countChildren(userId: number, folderId: number): Promise<number> {
    const res = await this.db
      .prepare('SELECT COUNT(*) AS total FROM folders WHERE user_id = ? AND parent_id = ?')
      .bind(userId, folderId)
      .first()
    return Number(res?.total ?? 0)
  }
}

/**
 * 文件归属校验：所有读写都必须经过这里，SQL 里始终带 user_id
 * find* 返回 null，assert* 直接抛 404
 */
export class FileService {
  private db: Database
  private folders: FolderService

  constructor(db: Database) {
    this.db = db
    this.folders = new FolderService(db)
  }

  get folders$() {
    return this.folders
  }

  private toOwned(row: any): OwnedFile {
    return toOwnedFile(row)
  }

  /** 一次查询补齐本批文件的授权人员，避免逐文件查询 */
  private async attachAccess(files: OwnedFile[]): Promise<OwnedFile[]> {
    if (!files.length) return files
    const ids = files.map((file) => file.id)
    const res = await this.db
      .prepare(`
        SELECT file_id AS fileId, user_id AS userId
        FROM file_access
        WHERE file_id IN (${placeholders(ids.length)})
        ORDER BY user_id ASC
      `)
      .bind(...ids)
      .all()
      .catch(() => null)

    const map = new Map<number, number[]>()
    for (const row of res?.results || []) {
      const list = map.get(Number(row.fileId)) || []
      list.push(Number(row.userId))
      map.set(Number(row.fileId), list)
    }
    for (const file of files) file.allowedUsers = map.get(file.id) || []
    return files
  }

  async findOwnedById(userId: number, fileId: number): Promise<OwnedFile | null> {
    const row = await this.db
      .prepare('SELECT * FROM files WHERE id = ? AND user_id = ?')
      .bind(fileId, userId)
      .first()
    if (!row) return null
    const [file] = await this.attachAccess([this.toOwned(row)])
    return file ?? null
  }

  async assertOwnedById(userId: number, fileId: number): Promise<OwnedFile> {
    const file = await this.findOwnedById(userId, fileId)
    if (!file) throw fileNotFoundError
    return file
  }

  async findOwnedByKey(userId: number, fileKey: string): Promise<OwnedFile | null> {
    const row = await this.db
      .prepare('SELECT * FROM files WHERE user_id = ? AND file_key = ?')
      .bind(userId, fileKey)
      .first()
    if (!row) return null
    const [file] = await this.attachAccess([this.toOwned(row)])
    return file ?? null
  }

  async assertOwnedByKey(userId: number, fileKey: string): Promise<OwnedFile> {
    const file = await this.findOwnedByKey(userId, fileKey)
    if (!file) throw fileNotFoundError
    return file
  }

  async findOwnedMany(userId: number, fileIds: number[]): Promise<OwnedFile[]> {
    const ids = uniqPositiveInts(fileIds)
    if (!ids.length) return []
    const res = await this.db
      .prepare(`SELECT * FROM files WHERE user_id = ? AND id IN (${placeholders(ids.length)})`)
      .bind(userId, ...ids)
      .all()
    return this.attachAccess((res?.results || []).map((row: any) => this.toOwned(row)))
  }

  async assertOwnedMany(userId: number, fileIds: number[]): Promise<OwnedFile[]> {
    const ids = uniqPositiveInts(fileIds)
    const owned = await this.findOwnedMany(userId, ids)
    if (owned.length !== ids.length) throw fileNotFoundError
    return owned
  }

  async listByFolder(userId: number, folderId: number | null): Promise<OwnedFile[]> {
    const sql = folderId === null
      ? 'SELECT * FROM files WHERE user_id = ? AND folder_id IS NULL ORDER BY created_at DESC'
      : 'SELECT * FROM files WHERE user_id = ? AND folder_id = ? ORDER BY created_at DESC'
    const args = folderId === null ? [userId] : [userId, folderId]
    const res = await this.db.prepare(sql).bind(...args).all()
    return this.attachAccess((res?.results || []).map((row: any) => this.toOwned(row)))
  }

  async listByFolders(userId: number, folderIds: number[]): Promise<OwnedFile[]> {
    if (!folderIds.length) return []
    const res = await this.db
      .prepare(
        `SELECT * FROM files WHERE user_id = ? AND folder_id IN (${placeholders(folderIds.length)})`
      )
      .bind(userId, ...folderIds)
      .all()
    return (res?.results || []).map((row: any) => this.toOwned(row))
  }

  async listOwnedByUser(userId: number): Promise<OwnedFile[]> {
    const res = await this.db
      .prepare('SELECT * FROM files WHERE user_id = ?')
      .bind(userId)
      .all()
    return (res?.results || []).map((row: any) => this.toOwned(row))
  }

  async findByName(userId: number, folderId: number | null, filename: string): Promise<OwnedFile | null> {
    const sql = folderId === null
      ? 'SELECT * FROM files WHERE user_id = ? AND folder_id IS NULL AND filename = ? LIMIT 1'
      : 'SELECT * FROM files WHERE user_id = ? AND folder_id = ? AND filename = ? LIMIT 1'
    const args = folderId === null ? [userId, filename] : [userId, folderId, filename]
    const row = await this.db.prepare(sql).bind(...args).first()
    return row ? this.toOwned(row) : null
  }

  async countInFolder(userId: number, folderId: number): Promise<number> {
    const res = await this.db
      .prepare('SELECT COUNT(*) AS total FROM files WHERE user_id = ? AND folder_id = ?')
      .bind(userId, folderId)
      .first()
    return Number(res?.total ?? 0)
  }

  async updateContent(
    userId: number,
    fileId: number,
    content: { fileKey: string; fileSize: number; fileUrl: string; contentType: string }
  ): Promise<number> {
    const res = await this.db
      .prepare(`
        UPDATE files
        SET file_key = ?, file_size = ?, file_url = ?, content_type = ?, created_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `)
      .bind(content.fileKey, content.fileSize, content.fileUrl, content.contentType, fileId, userId)
      .run()
    return Number(res?.meta?.changes ?? 0)
  }

  async updateName(userId: number, fileId: number, filename: string): Promise<number> {
    const res = await this.db
      .prepare('UPDATE files SET filename = ? WHERE id = ? AND user_id = ?')
      .bind(filename, fileId, userId)
      .run()
    return Number(res?.meta?.changes ?? 0)
  }

  async updateLocation(
    userId: number,
    fileId: number,
    folderId: number | null,
    filename?: string
  ): Promise<number> {
    const res = filename === undefined
      ? await this.db
          .prepare('UPDATE files SET folder_id = ? WHERE id = ? AND user_id = ?')
          .bind(folderId, fileId, userId)
          .run()
      : await this.db
          .prepare('UPDATE files SET folder_id = ?, filename = ? WHERE id = ? AND user_id = ?')
          .bind(folderId, filename, fileId, userId)
          .run()
    return Number(res?.meta?.changes ?? 0)
  }

  async deleteOwned(userId: number, fileId: number): Promise<number> {
    const res = await this.db
      .prepare('DELETE FROM files WHERE id = ? AND user_id = ?')
      .bind(fileId, userId)
      .run()
    return Number(res?.meta?.changes ?? 0)
  }

  async deleteOwnedMany(userId: number, fileIds: number[]): Promise<number> {
    if (!fileIds.length) return 0
    const res = await this.db
      .prepare(`DELETE FROM files WHERE user_id = ? AND id IN (${placeholders(fileIds.length)})`)
      .bind(userId, ...fileIds)
      .run()
    return Number(res?.meta?.changes ?? 0)
  }

  /** 目标文件夹归属校验，files 的写入前必须先过这一关 */
  async assertFolderOwned(userId: number, folderId: number | null): Promise<OwnedFolder | null> {
    return this.folders.assertOwned(userId, folderId)
  }

  async recalculateUsedStorage(userId: number): Promise<void> {
    const total = await this.db
      .prepare('SELECT COALESCE(SUM(file_size), 0) AS totalSize FROM files WHERE user_id = ?')
      .bind(userId)
      .first()
    await this.db
      .prepare('UPDATE users SET usedStorage = ? WHERE id = ?')
      .bind(Number(total?.totalSize ?? 0), userId)
      .run()
  }
}
