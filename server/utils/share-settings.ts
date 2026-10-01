// 分享管理列表：**我设置过分享的**那些文件与文件夹。
//
// ## 判据（四取一），与用户口语一致
//
//   Shared <> 继承  OR  IsPublic  OR  有人被授权  OR  挂过分享链接
//
// 这四项恰好是「默认态」的全部反面。默认态 = 继承 + 不公开 + 没人 + 没链接。
// 少任何一项都会漏：只按三态查会漏掉「继承但公开了」和「继承但授权了人」
// ——而这两种恰恰是最常见的「我明明分享过了怎么列表里没有」。
//
// ## 范围：只列我自己的树
//
// ownerId 恒为调用者本人，由接口层传入（见 server/api/share/settings.get.ts）。
// 「别人分享给我的」不列：那不是我的设置，我在弹窗里也改不了它。
//
// ## 三条判据里只有一条要查库，另外两条已经在行上了
//
//   三态 / 公开 / 人数 / 链接数 —— 都是本行自己的列或一次子查询
//   presetActive（我设的名单当前生效吗）—— 需要向上找第一个非继承祖先
//   linkActive（链接当前打得开吗）  —— **不需要查库**
//
// 最后一条值得说明，因为它最容易写错。链接能不能用，取决于**边界落在哪一行**：
// 边界 = 自己往上第一个非继承节点，而 token 必须挂在**边界那一行**上。
// 于是「继承」态的条目即使祖先是「分享」，它自己身上的链接也永远是死的
// （祖先身上没有这条链接）。所以：条目自己不是「分享」→ 它身上的链接全死。
// 这与 types/share.ts 的 linkActiveFromShareMode 同一口径，两边必须一致。
//
// ## 为什么不要拿这条列表当审计报告
//
// 它只反映**显式设置**，不反映**实际生效的权限**。一个整条链全是继承的目录，
// 可能因为祖先是「分享」而对某些人可读，但它自己不该出现在这里 ——
// 它没有任何设置。这一页的职责是「我改过什么」，不是「谁能看到什么」。

import type { Database } from '~~/server/utils/db'
import {
  collectHits,
  fileRelDir,
  folderRelDir,
  type FolderPathNode
} from '~~/server/utils/folder-path'
import { linkActiveFromShareMode, normalizeShareMode } from '~~/types/share'
import type { ShareMode } from '~~/types/share'

/**
 * 每类（目录 / 文件）的条数上限。
 *
 * 有两个理由：一是这个列表按定义可以很长（改过分享的东西可能上百个），
 * 二是每行都带一条上行 CTE，太宽的响应在移动端会明显卡。
 * 超了会带 truncated，前端要把「还有更多」说出来（不能让人以为这就是全部）。
 */
export const SHARE_SETTINGS_LIMIT = 200

/** 列表里的一行。目录与文件同构，前端才能用一个列表组件渲染 */
export interface ShareSettingRow {
  id: number
  /** file 或 folder。批量操作与「打开分享设置」都靠它区分目标 */
  targetType: 'file' | 'folder'
  /** 文件夹名或文件名 */
  name: string
  /** 所在目录的文本路径。根层为空串 */
  relDir: string
  /** 从根到目标的目录链，文件到所在目录为止。点「在文件里打开」用 */
  path: FolderPathNode[]
  /** 属主。本接口恒为调用者自己，列出来是为了批量操作时能拼目标 */
  ownerId: number
  /** 共享三态（0 不分享 / 1 分享 / 2 继承） */
  mode: ShareMode
  isPublic: boolean
  /** 直接授权的人数（不含从祖先继承的） */
  grantCount: number
  /** 挂在这一项上的分享链接条数 */
  linkCount: number
  /**
   * 我设的名单/公开当前生效吗。
   *
   * false = 被上级挡住了，或整条链全是继承没人拍板。这种情况下红点提示
   * 「设了但没用上」（types/share.ts 的 preset 分支）。
   * 本来就没设任何东西的行也给 false —— 前端据此不显示提示。
   */
  presetActive: boolean
  /** 这一项上的链接当前打得开吗。与 linkActiveFromShareMode 同口径 */
  linkActive: boolean
  createdAt: string | null
  /** 仅文件：所在目录。null = 根层，此时没有「在文件里打开」的落点 */
  folderId?: number | null
  /** 仅文件 */
  fileSize?: number
  contentType?: string | null
}

export interface ShareSettingsSummary {
  /** 两类合计（不受列表上限影响 —— 摘要说的是「你一共有多少设置」，不是「我给你看几条」） */
  total: number
  folderCount: number
  fileCount: number
  /** 其中设成公开的项数 */
  publicCount: number
  /** 其中设成「不分享」的项数。这类最需要复核：可能是有意的，也可能是忘了 */
  privateCount: number
  /** 所有项上的链接总数 */
  linkCount: number
  /** 其中当前打不开的链接数 */
  deadLinkCount: number
}

