// 分享权限算法的复刻 —— 供 tests/resolve-access 与 tests/manifest-access 共用。
//
// 为什么复刻而不是 import server/utils/db.ts：它依赖 Nuxt 的自动导入（createError 等
// 全局）和 sqlite3 封装，在 node --test 里跑不起来。所以把算法本体复制到这里。
//
// **代价：改了 db.ts 的算法必须同步改这里**，否则测试测的是旧逻辑。
// 每个函数上方都标了对应的源码位置（db.ts:xxx 之类），方便对照。
// 复制到一份公共 helper 而不是每个测试文件各抄一份：三个测试都跑这套算法，
// 抄三份的话改 db.ts 只会更新到其中一份，另两份静默过期。

export const PERM_READ = 1
export const PERM_WRITE = 2
export const PERM_DELETE = 4
export const PERM_DOWNLOAD = 8
export const SHARE_NONE = 0
export const SHARE_SHARED = 1
export const SHARE_INHERIT = 2

// —— 以下两个函数逐字复制自 types/share.ts ——
export function normalizeShareMode(value) {
  if (value === null || value === undefined || value === '') return SHARE_INHERIT
  if (typeof value === 'object' || typeof value === 'boolean') return SHARE_INHERIT
  const n = Number(value)
  if (n === SHARE_NONE || n === SHARE_SHARED || n === SHARE_INHERIT) return n
  return SHARE_INHERIT
}

/**
 * types/share.ts normalizePermission：按位独立，不是单轴压档。
 *
 * 这里曾经留着旧版（`if (m & 4) return 7` 那种压档逻辑）—— 加上 PERM_DOWNLOAD
 * 之后它就是错的：7 会被补成 15，而 15 会被压回 7。留着等于测旧逻辑。
 */
export function normalizePermission(mask) {
  const m = Number(mask) || 0
  if (!Number.isFinite(m) || m <= 0) return 0
  let out = 0
  for (const bit of [PERM_READ, PERM_WRITE, PERM_DELETE, PERM_DOWNLOAD]) if (m & bit) out |= bit
  // 旧数据的「全权」是 7，语义上等价于新模型的全权 15
  if (out === (PERM_READ | PERM_WRITE | PERM_DELETE)) out |= PERM_DOWNLOAD
  return out
}

export function hasPermission(mask, need) {
  const granted = normalizePermission(mask)
  const required = normalizePermission(need)
  return (granted & required) === required
}

export const toBool = (v) => v === true || v === 1 || v === '1'

// —— 复刻自 server/utils/db.ts ——
const NO_ACCESS = { mode: SHARE_INHERIT, mask: 0, source: 'none', hasBoundary: false }

/** db.ts decideAncestor */
export function decideAncestor(mode, isPublic, row) {
  if (mode === SHARE_INHERIT) return NO_ACCESS
  if (mode === SHARE_NONE) {
    return { mode, mask: 0, source: 'none', hasBoundary: true }
  }
  const own = row && row.permission != null ? normalizePermission(row.permission) : 0
  return {
    mode,
    mask: normalizePermission(own | (isPublic ? PERM_READ : 0)),
    source: own > 0 ? 'inherited' : isPublic ? 'public' : 'none',
    hasBoundary: true
  }
}

/** db.ts combineWithAncestor */
export function combineWithAncestor(self, ancestor, belowMask, belowPub, belowGrants, hasBoundary) {
  const own = self.permission != null ? normalizePermission(self.permission) : 0
  const direct = normalizePermission(own | (self.isPublic ? PERM_READ : 0))
  const mode = normalizeShareMode(self.mode)

  if (mode === SHARE_NONE) {
    return { mode: SHARE_NONE, mask: 0, source: 'none', hasBoundary }
  }
  if (mode === SHARE_SHARED) {
    return { mode: SHARE_SHARED, mask: direct, source: 'self', hasBoundary }
  }
  // 没人拍板 → 预设（自身的名单/公开）不生效
  if (!hasBoundary) {
    return { mode: SHARE_NONE, mask: 0, source: 'none', hasBoundary: false }
  }
  // 祖先是「不分享」→ 墙，连自身的直接授权一起挡
  if (ancestor.mode === SHARE_NONE) {
    return { mode: SHARE_NONE, mask: 0, source: 'none', hasBoundary: true }
  }
  const isPublicAny = self.isPublic || ancestor.isPublic || belowPub
  const source =
    own > 0 ? 'self'
      : ancestor.mask > 0 ? ancestor.source
        : belowGrants > 0 ? 'inherited'
          : isPublicAny ? 'public'
            : 'none'
  return {
    mode: SHARE_INHERIT,
    isPublic: isPublicAny,
    mask: normalizePermission(direct | ancestor.mask | belowMask),
    source,
    hasBoundary: true
  }
}

