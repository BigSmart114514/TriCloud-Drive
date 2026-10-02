import { placeholders, uniqPositiveInts } from './functions'
import { fileNotFoundError, folderNotFindError } from '~~/types/error'
import {
  hasPermission,
  normalizePermission,
  normalizeShareMode,
  PERM_DOWNLOAD,
  PERM_READ,
  PERM_WRITE,
  SHARE_INHERIT,
  SHARE_NONE,
  SHARE_SHARED
} from '~~/types/share'
import type { AccessGrant, PermSource, ShareMode } from '~~/types/share'
import { recalculateChainStorage } from '~~/server/utils/sub-account'

export type { PermSource } from '~~/types/share'

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
  /** 父账号 id。null = 不是任何人的子账户。 */
  parent_id: number | null
  /** 能不能建子账户（管理员在用户管理里给） */
  canSubAccount: boolean
  /** 最多能建几个子账户，0 = 不限 */
  maxSubAccount: number
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
      // **刻意不写 expire_at**，让它吃到 schema 的 `DEFAULT CURRENT_TIMESTAMP`。
      //
      // 那是设计，不是疏漏：自助注册出来的账号一律先做成哑巴 ——
      // 额度 1B、流量 1B、且出生即过期，任何操作都被拒，等管理员开通。
      // 「注册成功」不等于「能用」，中间隔着管理员这一道闸门。
      //
      // 曾经有人（或 AI）把这当成 bug「修」过：给 expire_at 显式写 NULL、
      // 并把 schema 默认值改成 NULL —— 结果是每个自助注册的人都拿到
      // 一个**永不过期**的账号。等于把门拆了。
      //
      // tests/registration-expiry.test.mjs 现在钉住这三个默认值不许被放宽。
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
  /** 我授权了多少人（folder_access 行数）。继承态下角标靠它区分「共享中」和默认态 */
  grantCount: number
  /**
   * 这个目录上挂了几条分享链接（share_links 行数）。
   *
   * 与 grantCount 并列的「设过东西」标志：光看名单和公开看不见链接，
   * 于是「在继承态目录上生成了链接」这种死链在界面上毫无提示
   *（而它恰恰是最容易踩的 —— 新建目录默认就是继承态）。
   */
  linkCount: number
  /**
   * 继承态下自己设的名单/公开当前生效吗（列表接口挂，别的路径可能没有）。
   * 没人拍板（含根目录自己）或最近边界是「不分享」时为 false。
   */
  presetActive?: boolean
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
  /** 等价于「对所有已登录用户 READ」的快捷写法。不含未登录：/api/** 一律先过 requireAuth */
  IsPublic: boolean
  /** 该文件的直接授权（不含从父文件夹继承的） */
  grants: AccessGrant[]
  /** grants.length。列表页的红点判定要「有没有设过人员」，直接用数组长度即可 */
  grantCount?: number
  /** 该文件上挂了几条分享链接。与 OwnedFolder.linkCount 同义，列表页红点用 */
  linkCount?: number
  /** 同 OwnedFolder.presetActive */
  presetActive?: boolean
}

/**
 * 列表接口里每个条目附带的「我对它的权限」元信息。
 * perm 是完整位掩码，permSource 说明这份权限从哪来（见 PermSource）。
 */
export type SharedEntry<T> = T & {
  canWrite: boolean
  perm: number
  permSource: PermSource
}

export interface ManifestFile {
  id: number
  filename: string
  fileKey: string
  fileSize: number
  relDir: string
  /** 所在目录。权限过滤时按它分组，同一目录只解析一次 */
  folderId: number | null
  /** 该文件自己的三态。非继承的文件是它自己那道边界，祖先的授权到不了它 */
  Shared: number
  IsPublic: boolean
  /**
   * MIME 类型。**只有分享链接那条路径带**（share-link.ts 的 listSubtreeByLink），
   * 因为复制要靠它给副本写回 content_type；清单（整包下载）用不上。
   * 缺省时调用方按 application/octet-stream 处理。
   */
  contentType?: string | null
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
  source: PermSource
  /**
   * 向上查是否真找到一个 `Shared IN (0,1)` 的拍板者。
   *
   * 不能从 boundary/mask 反推：CTE 在没找到边界时把边界兜底成根，得到的
   * ancestor 与「找到了一个继承态边界」同形，都是 NO_ACCESS。
   *
   * 必须跟着 ResolvedAccess 一起传下去：文件本身也要按它判断「自己的公开
   * 是预设还是生效」，而文件的那次 combineWithAncestor 拿到的是**目录**解析
   * 的结果。少了这个字段，文件就会退回「自己 IsPublic=1 就生效」的老行为。
   */
  hasBoundary?: boolean
}

export const NO_ACCESS: ResolvedAccess = {
  boundary: false,
  mode: SHARE_INHERIT,
  isPublic: false,
  mask: 0,
  source: 'none',
  hasBoundary: false
}

/**
 * 边界祖先自身的决策：
 *   不分享 → 拒绝（到此为止）
 *   分享   → 名单 + IsPublic 给所有已登录用户 READ
 */