export interface ShareSettingsResult {
  folders: ShareSettingRow[]
  files: ShareSettingRow[]
  summary: ShareSettingsSummary
  truncated: boolean
}

/**
 * 「非默认」的 SQL 条件。
 *
 * EXISTS 而不是 JOIN + COUNT：这里只要「有没有」，JOIN 会把一个目录的多个
 * 授权行复制成多行，还得再套一层 DISTINCT 或 GROUP BY。走 ix_folder_access_folder
 * / ix_share_links_target 索引。
 */
const NON_DEFAULT_SQL = `
  Shared <> 2
  OR IsPublic = 1
  OR EXISTS (SELECT 1 FROM folder_access fa WHERE fa.folder_id = f.id)
  OR EXISTS (SELECT 1 FROM share_links sl WHERE sl.target_type = 'folder' AND sl.target_id = f.id)
`

const NON_DEFAULT_SQL_FILE = `
  Shared <> 2
  OR IsPublic = 1
  OR EXISTS (SELECT 1 FROM file_access ga WHERE ga.file_id = f.id)
  OR EXISTS (SELECT 1 FROM share_links sl WHERE sl.target_type = 'file' AND sl.target_id = f.id)
`

/**
 * 行 → ShareSettingRow。
 *
 * `presetActive` 取自外层的 `isPresetActive` 列：那是服务端算的
 * 「我设的东西生效了吗」（要上行找边界）。而 `linkActive` 走纯函数
 * linkActiveFromShareMode —— 同一个判定在前端 types/share.ts 里也有一份，
 * 服务端这里保留一份是为了让接口自足（返回即可判断，不必让调用方再推导）。
 */
function toRow(raw: any, path: FolderPathNode[], targetType: 'file' | 'folder'): ShareSettingRow {
  const mode = normalizeShareMode(raw.shared)
  const row: ShareSettingRow = {
    id: Number(raw.hitId),
    targetType,
    name: String(raw.name),
    relDir: targetType === 'folder' ? folderRelDir(path) : fileRelDir(path),
    path,
    ownerId: Number(raw.ownerId),
    mode,
    isPublic: Number(raw.isPublic ?? 0) === 1,
    grantCount: Number(raw.grantCount ?? 0) || 0,
    linkCount: Number(raw.linkCount ?? 0) || 0,
    presetActive: Number(raw.isPresetActive ?? 0) === 1,
    linkActive: linkActiveFromShareMode(mode),
    createdAt: raw.createdAt ?? null
  }
  if (targetType === 'file') {
    row.folderId = raw.folderId === null || raw.folderId === undefined ? null : Number(raw.folderId)
    row.fileSize = Number(raw.fileSize ?? 0) || 0
    row.contentType = raw.contentType ?? null
  }
  return row
}

/**
 * 「我设的名单/公开当前生效吗」的推导，写成两个可复用片段。
 *
 * 生效 = **边界行的三态是「分享」**。边界 = 自己往上第一个非继承节点
 * （`depth = 0` 就是自己，所以「自己就是边界」天然被覆盖）。
 *
 * 为什么不能用 GROUP BY 一次算完：`up` 是「命中 × 每一级祖先」的平铺结果，
 * 一个 hitId 有多行。而 collectHits 依赖这些多行按 depth 排好序来拼路径 ——
 * 一旦 GROUP BY 折叠成每命中一行，路径就没了。所以这里只**多加一个 CTE**
 * 来定位边界所在的那一行，外层仍然保留全部祖先行。
 *
 * `boundaryDepth` 为 NULL（整条链全是继承，没人拍板）时 `up.shared` 取不到值，
 * `CASE` 落到 ELSE 0 —— 正确：没有任何祖先拍板，我的东西不生效。
 */
const BOUNDARY_CTE = `
  boundaryDepth AS (
    SELECT rootId, MIN(depth) AS d FROM up WHERE shared IN (0, 1) GROUP BY rootId
  )
`

/** 边界行的三态拼进结果集，外层再套一层 CASE */
const BOUNDARY_JOIN = `
  LEFT JOIN boundaryDepth bd ON bd.rootId = h.hitId
  LEFT JOIN up b ON b.rootId = h.hitId AND b.depth = bd.d
`

const PRESET_ACTIVE_EXPR = `CASE WHEN b.shared = 1 THEN 1 ELSE 0 END`

/**
 * 列出我设置过分享的文件夹。
 *
 * `hits` 里就带齐了展示要的一切（三态、公开、人数、链接数），
 * `up` 向上走只为了两件事：拼路径、判 presetActive。
 */