/**
 * db.ts resolveFileAccessFrom（模块级那个）：文件侧叠祖先。
 *
 * `ownPermission` 是 file_access 里那一条直接授权，没有就给 undefined。
 *
 * backed 判据见 db.ts 的注释：**不能只看 inherited.hasBoundary**，
 * 它只回答「祖先链里有没有拍板者」。当前目录**自己**是边界时它是 false，
 * 而文件正是要继承这个目录 —— 只看它会把继承态文件全部归零（既有 bug）。
 */
export function resolveFileAccessFrom(self, ownPermission, inherited) {
  const backed = inherited.hasBoundary === true || inherited.mode !== SHARE_INHERIT
  return combineWithAncestor(
    { mode: normalizeShareMode(self.Shared), isPublic: toBool(self.IsPublic), permission: ownPermission },
    inherited,
    0,
    false,
    0,
    backed
  )
}

/**
 * 把三个需要查库的算法绑到一个 fixture 上。
 * @param {{ all: (q: string, p?: any[]) => Promise<any[]> }} fx sqlite-fixture 的句柄
 */
export function makeAccessAlgorithms(fx) {
  /**
   * db.ts FolderService.resolveAccess 的真实 SQL + 合并逻辑
   */
  async function resolveAccess(userId, folderId) {
    const rows = await fx.all(
      `WITH RECURSIVE up(id, parent_id, shared, pub, depth) AS (
         SELECT id, parent_id, Shared, IsPublic, 0 FROM folders WHERE id = ?
         UNION ALL
         SELECT f.id, f.parent_id, f.Shared, f.IsPublic, up.depth + 1
         FROM folders f JOIN up ON f.id = up.parent_id
       ),
       boundary AS (
         SELECT COALESCE(
           (SELECT MIN(depth) FROM up WHERE shared IN (0,1) AND depth > 0),
           (SELECT MAX(depth) FROM up)
         ) AS depth
       ),
       picked AS (
         SELECT up.id, up.shared, up.pub, up.depth,
           CASE WHEN up.depth = 0 THEN 0
                WHEN up.shared IN (0,1) AND up.depth <= boundary.depth THEN 1
                ELSE 2 END AS pri
         FROM up, boundary WHERE up.depth = 0 OR up.depth <= boundary.depth
       )
       SELECT p.pri, p.depth, p.shared, p.pub, fa.permission
       FROM picked p
       LEFT JOIN folder_access fa ON fa.folder_id = p.id AND fa.user_id = ?
       ORDER BY p.depth ASC`,
      [folderId, userId]
    )
    const self = rows.find((r) => Number(r.depth) === 0)
    if (!self) return { mask: 0, note: '找不到自身' }

    let belowGrants = 0
    let belowPub = false
    for (const r of rows) {
      if (Number(r.pri) !== 2) continue
      if (r.permission != null) {
        belowGrants = normalizePermission(belowGrants | normalizePermission(r.permission))
      }
      if (toBool(r.pub)) belowPub = true
    }
    const belowMask = normalizePermission(belowGrants | (belowPub ? PERM_READ : 0))

    const anc = rows.find(
      (r) => Number(r.depth) > 0 && (Number(r.shared) === 0 || Number(r.shared) === 1)
    )
    const ancestor = anc ? decideAncestor(normalizeShareMode(anc.shared), toBool(anc.pub), anc) : NO_ACCESS

    return combineWithAncestor(
      { mode: self.shared, isPublic: toBool(self.pub), permission: self.permission },
      ancestor, belowMask, belowPub, belowGrants, !!anc
    )
  }

  /**
   * db.ts FolderService.isPresetActive：只问「有没有拍板者、是不是墙」。
   *
   * `includeSelf` 是给文件用的（isPresetActiveForFile 传 true）：
   * 文件不在 folders 表里，链的第一个节点是**所在目录**，那个目录就是它的边界；
   * 而对目录本身，depth 0 是它自己，一个设成「分享」的目录不算预设。
   */
  async function isPresetActive(folderId, opts) {
    const minDepth = opts?.includeSelf ? 0 : 1
    const rows = await fx.all(
      `WITH RECURSIVE up(id, parent_id, shared, depth) AS (
         SELECT id, parent_id, Shared, 0 FROM folders WHERE id = ?
         UNION ALL
         SELECT f.id, f.parent_id, f.Shared, up.depth + 1
         FROM folders f JOIN up ON f.id = up.parent_id
       )
       SELECT shared, depth FROM up ORDER BY depth ASC`,
      [folderId]
    )
    if (!rows.length) return false
    const boundary = rows.find(
      (r) => Number(r.depth) >= minDepth && (Number(r.shared) === 0 || Number(r.shared) === 1)
    )
    if (!boundary) return false
    return Number(boundary.shared) !== 0
  }

  /**
   * db.ts FolderService.listSubtreeManifest。
   *
   * **不过滤权限** —— 只回答「这棵树里有哪些文件」。属主直接用这份，
   * 访客由 listDownloadableSubtree 按 folderId 分组后逐目录解析权限。
   * 所以它多带 folder_id / Shared / IsPublic 三列供后者使用。
   */
  async function listSubtreeManifest(ownerId, folderId) {
    const rows = await fx.all(
      `WITH RECURSIVE tree(id, name, parent_id, rel_dir) AS (
         SELECT id, name, parent_id, '' AS rel_dir
         FROM folders WHERE id = ? AND user_id = ?
         UNION ALL
         SELECT f.id, f.name, f.parent_id,
           CASE WHEN tree.rel_dir = '' THEN f.name
                ELSE tree.rel_dir || '/' || f.name END
         FROM folders f JOIN tree ON f.parent_id = tree.id
         WHERE f.user_id = ?
       )
       SELECT fl.id AS id, fl.filename AS filename, fl.file_key AS fileKey,
              fl.file_size AS fileSize, tree.rel_dir AS relDir,
              fl.folder_id AS folderId, fl.Shared AS Shared, fl.IsPublic AS IsPublic
       FROM files fl JOIN tree ON fl.folder_id = tree.id
       WHERE fl.user_id = ?
       ORDER BY relDir, filename`,
      [folderId, ownerId, ownerId, ownerId]
    )
    return rows
  }

  /**
   * db.ts FileService.listDownloadableSubtree。
   *
   * 属主走快路径原样返回（零额外查询）；访客按 folderId 分组，
   * 同一目录只 resolveAccess 一次，文件侧在内存里合 resolveFileAccessFrom。
   */
  async function listDownloadableSubtree(visitorId, ownerId, folderId, need = PERM_DOWNLOAD) {
    const all = await listSubtreeManifest(ownerId, folderId)
    if (!all.length) return { files: [], skipped: 0 }
    if (ownerId === visitorId) return { files: all, skipped: 0 }

    const byFolder = new Map()
    for (const f of all) {
      const key = Number(f.folderId)
      const group = byFolder.get(key)
      if (group) group.push(f)
      else byFolder.set(key, [f])
    }

    const ids = all.map((f) => f.id)
    const grantRows = await fx.all(
      `SELECT file_id AS fileId, permission FROM file_access
       WHERE user_id = ? AND file_id IN (${ids.map(() => '?').join(',')})`,
      [visitorId, ...ids]
    )
    const ownGrants = new Map(grantRows.map((r) => [Number(r.fileId), Number(r.permission)]))

    const kept = []
    for (const [dirId, group] of byFolder) {
      const dirAccess = await resolveAccess(visitorId, dirId)
      for (const f of group) {
        const access = resolveFileAccessFrom(f, ownGrants.get(Number(f.id)), dirAccess)
        if (hasPermission(access.mask, need)) kept.push(f)
      }
    }
    kept.sort((a, b) =>
      String(a.relDir) === String(b.relDir)
        ? String(a.filename).localeCompare(String(b.filename))
        : String(a.relDir).localeCompare(String(b.relDir))
    )
    return { files: kept, skipped: all.length - kept.length }
  }

  return { resolveAccess, isPresetActive, listSubtreeManifest, listDownloadableSubtree }
}
