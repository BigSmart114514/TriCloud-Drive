import { placeholders, uniqPositiveInts } from './functions'
import { fileNotFoundError, folderNotFindError } from '~~/types/error'
import {
  hasPermission,
  normalizePermission,
  normalizeShareMode,
  PERM_READ,
  SHARE_INHERIT,
  SHARE_NONE,
  SHARE_SHARED
} from '~~/types/share'
import type { AccessGrant, ShareMode } from '~~/types/share'

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
  /** 共享三态：0 不分享 / 1 分享 / 2 继承 */
  Shared: number
  IsPublic: boolean
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
  /** 共享三态：0 不分享 / 1 分享 / 2 继承 */
  Shared: number
  /** 等价于「给所有人(含未登录) READ」的快捷写法 */
  IsPublic: boolean
  /** 该文件的直接授权（不含从父文件夹继承的） */
  grants: AccessGrant[]
}

export interface ManifestFile {
  id: number
  filename: string
  fileKey: string
  fileSize: number
  relDir: string
}

/**
 * 某个节点对某个用户的有效权限。
 * mode 为该节点的共享三态（0 不分享 / 1 分享 / 2 继承）。
 * boundary=false 表示继承态，需要继续向上查找。
 * mask 为归一化后的位掩码，0 = 无权访问。
 */
export interface ResolvedAccess {
  boundary: boolean
  mode: ShareMode
  isPublic: boolean
  mask: number
}

export const NO_ACCESS: ResolvedAccess = { boundary: false, mode: SHARE_INHERIT, isPublic: false, mask: 0 }

/**
 * 边界祖先自身的决策：
 *   不分享 → 拒绝（到此为止）
 *   分享   → 名单 + IsPublic 给所有人 READ
 */
function decideAncestor(
  mode: ShareMode,
  isPublic: boolean,
  row: { permission?: any } | null | undefined
): ResolvedAccess {
  if (mode === SHARE_INHERIT) return NO_ACCESS
  if (mode === SHARE_NONE) return { boundary: true, mode, isPublic: false, mask: 0 }
  const own = row && row.permission !== null && row.permission !== undefined
    ? normalizePermission(row.permission)
    : 0
  return {
    boundary: true,
    mode,
    isPublic,
    mask: normalizePermission(own | (isPublic ? PERM_READ : 0))
  }
}

/**
 * 把「起始节点自身」与「最近的边界祖先」合并成最终权限。
 *
 * 起始节点的三态决定要不要看祖先：
 *   不分享 → 直接拒绝，祖先一律不看
 *   分享   → 用自身的名单与公开，祖先一律不看
 *   继承   → 自身名单与公开，继续叠加祖先的决策
 *
 * 起始节点自己的名单和公开，在继承态下同样生效 —— 这正是「只给 B 加一个人
 * 而不想切断上层继承」所需要的。
 */
function combineWithAncestor(
  self: { mode: ShareMode; isPublic: boolean; permission?: any },
  ancestor: ResolvedAccess
): ResolvedAccess {
  const own =
    self.permission !== null && self.permission !== undefined ? normalizePermission(self.permission) : 0
  const direct = normalizePermission(own | (self.isPublic ? PERM_READ : 0))

  if (self.mode === SHARE_NONE) {
    return { boundary: true, mode: SHARE_NONE, isPublic: false, mask: 0 }
  }
  if (self.mode === SHARE_SHARED) {
    return { boundary: true, mode: SHARE_SHARED, isPublic: self.isPublic, mask: direct }
  }
  return {
    boundary: ancestor.boundary,
    mode: SHARE_INHERIT,
    isPublic: self.isPublic || ancestor.isPublic,
    mask: normalizePermission(direct | ancestor.mask)
  }
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
    updatedAt: row.updatedAt ?? row.updated_at ?? null,
    Shared: normalizeShareMode(row.Shared),
    IsPublic: toBool(row.IsPublic)
  }
}

function toOwnedFile(row: any): OwnedFile {
  // 注意：SELECT * 返回的是 folder_id，这里必须做兜底，
  // 否则会被当成根层，向上查找继承时走不到祖先的授权
  const folderIdRaw = row.folderId ?? row.folder_id
  return {
    id: Number(row.id),
    userId: Number(row.userId ?? row.user_id),
    folderId: folderIdRaw === null || folderIdRaw === undefined ? null : Number(folderIdRaw),
    filename: row.filename,
    fileKey: row.fileKey ?? row.file_key,
    fileSize: Number(row.fileSize ?? row.file_size),
    fileUrl: row.fileUrl ?? row.file_url,
    contentType: row.contentType ?? row.content_type ?? null,
    createdAt: row.createdAt ?? row.created_at,
    Shared: normalizeShareMode(row.Shared),
    IsPublic: toBool(row.IsPublic),
    grants: []
  }
}