async function listFolders(db: Database, ownerId: number, limit: number) {
  const res = await db
    .prepare(
      `
      WITH RECURSIVE hits AS (
        SELECT f.id AS hitId, f.user_id AS ownerId, f.name AS name,
               f.parent_id AS parentId, f.Shared AS shared, f.IsPublic AS isPublic,
               f.created_at AS createdAt,
               (SELECT COUNT(*) FROM folder_access fa WHERE fa.folder_id = f.id) AS grantCount,
               (SELECT COUNT(*) FROM share_links sl
                 WHERE sl.target_type = 'folder' AND sl.target_id = f.id) AS linkCount
        FROM folders f
        WHERE f.user_id = ? AND (${NON_DEFAULT_SQL})
        ORDER BY f.name COLLATE NOCASE ASC
        LIMIT ?
      ),
      up(rootId, ownerId, id, name, parentId, shared, depth) AS (
        SELECT hitId, ownerId, hitId, name, parentId, shared, 0 FROM hits
        UNION ALL
        SELECT up.rootId, up.ownerId, p.id, p.name, p.parent_id, p.Shared, up.depth + 1
        FROM folders p JOIN up ON p.id = up.parentId AND p.user_id = up.ownerId
      ),
      ${BOUNDARY_CTE}
      SELECT h.hitId AS hitId, h.ownerId AS ownerId, h.name AS name,
             h.shared AS shared, h.isPublic AS isPublic, h.createdAt AS createdAt,
             h.grantCount AS grantCount, h.linkCount AS linkCount,
             up.id AS pathId, up.name AS pathName, up.depth AS pathDepth,
             ${PRESET_ACTIVE_EXPR} AS isPresetActive
      FROM hits h
      LEFT JOIN up ON up.rootId = h.hitId
      ${BOUNDARY_JOIN}
      ORDER BY h.hitId, up.depth DESC
    `
    )
    .bind(ownerId, limit + 1)
    .all()

  return collectHits<ShareSettingRow>(
    (res?.results || []) as Array<Record<string, any>>,
    limit,
    (row, path) => toRow(row, path, 'folder')
  )
}

/**
 * 列出我设置过分享的文件。
 *
 * 与目录那份唯一的结构差别：上溯从 `folder_id` 起头，文件本身不是容器，
 * 所以 depth 0 是**所在目录**（不是文件）。根层文件 folder_id 为 NULL，
 * 起头 JOIN 不出行，path 自然是空的 —— 这正是「在根目录」的正确表达。
 */
async function listFiles(db: Database, ownerId: number, limit: number) {
  const res = await db
    .prepare(
      `
      WITH RECURSIVE hits AS (
        SELECT f.id AS hitId, f.user_id AS ownerId, f.filename AS name,
               f.folder_id AS folderId, f.Shared AS shared, f.IsPublic AS isPublic,
               f.created_at AS createdAt, f.file_size AS fileSize,
               f.content_type AS contentType,
               (SELECT COUNT(*) FROM file_access ga WHERE ga.file_id = f.id) AS grantCount,
               (SELECT COUNT(*) FROM share_links sl
                 WHERE sl.target_type = 'file' AND sl.target_id = f.id) AS linkCount
        FROM files f
        WHERE f.user_id = ? AND (${NON_DEFAULT_SQL_FILE})
        ORDER BY f.filename COLLATE NOCASE ASC
        LIMIT ?
      ),
      up(rootId, ownerId, id, name, parentId, shared, depth) AS (
        SELECT h.hitId, h.ownerId, p.id, p.name, p.parent_id, p.Shared, 0
        FROM hits h JOIN folders p ON p.id = h.folderId AND p.user_id = h.ownerId
        UNION ALL
        SELECT up.rootId, up.ownerId, p.id, p.name, p.parent_id, p.Shared, up.depth + 1
        FROM folders p JOIN up ON p.id = up.parentId AND p.user_id = up.ownerId
      ),
      ${BOUNDARY_CTE}
      SELECT h.hitId AS hitId, h.ownerId AS ownerId, h.name AS name,
             h.shared AS shared,
             h.isPublic AS isPublic, h.createdAt AS createdAt, h.fileSize AS fileSize,
             h.contentType AS contentType, h.folderId AS folderId,
             h.grantCount AS grantCount, h.linkCount AS linkCount,
             up.id AS pathId, up.name AS pathName, up.depth AS pathDepth,
             ${PRESET_ACTIVE_EXPR} AS isPresetActive
      FROM hits h
      LEFT JOIN up ON up.rootId = h.hitId
      ${BOUNDARY_JOIN}
      ORDER BY h.hitId, up.depth DESC
    `
    )
    .bind(ownerId, limit + 1)
    .all()

  return collectHits<ShareSettingRow>(
    (res?.results || []) as Array<Record<string, any>>,
    limit,
    (row, path) => toRow(row, path, 'file')
  )
}