function decideAncestor(
  mode: ShareMode,
  isPublic: boolean,
  row: { permission?: any } | null | undefined
): ResolvedAccess {
  if (mode === SHARE_INHERIT) return NO_ACCESS
  if (mode === SHARE_NONE) {
    return { boundary: true, mode, isPublic: false, mask: 0, source: 'none', hasBoundary: true }
  }
  const own = row && row.permission !== null && row.permission !== undefined
    ? normalizePermission(row.permission)
    : 0
  return {
    boundary: true,
    mode,
    isPublic,
    mask: normalizePermission(own | (isPublic ? PERM_READ : 0)),
    // 对子节点来说，边界上的授权就是「继承来的」
    source: own > 0 ? 'inherited' : (isPublic ? 'public' : 'none'),
    // 能走到这里说明这一行本身就是一个边界（有拍板者）
    hasBoundary: true
  }
}

/**
 * 把「起始节点自身」与祖先侧的授权合并成最终权限。
 *
 * 起始节点的三态决定要不要看祖先：
 *   不分享 → 直接拒绝，祖先一律不看
 *   分享   → 用自身的名单与公开，祖先一律不看
 *   继承   → 自身名单与公开，继续叠加祖先的决策
 *
 * 起始节点自己的名单和公开，在继承态下同样生效 —— 这正是「只给 B 加一个人
 * 而不想切断上层继承」所需要的。
 *
 * `belowBoundaryMask` 是 resolveAccess 从链路上额外带下来的一段：节点与最近
 * 边界之间的那些**非边界**祖先（Shared=2）上的授权，按位 OR。`belowBoundaryIsPublic`
 * 是同一段里是否存在公开目录（IsPublic=1 等价于给所有已登录用户 READ）。
 *
 *   为什么需要它：以前只 JOIN 了「自身 + 最近边界」两行，写在继承态目录上的
 *   授权读不到。后果是能往那个目录里写（它自身是 pri=0，直接授权生效），
 *   却看不见自己写进去的东西（子项向上找边界时跳过它，落到没有授权的上层）。
 *   公开标记当时也一样漏读。修好后公开目录下的新建项才对所有已登录用户可见。
 *
 *   这段只覆盖**边界之下**的部分。边界本身由 ancestor 说了算，且继承态下
 *   ancestor 是「不分享」时整个 mask 直接归零 —— 连节点自身写在 folder_access
 *   里的直接授权一起挡。「不分享」是拒绝型边界，不是「只挡外来继承」。
 *
 * `hasBoundary` = 这条链上是否真的找到了一个 `Shared IN (0,1)` 的边界祖先。
 *
 *   必须由调用方显式传，不能从 ancestor 反推：resolveAccess 的 CTE 在没找到
 *   边界时用 COALESCE 把边界兜底成根（db.ts:524），ancestor 拿到的是
 *   decideAncestor(继承态) = NO_ACCESS，与「找到了一个继承态边界」完全同形。
 *   所以「没人拍板」这个事实在合并前就丢了，只能靠 anc 是否命中来还原。
 *
 *   false 时（整条链全是继承，没有任何一层表态）→ mask 直接 0。
 *   继承是**预设**语义：设的公开标记和名单先存在库里，但没人拍板时它们不生效；
 *   等上游哪天出现边界（有人设 Shared=1），它们自动跟着生效，无需重设。
 *   改之前这里是 direct | ancestor.mask | belowBoundaryMask，
 *   ancestor 恒为 0，于是唯一给权限的就是 direct 里的 self.isPublic ——
 *   根目录设了公开就全网可读，而它向上根本没有任何东西可以继承。
 */
function combineWithAncestor(
  self: { mode: ShareMode; isPublic: boolean; permission?: any },
  ancestor: ResolvedAccess,
  belowBoundaryMask = 0,
  belowBoundaryIsPublic = false,
  belowBoundaryGrants = 0,
  hasBoundary = true
): ResolvedAccess {
  const own =
    self.permission !== null && self.permission !== undefined ? normalizePermission(self.permission) : 0
  const direct = normalizePermission(own | (self.isPublic ? PERM_READ : 0))

  if (self.mode === SHARE_NONE) {
    return { boundary: true, mode: SHARE_NONE, isPublic: false, mask: 0, source: 'none', hasBoundary }
  }
  if (self.mode === SHARE_SHARED) {
    // 分享是明确的表态，不依赖祖先。根目录设成「分享」照样生效。
    return {
      boundary: true,
      mode: SHARE_SHARED,
      isPublic: self.isPublic,
      mask: direct,
      source: own > 0 ? 'self' : (self.isPublic ? 'public' : 'none'),
      hasBoundary
    }
  }

  // 继承态，但整条链没人拍板 → 等同「不分享」。
  // 自身的名单/公开只是预设，不在此刻生效；belowBoundary 那段同理
  // （那一批也是继承态目录，没有边界给它们背书）。
  if (!hasBoundary) {
    return {
      boundary: true,
      mode: SHARE_NONE,
      isPublic: false,
      mask: 0,
      source: 'none',
      hasBoundary: false
    }
  }

  // 继承态，最近边界是「不分享」→ 墙，下游一律 0。
  //
  // 必须在 direct | ancestor.mask 之前判。decideAncestor 对 SHARE_NONE 返回
  // mask:0，那 0 只是个数值，OR 进去不改变任何东西 —— 于是 direct 里
  // 自身的名单/公开照样生效，墙被穿过去了：
  //
  //   97 ABCD (不分享)
  //   └─ 99 ADBC (继承, 名单里给了 user5 perm=3)
  //
  // 实际给出 mask=3，属主明明在 97 划了墙。直接授权同样要挡：
  // 「不分享」是拒绝型边界，不是「只挡外来继承」。放在 SHARED 分支之后，
  // 因为分享态的节点本来就不看祖先，行为不变。
  if (ancestor.mode === SHARE_NONE) {
    return {
      boundary: true,
      mode: SHARE_NONE,
      isPublic: false,
      mask: 0,
      source: 'none',
      hasBoundary: true
    }
  }

  const isPublicAny = self.isPublic || ancestor.isPublic || belowBoundaryIsPublic
  // 谁最具体谁赢：自身名单 > 边界祖先 > 边界之下的授权 > 公开
  const source: PermSource =
    own > 0 ? 'self'
      : ancestor.mask > 0 ? ancestor.source
        : belowBoundaryGrants > 0 ? 'inherited'
          : isPublicAny ? 'public'
            : 'none'
  return {
    boundary: ancestor.boundary,
    mode: SHARE_INHERIT,
    isPublic: isPublicAny,
    mask: normalizePermission(direct | ancestor.mask | belowBoundaryMask),
    source,
    hasBoundary: true
  }
}