const FOLDER_COLUMNS =
  'id, user_id AS userId, name, parent_id AS parentId, created_at AS createdAt, updated_at AS updatedAt, Shared, IsPublic'

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

  /**
   * 解析该目录对某用户的有效权限。
   *
   * 一次查询同时取回两样东西：目录**自身**，以及向上最近的**边界祖先**
   * （Shared IN (0,1)；继承态会被跳过）。两者都要读——继承态下目录自己的
   * 名单和公开标记同样生效。列目录时整个请求只调一次，之后在内存里过滤。
   */
  async resolveAccess(userId: number, folderId: number | null): Promise<ResolvedAccess> {
    if (folderId === null || folderId === undefined) return NO_ACCESS

    const res = await this.db
      .prepare(`
        WITH RECURSIVE up(id, parent_id, shared, pub, depth) AS (
          SELECT id, parent_id, Shared, IsPublic, 0 FROM folders WHERE id = ?
          UNION ALL
          SELECT f.id, f.parent_id, f.Shared, f.IsPublic, up.depth + 1
          FROM folders f
          JOIN up ON f.id = up.parent_id
        ),
        picked AS (
          SELECT * FROM (
            SELECT 0 AS pri, id, shared, pub FROM up WHERE depth = 0
            UNION ALL
            SELECT 1 AS pri, id, shared, pub FROM (
              SELECT id, shared, pub FROM up WHERE shared IN (0, 1) AND depth > 0
              ORDER BY depth ASC LIMIT 1
            )
          )
        )
        SELECT p.pri, p.shared, p.pub, fa.permission
        FROM picked p
        LEFT JOIN folder_access fa ON fa.folder_id = p.id AND fa.user_id = ?
        ORDER BY p.pri
      `)
      .bind(folderId, userId)
      .all()
      .catch(() => ({ results: [] }))

    const rows = res?.results || []
    const self = rows.find((r: any) => Number(r.pri) === 0)
    if (!self) return NO_ACCESS
    const anc = rows.find((r: any) => Number(r.pri) === 1)

    const ancestor = anc
      ? decideAncestor(normalizeShareMode(anc.shared), toBool(anc.pub), anc)
      : NO_ACCESS

    return combineWithAncestor(
      {
        mode: normalizeShareMode(self.shared),
        isPublic: toBool(self.pub),
        permission: self.permission
      },
      ancestor
    )
  }

  /** 该目录被授权给哪些人（展示用，位掩码已归一化） */
  async listGrants(folderId: number): Promise<AccessGrant[]> {
    const res = await this.db
      .prepare('SELECT user_id AS userId, permission FROM folder_access WHERE folder_id = ? ORDER BY user_id ASC')
      .bind(folderId)
      .all()
    return (res?.results || []).map((row: any) => ({
      userId: Number(row.userId),
      permission: normalizePermission(row.permission)
    }))
  }

  /**
   * 校验访客可读该目录，返回目录（含属主 id）。
   * 属主直接放行；否则要求该目录对访客的有效权限含 read。
   * 根层（folderId=null）视为访客自己的根层，放行。
   */
  async assertReadable(userId: number, folderId: number | null): Promise<OwnedFolder | null> {
    if (folderId === null || folderId === undefined) return null
    const owned = await this.findOwnedById(userId, folderId)
    if (owned) return owned
    const access = await this.resolveAccess(userId, folderId)
    if (!hasPermission(access.mask, PERM_READ)) throw folderNotFindError
    return this.findOwnedById((await this.getOwnerId(folderId))!, folderId)
  }

  async getOwnerId(folderId: number): Promise<number | null> {
    const row = await this.db.prepare('SELECT user_id FROM folders WHERE id = ?').bind(folderId).first()
    return row ? Number(row.user_id) : null
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

  /** 一次查询补齐本批文件的直接授权，避免逐文件查询 */
  private async attachAccess(files: OwnedFile[]): Promise<OwnedFile[]> {
    if (!files.length) return files
    const ids = files.map((file) => file.id)
    const res = await this.db
      .prepare(`
        SELECT file_id AS fileId, user_id AS userId, permission
        FROM file_access
        WHERE file_id IN (${placeholders(ids.length)})
        ORDER BY user_id ASC
      `)
      .bind(...ids)
      .all()
      .catch(() => null)

    const map = new Map<number, AccessGrant[]>()
    for (const row of res?.results || []) {
      const id = Number(row.fileId)
      const list = map.get(id) || []
      list.push({ userId: Number(row.userId), permission: normalizePermission(row.permission) })
      map.set(id, list)
    }
    for (const file of files) file.grants = map.get(file.id) || []
    return files
  }

  /**
   * 解析某用户对某文件的有效权限。文件本身也是一个节点，同样有三态；
   * 继承态下把自身名单与祖先决策叠加。祖先链由 folderService 一次解析完。
   */
  private resolveFileAccess(userId: number, file: OwnedFile, inherited: ResolvedAccess): ResolvedAccess {
    const own = file.grants.find((g) => g.userId === userId)
    return combineWithAncestor(
      { mode: normalizeShareMode(file.Shared), isPublic: file.IsPublic, permission: own?.permission },
      inherited
    )
  }

  /** 单文件完整解析（会走一次上行 CTE），用于 download / rename / delete 这类操作 */
  async resolveAccessForFile(userId: number, file: OwnedFile): Promise<ResolvedAccess> {
    const inherited = await this.folders.resolveAccess(userId, file.folderId)
    return this.resolveFileAccess(userId, file, inherited)
  }

  async canAccess(userId: number, file: OwnedFile, need: number): Promise<boolean> {
    const resolved = await this.resolveAccessForFile(userId, file)
    return hasPermission(resolved.mask, need)
  }

  /**
   * 定位文件并校验权限，**不要求是所有者**——分享出去的入口都走这里。
   * 错误口径：完全没有访问权 → 404（与不存在相同，避免探测）；
   *           有访问权但权限不够 → 403。
   */
  async findAccessibleByKey(userId: number, fileKey: string, need: number): Promise<OwnedFile> {
    const row = await this.db.prepare('SELECT * FROM files WHERE file_key = ?').bind(fileKey).first()
    if (!row) throw fileNotFoundError
    const [file] = await this.attachAccess([this.toOwned(row)])
    return this.ensureAccess(userId, file!, need)
  }

  async findAccessibleById(userId: number, fileId: number, need: number): Promise<OwnedFile> {
    const row = await this.db.prepare('SELECT * FROM files WHERE id = ?').bind(fileId).first()
    if (!row) throw fileNotFoundError
    const [file] = await this.attachAccess([this.toOwned(row)])
    return this.ensureAccess(userId, file!, need)
  }

  private async ensureAccess(userId: number, file: OwnedFile, need: number): Promise<OwnedFile> {
    if (file.userId === userId) return file
    const resolved = await this.resolveAccessForFile(userId, file)
    if (resolved.mask === 0) throw fileNotFoundError
    if (!hasPermission(resolved.mask, need)) {
      throw createError({ statusCode: 403, statusMessage: '该文件的权限不足' })
    }
    return file
  }

  /**
   * 列出目录下的文件。ownerId 是该目录的属主——子树的行天然都属于他，
   * 所以访客不是属主时也能继续给 SQL 加 user_id 过滤（保持纵深防御）。
   */
  async listFolderContents(folderId: number | null, ownerId: number): Promise<OwnedFile[]> {
    const sql = folderId === null
      ? 'SELECT * FROM files WHERE user_id = ? AND folder_id IS NULL ORDER BY created_at DESC'
      : 'SELECT * FROM files WHERE user_id = ? AND folder_id = ? ORDER BY created_at DESC'
    const args = folderId === null ? [ownerId] : [ownerId, folderId]
    const res = await this.db.prepare(sql).bind(...args).all()
    return this.attachAccess((res?.results || []).map((row: any) => this.toOwned(row)))
  }

  /** 该文件被直接授权给哪些人（不含从父文件夹继承的） */
  async listGrants(fileId: number): Promise<AccessGrant[]> {
    const res = await this.db
      .prepare('SELECT user_id AS userId, permission FROM file_access WHERE file_id = ? ORDER BY user_id ASC')
      .bind(fileId)
      .all()
    return (res?.results || []).map((row: any) => ({
      userId: Number(row.userId),
      permission: normalizePermission(row.permission)
    }))
  }

  /** 目录级解析一次，然后内存里过滤本目录下的文件（勿对每个文件重复调用） */
  async filterAccessible(
    userId: number,
    files: OwnedFile[],
    inherited?: ResolvedAccess
  ): Promise<OwnedFile[]> {
    if (!files.length) return files
    const dirAccess = inherited ?? (await this.folders.resolveAccess(userId, files[0]!.folderId))
    return files.filter((file) => this.resolveFileAccess(userId, file, dirAccess).mask !== 0)
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