/**
 * 摘要：不带 LIMIT 的独立统计。
 *
 * 刻意与列表分开查。列表有上限（200），摘要必须说真话 —— 如果摘要从被截断的
 * 列表里累加，页头会显示「共 12 项」而下面只列 200 条，越大越说不圆。
 * 两条 COUNT 都是走索引的聚合，用户量级下开销可忽略。
 */
async function summarize(db: Database, ownerId: number) {
  const res = await db
    .prepare(
      `
      SELECT
        (SELECT COUNT(*) FROM folders f
          WHERE f.user_id = ? AND (${NON_DEFAULT_SQL})) AS folderCount,
        (SELECT COUNT(*) FROM files f
          WHERE f.user_id = ? AND (${NON_DEFAULT_SQL_FILE})) AS fileCount,
        (SELECT COUNT(*) FROM folders f
          WHERE f.user_id = ? AND f.IsPublic = 1 AND (${NON_DEFAULT_SQL})) AS publicFolderCount,
        (SELECT COUNT(*) FROM files f
          WHERE f.user_id = ? AND f.IsPublic = 1 AND (${NON_DEFAULT_SQL_FILE})) AS publicFileCount,
        (SELECT COUNT(*) FROM folders f
          WHERE f.user_id = ? AND f.Shared = 0 AND (${NON_DEFAULT_SQL})) AS privateFolderCount,
        (SELECT COUNT(*) FROM files f
          WHERE f.user_id = ? AND f.Shared = 0 AND (${NON_DEFAULT_SQL_FILE})) AS privateFileCount,
        (SELECT COUNT(*) FROM share_links sl JOIN folders f ON f.id = sl.target_id
          WHERE sl.target_type = 'folder' AND f.user_id = ?) AS folderLinkCount,
        (SELECT COUNT(*) FROM share_links sl JOIN files f ON f.id = sl.target_id
          WHERE sl.target_type = 'file' AND f.user_id = ?) AS fileLinkCount,
        (SELECT COUNT(*) FROM share_links sl JOIN folders f ON f.id = sl.target_id
          WHERE sl.target_type = 'folder' AND f.user_id = ? AND f.Shared <> 1) AS deadFolderLinkCount,
        (SELECT COUNT(*) FROM share_links sl JOIN files f ON f.id = sl.target_id
          WHERE sl.target_type = 'file' AND f.user_id = ? AND f.Shared <> 1) AS deadFileLinkCount
    `
    )
    // 10 个占位符，顺序与上面 SELECT 里 ? 的出现顺序一致
    .bind(
      ownerId, ownerId, ownerId, ownerId, ownerId, ownerId,
      ownerId, ownerId, ownerId, ownerId
    )
    .first()

  const folderCount = Number((res as any)?.folderCount ?? 0) || 0
  const fileCount = Number((res as any)?.fileCount ?? 0) || 0
  return {
    total: folderCount + fileCount,
    folderCount,
    fileCount,
    publicCount:
      (Number((res as any)?.publicFolderCount ?? 0) || 0) +
      (Number((res as any)?.publicFileCount ?? 0) || 0),
    privateCount:
      (Number((res as any)?.privateFolderCount ?? 0) || 0) +
      (Number((res as any)?.privateFileCount ?? 0) || 0),
    linkCount:
      (Number((res as any)?.folderLinkCount ?? 0) || 0) +
      (Number((res as any)?.fileLinkCount ?? 0) || 0),
    deadLinkCount:
      (Number((res as any)?.deadFolderLinkCount ?? 0) || 0) +
      (Number((res as any)?.deadFileLinkCount ?? 0) || 0)
  } as ShareSettingsSummary
}

/**
 * 列出我设置过分享的全部条目。
 *
 * **串行**执行（不是 Promise.all）：同一个 sqlite3 handle 并发跑语句时
 * 本机原生绑定会崩，这是本项目的硬约束（见 server/api/files/index.get.ts）。
 */
export async function listShareSettings(
  db: Database,
  ownerId: number,
  limit: number = SHARE_SETTINGS_LIMIT
): Promise<ShareSettingsResult> {
  const folders = await listFolders(db, ownerId, limit)
  const files = await listFiles(db, ownerId, limit)
  const summary = await summarize(db, ownerId)

  return {
    folders: folders.hits,
    files: files.hits,
    summary,
    truncated: folders.truncated || files.truncated
  }
}