function toBool(value: any): boolean {
  return value === true || value === 1 || value === '1'
}

/**
 * 解析某用户对某个**文件**的有效权限。文件本身也是一个节点，同样有三态；
 * 继承态下把自身名单与祖先（目录侧）的决策叠加。
 *
 * 提到模块级是因为有两处要算同一个东西：
 *   FileService.resolveFileAccess —— 日常的 download / 列表逐条判定
 *   FileService.listDownloadableSubtree —— 整棵子树的权限过滤
 * 写成两份的话，改了「文件侧怎么叠祖先」只有一处会跟着变，另一处静默过期。
 *
 * `ownPermission` 是直接授权（file_access 里的那一行），没有就给 undefined。
 */
function resolveFileAccessFrom(
  self: { Shared: number; IsPublic: boolean },
  ownPermission: number | undefined,
  inherited: ResolvedAccess
): ResolvedAccess {
  /**
   * 文件的继承态预设（自己的名单/公开）有没有人背书。
   *
   * 注意**不能只看 inherited.hasBoundary** —— 它回答的是「**祖先**链里有没有
   * 拍板者」，不包含「当前目录自己就是边界」这种情况。
   *
   * 以前这里写的是 `inherited.hasBoundary !== false`，于是：
   *   访客点进一个直接分享给他的目录（该目录自己 Shared=1，上面全是继承）
   *     → resolveAccess 走 SHARED 分支，hasBoundary = !!anc = false
   *     → 里面继承态的文件全部拿到 mask 0
   *   表现是「目录在「分享给我的」里点得进去，进去却一个文件都没有」。
   *   只要再往下一层（那层上面还有边界），anc 非空就又正常了 —— 所以这个 bug
   *   一直没被发现：触发条件是**当前目录自己就是最近的边界**。
   *
   * 正确的判据是「我们继承的这一侧有没有拍板者」：
   *   inherited.mode !== 继承   → 当前目录自己就是边界（分享或不分享）
   *   inherited.hasBoundary      → 或者祖先里有边界
   * 满足其一即可。祖先是「不分享」时另有 combineWithAncestor 的墙分支兜着，
   * 这里判 true 也不会把它放过去。
   */
  const backed = inherited.hasBoundary === true || inherited.mode !== SHARE_INHERIT

  return combineWithAncestor(
    { mode: normalizeShareMode(self.Shared), isPublic: toBool(self.IsPublic), permission: ownPermission },
    inherited,
    // 目录那侧的 inherited 已经在 combineWithAncestor 里算过祖先叠加，
    // 这里只需要它带下来的「继承侧有没有拍板者」——文件自己若是继承态，
    // 自己的 IsPublic 属不属于预设，就看这一条。
    0,
    false,
    0,
    backed
  )
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
    IsPublic: toBool(row.IsPublic),
    // 缺列时兜底 0：老查询没带 grantCount，语义上等于「没授权任何人」
    grantCount: Number(row.grantCount ?? 0) || 0,
    // 同理：没带 linkCount 的老查询等于「没挂过链接」
    linkCount: Number(row.linkCount ?? 0) || 0
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

/**
 * folders 表的标准列清单。所有读 folders 的地方都用它，避免各处各写一套。
 */
const FOLDER_COLUMNS_BASE =
  'id, user_id AS userId, name, parent_id AS parentId, created_at AS createdAt, updated_at AS updatedAt, Shared, IsPublic'

/**
 * 列表用：在标准列后加 grantCount = 我授权了多少人（folder_access 行数）。
 *
 * 列表页的角标要区分「继承 + 有人」和「继承 + 没人」，光看 Shared/IsPublic
 * 分不出来 —— 继承态默认不给任何人读（见 combineWithAncestor），名单非空
 * 才说明属主显式分享过。
 *
 * 只给列表用。findOwnedById / findByName 这些单条热路径用 BASE 就够，
 * 没必要为一次用不到的计数多跑子查询。走 ix_folder_access_folder 索引。
 * 带 `folders.` 限定名：个别查询里 folders 会与 folder_access 联表，不限定会歧义。
 */
const FOLDER_COLUMNS_WITH_GRANTS =
  `${FOLDER_COLUMNS_BASE}, (SELECT COUNT(*) FROM folder_access fa WHERE fa.folder_id = folders.id) AS grantCount` +
  // linkCount = 这个目录上挂了几条分享链接。文件那侧在 attachAccess 里同样补。
  // 两个计数都是「属主视角」的红点判据（见 types/share.ts 的 shareDotReason）：
  // 授权名单非空、或者挂过链接，都算「设过东西」。缺了链接这一项，
  // 「在刚建的目录上生成链接」这种最常见的死链场景图标上一点提示都没有。
  // 走 ix_share_links_target 索引，不扫表。
  `, (SELECT COUNT(*) FROM share_links sl WHERE sl.target_type = 'folder' AND sl.target_id = folders.id) AS linkCount`

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
      .prepare(`SELECT ${FOLDER_COLUMNS_BASE} FROM folders WHERE id = ? AND user_id = ?`)
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

  /**
   * 定位目录并校验权限，**不要求是属主** —— 与 FileService 的同名方法对称。
   * 属主放行；否则按 resolveAccess 判分享权限。
   *
   * 错误口径与文件一致：完全无权 → 404（与不存在相同，避免探测）；
   * 有权但权限不够 → 403。
   *
   * 传 authUserId（getMeAndTarget 给的）进来：
   *   useAdmin=true  → authUserId 是属主，走第一行「属主放行」，退化成纯归属判定
   *   useAdmin=false → authUserId 是行动者，走 resolveAccess，即分享权限
   */
  async findAccessibleById(userId: number, folderId: number, need: number): Promise<OwnedFolder> {
    const owned = await this.findOwnedById(userId, folderId)
    if (owned) return owned
    const access = await this.resolveAccess(userId, folderId)
    if (access.mask === 0) throw folderNotFindError
    if (!hasPermission(access.mask, need)) {
      throw createError({ statusCode: 403, message: '该文件夹的权限不足' })
    }
    // 属主信息从库里反查：这里返回的 row 一定属于别人
    return (await this.findOwnedById((await this.getOwnerId(folderId))!, folderId))!
  }

  /**
   * 批量版，逐个过 findAccessibleById。少一个就整体 404/403 —— 不做部分成功，
   * 否则移动/复制会出现「搬了一半」的中间态。
   */
  async findAccessibleMany(userId: number, folderIds: number[], need: number): Promise<OwnedFolder[]> {
    const ids = uniqPositiveInts(folderIds)
    const out: OwnedFolder[] = []
    for (const id of ids) out.push(await this.findAccessibleById(userId, id, need))
    return out
  }

  async findOwnedMany(userId: number, folderIds: number[]): Promise<OwnedFolder[]> {
    if (!folderIds.length) return []
    const res = await this.db
      .prepare(
        `SELECT ${FOLDER_COLUMNS_BASE} FROM folders WHERE user_id = ? AND id IN (${placeholders(folderIds.length)})`
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
      ? `SELECT ${FOLDER_COLUMNS_WITH_GRANTS} FROM folders WHERE user_id = ? AND parent_id IS NULL ORDER BY name COLLATE NOCASE ASC`
      : `SELECT ${FOLDER_COLUMNS_WITH_GRANTS} FROM folders WHERE user_id = ? AND parent_id = ? ORDER BY name COLLATE NOCASE ASC`
    const args = parentId === null ? [userId] : [userId, parentId]
    const res = await this.db.prepare(sql).bind(...args).all()
    return (res?.results || []).map(toOwnedFolder)
  }

  async listChildrenByParentIds(userId: number, parentIds: number[]): Promise<OwnedFolder[]> {
    if (!parentIds.length) return []
    const res = await this.db
      .prepare(
        `SELECT ${FOLDER_COLUMNS_WITH_GRANTS} FROM folders WHERE user_id = ? AND parent_id IN (${placeholders(parentIds.length)})`
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
      ? `SELECT ${FOLDER_COLUMNS_BASE} FROM folders WHERE user_id = ? AND parent_id IS NULL AND name = ? LIMIT 1`
      : `SELECT ${FOLDER_COLUMNS_BASE} FROM folders WHERE user_id = ? AND parent_id = ? AND name = ? LIMIT 1`
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

  /**
   * 整棵子树的打包清单（带相对路径），每一跳都限定 user_id。
   *
   * **不过滤权限** —— 这里只回答「这棵树里有哪些文件」。调用方分两种：
   * 属主（FileService.listDownloadableSubtree 走快路径直接返回这份）和
   * 需要过滤的访客（同一份数据按 folderId 分组后逐目录解析权限）。
   * 所以这里多带了 folder_id / Shared / IsPublic 三列供后者使用，
   * 它们对属主那条路是无用列 —— 比起为两种形态各写一条 SQL，多三个无用列便宜。
   */
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
        SELECT fl.id        AS id,
               fl.filename  AS filename,
               fl.file_key  AS fileKey,
               fl.file_size AS fileSize,
               tree.rel_dir AS relDir,
               fl.folder_id AS folderId,
               fl.Shared    AS Shared,
               fl.IsPublic  AS IsPublic
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
   * 一次查询取回「节点自身 → 最近边界祖先（含）之间」的**整条链路**，每一行都读
   * 该行身上的授权：
   *   depth=0 的行        —— 节点自身，它的名单/公开在任何三态下都生效
   *   边界行(pri=1)       —— 最近的 Shared IN (0,1) 祖先，边界以上的授权由它决定，
   *                         SHARE_NONE 在这里是一道墙
   *   中间行(pri=2)       —— 夹在两者之间的继承态目录，按位 OR 合并
   *
   * 中间那一段是必须的：只 JOIN 自身+边界的话，写在继承态目录上的授权读不到，
   * 于是能往那个目录里写、却看不见自己写进去的东西。
   *
   * 列目录时整个请求只调一次，之后在内存里过滤。
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
        -- 边界 = 最近的 Shared IN (0,1) 祖先（没有就取到根）。
        boundary AS (
          SELECT COALESCE(
            (SELECT MIN(depth) FROM up WHERE shared IN (0, 1) AND depth > 0),
            (SELECT MAX(depth) FROM up)
          ) AS depth
        ),
        picked AS (
          SELECT up.id, up.shared, up.pub, up.depth,
            CASE
              WHEN up.depth = 0 THEN 0
              -- 边界行：最近的 Shared IN (0,1)。边界以上的授权归它管，不能混进 below
              WHEN up.shared IN (0, 1) AND up.depth <= boundary.depth THEN 1
              ELSE 2
            END AS pri
          FROM up, boundary
          WHERE up.depth = 0 OR up.depth <= boundary.depth
        )
        SELECT p.pri, p.depth, p.shared, p.pub, fa.permission
        FROM picked p
        LEFT JOIN folder_access fa ON fa.folder_id = p.id AND fa.user_id = ?
        ORDER BY p.depth ASC
      `)
      .bind(folderId, userId)
      .all()
      .catch(() => ({ results: [] }))

    const rows = res?.results || []
    const self = rows.find((r: any) => Number(r.depth) === 0)
    if (!self) return NO_ACCESS

    // pri=2 的行 = 节点与最近边界之间的非边界祖先，它们身上的授权与公开标记
    // 以前读不到，现在合并进来。边界行本身不在这里 —— 归 decideAncestor 管。
    //
    // 授权贡献与公开贡献要分开记：公开派生的那个 READ 位也混在 mask 里，
    // 不分开的话「靠公开看到的」会被误判成来源 inherited。
    let belowBoundaryGrants = 0
    let belowBoundaryIsPublic = false
    for (const r of rows as any[]) {
      if (Number(r.pri) !== 2) continue
      const p = r?.permission
      if (p !== null && p !== undefined) {
        belowBoundaryGrants = normalizePermission(belowBoundaryGrants | normalizePermission(p))
      }
      if (toBool(r?.pub)) belowBoundaryIsPublic = true
    }
    const belowBoundaryMask = normalizePermission(
      belowBoundaryGrants | (belowBoundaryIsPublic ? PERM_READ : 0)
    )

    // 边界行单独留给 decideAncestor：边界自己的名单与「不分享」的墙都归它管。
    // rows 已按 depth 升序，find 命中的就是最近的那个边界；depth>0 排除了节点自身
    // （自身即使 Shared IN (0,1) 也不能当自己的祖先）。
    const anc = rows.find(
      (r: any) => Number(r.depth) > 0 && (Number(r.shared) === 0 || Number(r.shared) === 1)
    )

    const ancestor = anc
      ? decideAncestor(normalizeShareMode(anc.shared), toBool(anc.pub), anc)
      : NO_ACCESS

    return combineWithAncestor(
      {
        mode: normalizeShareMode(self.shared),
        isPublic: toBool(self.pub),
        permission: self.permission
      },
      ancestor,
      belowBoundaryMask,
      belowBoundaryIsPublic,
      belowBoundaryGrants,
      // anc 是否命中 = 链上是否真有人拍板。CTE 的 COALESCE 兜底把「没找到边界」
      // 伪装成「边界是根」，ancestor 两者都是 NO_ACCESS，这里是唯一能还原的地方。
      !!anc
    )
  }

  /**
   * 这个目录「继承态的预设」当前生效吗？列表页红点用。
   *
   * 预设 = 继承态下自己设的名单和公开。它们只是**预设**：整条链没人拍板时
   * （根目录也算没人拍板），或者最近边界是「不分享」这道墙，它们都不生效。
   * 这时属主会看到自己设了却没人能进，所以要标红点提示。
   *
   * 与 resolveAccess 的区别：不 JOIN folder_access、不算具体权限，只问
   * 「有没有拍板者、最近的那个是不是墙」。所以跟访问者身份无关，属主视角也能用。
   *
   * `includeSelf` 是给**文件**用的：文件不在 folders 表里，它的「自身三态」不在
   * 这条链上，链上的第一个节点是**所在目录**。而对目录本身，depth 0 是它自己，
   * 一个设成「分享」的目录不算预设（红点规则本来也不会点它），所以要排除。
   * 文件则相反 —— 所在目录就是它的边界，目录拍板了，文件的预设就该生效。
   * 不区分这两者的话，权限判定（已含目录自己）和红点判定会给出相反的答案。
   */
  async isPresetActive(folderId: number, opts?: { includeSelf?: boolean }): Promise<boolean> {
    const minDepth = opts?.includeSelf ? 0 : 1

    const res = await this.db
      .prepare(`
        WITH RECURSIVE up(id, parent_id, shared, depth) AS (
          SELECT id, parent_id, Shared, 0 FROM folders WHERE id = ?
          UNION ALL
          SELECT f.id, f.parent_id, f.Shared, up.depth + 1
          FROM folders f JOIN up ON f.id = up.parent_id
        )
        SELECT shared, depth FROM up ORDER BY depth ASC
      `)
      .bind(folderId)
      .all()
      .catch(() => ({ results: [] }))

    const rows = res?.results || []
    if (!rows.length) return false

    // 没人拍板：整条链（含根目录自己）没有一个 Shared IN (0,1)
    const boundary = rows.find(
      (r: any) =>
        Number(r.depth) >= minDepth && (Number(r.shared) === 0 || Number(r.shared) === 1)
    )
    if (!boundary) return false

    // 最近的那个拍板者是「不分享」→ 墙 → 预设被挡住
    return Number(boundary.shared) !== 0
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

    /**
     * linkCount 与授权名单同批取：一次查询补两个计数，别为红点再跑一趟。
     * 走 ix_share_links_target 索引。
     */
    const linkRows = await this.db
      .prepare(
        `SELECT target_id AS targetId, COUNT(*) AS n
         FROM share_links
         WHERE target_type = 'file' AND target_id IN (${placeholders(ids.length)})
         GROUP BY target_id`
      )
      .bind(...ids)
      .all()
      .catch(() => null)
    const linkMap = new Map<number, number>()
    for (const row of linkRows?.results || []) linkMap.set(Number(row.targetId), Number(row.n) || 0)

    for (const file of files) {
      const grants = map.get(file.id) || []
      file.grants = grants
      file.grantCount = grants.length
      file.linkCount = linkMap.get(file.id) || 0
    }
    return files
  }

  /**
   * 这个文件「继承态的预设」当前生效吗？列表页红点用，语义见
   * FolderService.isPresetActive。
   *
   * 文件不是树上的节点（不在 folders 表里），它的祖先链就是所在目录的链 ——
   * 文件自己顶多算链的末端。所以直接委托给目录。
   *
   * `includeSelf: true` 是关键：文件的「自身三态」不在这条链上，链的第一个
   * 节点是所在目录，**那个目录就是它的边界**。目录拍板了（Shared=1），
   * 文件写在继承态上的名单/公开就该生效 —— 权限判定（resolveFileAccessFrom）
   * 也是这么算的。不传这个标志的话，红点会和权限给出相反的答案。
   *
   * folderId === null（根层文件）→ 上面什么都没有 = 没人拍板 = 预设不生效。
   * 文件自己若是 Shared=1 那是明确表态，不依赖祖先，由调用方另行判定。
   */
  async isPresetActiveForFile(file: OwnedFile): Promise<boolean> {
    if (file.folderId === null || file.folderId === undefined) return false
    return this.folders.isPresetActive(Number(file.folderId), { includeSelf: true })
  }

  /**
   * 解析某用户对某文件的有效权限。算法见模块级的 resolveFileAccessFrom ——
   * 这里只负责从 grants 里挑出这一行。
   */
  private resolveFileAccess(userId: number, file: OwnedFile, inherited: ResolvedAccess): ResolvedAccess {
    const own = file.grants.find((g) => g.userId === userId)
    return resolveFileAccessFrom(file, own?.permission, inherited)
  }

  /**
   * 整棵子树里**我真能下载**的文件（整包下载的清单）。
   *
   * 为什么要过滤：`listSubtreeManifest` 只按 user_id 圈范围，不看权限。
   * 直接把它发给访客，等于把整棵子树的 filename + file_key（真实存储路径）
   * 交出去 —— 包括他连读都没权限的那些。而且前端拿到这份清单后会逐个调
   * /api/files/download，任一文件缺下载位就 403，整个 zip 中途作废。
   * 两个问题一起被「按权限过滤」解决。
   *
   * 属主走快路径原样返回（零额外查询，覆盖绝大多数真实用量）。
   *
   * 访客按 folderId 分组，同一目录只 resolveAccess 一次，文件侧在内存里合 ——
   * 复用的是 resolveFileAccessFrom，不重写一遍权限算法。
   * 代价是「子目录数」次 CTE 查询。要压到一次得写多 seed 的批量上行走法，
   * 那是把权限算法复制一份到 SQL 里，不划算，留作后续优化。
   *
   * skipped 单独返回，让调用方能说清「N 个文件你没权限」，
   * 而不是让用户看到一句莫名的「该文件夹为空」。
   */
  async listDownloadableSubtree(
    visitorId: number,
    ownerId: number,
    folderId: number,
    need: number = PERM_DOWNLOAD
  ): Promise<{ files: ManifestFile[]; skipped: number }> {
    const all = await this.folders.listSubtreeManifest(ownerId, folderId)
    if (!all.length) return { files: [], skipped: 0 }
    if (ownerId === visitorId) return { files: all, skipped: 0 }

    const byFolder = new Map<number, ManifestFile[]>()
    for (const f of all) {
      const key = Number(f.folderId)
      const group = byFolder.get(key)
      if (group) group.push(f)
      else byFolder.set(key, [f])
    }

    // 一次性把访客在这些文件上的直接授权捞回来，避免逐文件查
    const ids = all.map((f) => f.id)
    const grantRes = await this.db
      .prepare(
        `SELECT file_id AS fileId, permission FROM file_access
         WHERE user_id = ? AND file_id IN (${placeholders(ids.length)})`
      )
      .bind(visitorId, ...ids)
      .all()
      .catch(() => null)
    const ownGrants = new Map<number, number>()
    for (const r of grantRes?.results || []) ownGrants.set(Number(r.fileId), Number(r.permission))

    const kept: ManifestFile[] = []
    for (const [dirId, group] of byFolder) {
      const dirAccess = await this.folders.resolveAccess(visitorId, dirId)
      for (const f of group) {
        const access = resolveFileAccessFrom(f, ownGrants.get(f.id), dirAccess)
        if (hasPermission(access.mask, need)) kept.push(f)
      }
    }
    // 分组遍历打散了 relDir 顺序，排序回去 —— 清单是给人看的，也是 zip 里的路径
    kept.sort((a, b) =>
      a.relDir === b.relDir
        ? String(a.filename).localeCompare(String(b.filename))
        : String(a.relDir).localeCompare(String(b.relDir))
    )
    return { files: kept, skipped: all.length - kept.length }
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
  async findAccessibleByKey(
    userId: number,
    fileKey: string,
    need: number,
    deniedMessage?: string
  ): Promise<OwnedFile> {
    /**
     * `ORDER BY id LIMIT 1`：file_key 曾经没有 UNIQUE 约束，重复行是合法的。
     * 原来这条查询没有 ORDER BY / LIMIT，命中哪一行由 SQLite 自己决定 ——
     * 全表扫描时通常是 rowid 最小的那条，但那是实现细节不是保证。
     *
     * 加上排序后行为确定：同一组重复行里永远取最早那条。这不是「修好越权」
     * （越权那半边在 download.post.ts 签 fileRecord.fileKey + 写入侧校验前缀，
     * 见 server/utils/file-key.ts），这里是让「同一请求两次得到同一行」。
     *
     * UNIQUE 索引由 db-migrate 补上，之后重复行不再可能出现；这两句留着，
     * 因为老库里可能已经有重复的存量数据。
     */
    const row = await this.db
      .prepare('SELECT * FROM files WHERE file_key = ? ORDER BY id LIMIT 1')
      .bind(fileKey)
      .first()
    if (!row) throw fileNotFoundError
    const [file] = await this.attachAccess([this.toOwned(row)])
    return this.ensureAccess(userId, file!, need, deniedMessage)
  }

  async findAccessibleById(userId: number, fileId: number, need: number): Promise<OwnedFile> {
    const row = await this.db.prepare('SELECT * FROM files WHERE id = ?').bind(fileId).first()
    if (!row) throw fileNotFoundError
    const [file] = await this.attachAccess([this.toOwned(row)])
    return this.ensureAccess(userId, file!, need)
  }

  /**
   * 批量版，逐个过 findAccessibleById。少一个就整体 404/403，不做部分成功。
   */
  async findAccessibleMany(userId: number, fileIds: number[], need: number): Promise<OwnedFile[]> {
    const ids = uniqPositiveInts(fileIds)
    const out: OwnedFile[] = []
    for (const id of ids) out.push(await this.findAccessibleById(userId, id, need))
    return out
  }

  private async ensureAccess(
    userId: number,
    file: OwnedFile,
    need: number,
    deniedMessage = '该文件的权限不足'
  ): Promise<OwnedFile> {
    if (file.userId === userId) return file
    const resolved = await this.resolveAccessForFile(userId, file)
    if (resolved.mask === 0) throw fileNotFoundError
    if (!hasPermission(resolved.mask, need)) {
      throw createError({ statusCode: 403, message: deniedMessage })
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

  /**
   * 平铺列出「分享给我的」全部条目，跨属主。
   *
   * 两步：
   *  1. SQL 取候选 —— 明确授权给我的（folder_access / file_access 里有我的行），
   *     加上公开的（IsPublic = 1）。这一步只是粗筛。
   *  2. 逐个过 resolveAccess / resolveAccessForFile 过滤出真正读得到的。
   *
   * 第 2 步不能省：IsPublic 只对**该节点自身**生效。如果它躺在一个
   * Shared = 0（不分享，拒绝型边界）的祖先下面，向上查找会停在那个边界上直接
   * 拒绝 —— 此时它虽然标着公开，我其实打不开。只做第 1 步会把死链列出来。
   *
   * 候选集只含「被明确分享或公开」的项，量级小，N+1 的向上递归可以接受。
   */
  async listSharedWithMe(
    userId: number,
    ownerId?: number
  ): Promise<{ folders: SharedEntry<OwnedFolder>[]; files: SharedEntry<OwnedFile>[] }> {
    // ownerId 限定属主：侧栏选中某人时只列那人的共享内容。
    // 注意它只是**范围收窄**，不构成授权 —— 下面每行仍要过 resolveAccess。
    const ownerSql = ownerId !== undefined ? ' AND user_id = ?' : ''
    const folderRows = await this.db
      .prepare(`
        SELECT * FROM folders
        WHERE (IsPublic = 1
           OR EXISTS (SELECT 1 FROM folder_access fa WHERE fa.folder_id = folders.id AND fa.user_id = ?))${ownerSql}
        ORDER BY name COLLATE NOCASE ASC
      `)
      .bind(...(ownerId !== undefined ? [userId, ownerId] : [userId]))
      .all()

    const fileRows = await this.db
      .prepare(`
        SELECT * FROM files
        WHERE (IsPublic = 1
           OR EXISTS (SELECT 1 FROM file_access ga WHERE ga.file_id = files.id AND ga.user_id = ?))${ownerSql}
        ORDER BY created_at DESC
      `)
      .bind(...(ownerId !== undefined ? [userId, ownerId] : [userId]))
      .all()

    // canWrite 一并算出来：平铺清单里只读和读写条目混在一起，
    // 前端要靠它把剪贴/重命名/删除按条目置灰，而不是等点了才报 403。
    const folders: SharedEntry<OwnedFolder>[] = []
    for (const row of folderRows?.results || []) {
      const access = await this.folders.resolveAccess(userId, Number(row.id))
      if (hasPermission(access.mask, PERM_READ)) {
        folders.push({
          ...toOwnedFolder(row),
          canWrite: hasPermission(access.mask, PERM_WRITE),
          perm: access.mask,
          permSource: access.source
        })
      }
    }

    const files = await this.attachAccess((fileRows?.results || []).map((row: any) => this.toOwned(row)))
    const visible: SharedEntry<OwnedFile>[] = []
    for (const f of files) {
      const access = await this.resolveAccessForFile(userId, f)
      if (hasPermission(access.mask, PERM_READ)) {
        visible.push({
          ...f,
          canWrite: hasPermission(access.mask, PERM_WRITE),
          perm: access.mask,
          permSource: access.source
        })
      }
    }

    return { folders, files: visible }
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
  /**
   * 挑出我能读到的文件。
   *
   * `need` 传入具体权限位时按该位过滤（如 PERM_WRITE = 「我能原地改的」），
   * 省略时保持原语义：任何非零掩码都算（= 有读权限）。
   */
  /**
   * 把「我对这批文件的权限」挂回每个文件上。
   *
   * filterAccessible 内部已经用 resolveFileAccess 逐个算对了完整掩码，只是把结果
   * 丢掉了。这里把掩码与来源挂回去，前端才能显示「你所有的权限」。
   * 同一批文件应属同一目录 —— 传 inherited 可以避免逐个去解析目录。
   */
  async attachMasks(
    userId: number,
    files: OwnedFile[],
    inherited?: ResolvedAccess
  ): Promise<SharedEntry<OwnedFile>[]> {
    if (!files.length) return []
    const dirAccess = inherited ?? (await this.folders.resolveAccess(userId, files[0]!.folderId))
    return files.map((file) => {
      const access = this.resolveFileAccess(userId, file, dirAccess)
      return {
        ...file,
        perm: access.mask,
        permSource: access.source,
        canWrite: hasPermission(access.mask, PERM_WRITE)
      }
    })
  }

  async filterAccessible(
    userId: number,
    files: OwnedFile[],
    inherited?: ResolvedAccess,
    need: number = 0
  ): Promise<OwnedFile[]> {
    if (!files.length) return files
    const dirAccess = inherited ?? (await this.folders.resolveAccess(userId, files[0]!.folderId))
    return files.filter((file) => {
      const mask = this.resolveFileAccess(userId, file, dirAccess).mask
      return need ? hasPermission(mask, need) : mask !== 0
    })
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

  /**
   * 按**属主**列目录下的文件，并挂上直接授权。
   * filterAccessible / resolveFileAccess 依赖 file.grants，listByFolders 不带。
   */
  async listByFoldersWithGrants(userId: number, folderIds: number[]): Promise<OwnedFile[]> {
    if (!folderIds.length) return []
    return this.attachAccess(await this.listByFolders(userId, folderIds))
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

  /**
   * 重算存储记账。**整条链**（删文件/移动/复制之后调用）。
   *
   * 每层的 usedStorage 只算它自己名下的文件 —— 这是 sub-account.ts 里
   * 「池 = 主账号自己那份 + 实时 SUM 孩子」的前提。两处算得不一样就会
   * 出现「池明明还有余量却传不进去」。
   *
   * 委托出去而不是就地实现：链的语义只有一处定义。这里再抄一份，
   * 四个调用点就会各算各的（其中一个是 paste 的兜底，错了很难查）。
   *
   * 另有一个同名的自由函数在 server/utils/file.ts，当前没有任何调用点。
   * 留着不影响，但别照着它写 —— 它是链版之前的版本。
   */
  async recalculateUsedStorage(userId: number): Promise<void> {
    await recalculateChainStorage(this.db, userId)
  }
}
