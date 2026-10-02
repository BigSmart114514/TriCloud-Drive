// 文件/目录按名称搜索。
//
// 抽成独立文件而不是塞进 db.ts 的 FolderService / FileService，有两个原因：
//
//   1. LIKE 模式**必须**转义（escapeLike，见 server/utils/escape.ts）：% 和 _
//      是通配符，不转义的话搜 "50%" 会命中 "50abc"，搜 "_" 会命中所有单字符名字。
//      escapeLike 原先住在 file.ts，而 file.ts import 了 db.ts，反向再引会成环；
//      现在挪进自己的模块，依赖是单向的。
//   2. 搜索是横切：它同时读 folders 和 files，还要左连 users 取属主名，
//      不属于任何一侧的 service。
//
// ## 范围由 ownerId 决定，不由调用方的身份决定
//
//   ownerId = <某人的 id> → 只搜那个人的树（首页「我的文件」）
//   ownerId = null        → 全站（只有超管那条路会传 null）
//
// 「谁能传 null」是接口层的事（server/api/files/search.get.ts 里判
// isSuperAdmin），这里只负责按参数查。把范围判定和查询分开，是因为
// SQL 里的 user_id 条件就是权限边界本身 —— 它不该依赖调用方传对的
// authUserId 之类的东西来兜底。
//
// ## 为什么不过 resolveAccess
//
// ownerId 非空时查的是**自己的树**：属主对自己永远全权，不需要逐条判。
// null 时查的是全站，调用方是超管，语义同 /manage/files 的 useAdmin=true
// （以每个属主的身份看）。两条路都不存在「我只被授权了子树的一部分」
// 那种情况，所以这里不接权限过滤，也就避开了 attachMasks / filterAccessible
// 「本批文件必须同目录」的约束。
//
// ## 上溯的每一跳都带着属主条件
//
// 「子目录的 user_id 必须等于父目录」这件事，只有 sqlite 的 schema.sql 用
// 触发器保证；db-migrate.ts 的 MySQL 路径没有对应的约束。而这条查询两边都跑
// （db-adapter 双适配），所以递归步里显式写 `p.user_id = up.ownerId` ——
// 路径的拼接不依赖某个方言才有的护栏。真出现跨属主的父子链时，链在那里断掉，
// 路径停在断点，而不是把别人的目录名带出来。

import type { Database } from '~~/server/utils/db'
import { escapeLike } from '~~/server/utils/escape'
import {
  collectHits,
  fileRelDir,
  folderRelDir,
  type FolderPathNode,
  type HitPathRow
} from '~~/server/utils/folder-path'

/**
 * 每类（目录 / 文件）的结果上限。
 *
 * 有上限是必须的：`LIKE '%kw%'` 无法走索引（sqlite 里中缀匹配用不上
 * B-tree），只能全表扫，一个 "a" 能把整棵树的文件名都捞回来。50 条足够
 * 定位，超了就在响应里标 truncated，由前端说明「只显示前 50 条」。
 */
export const SEARCH_RESULT_LIMIT = 50

/**
 * 面包屑的一级。path 是「从根到目标」的完整链路，供前端重建导航。
 *
 * 与分享管理列表共用同一个类型（见 server/utils/folder-path.ts）—— 两边
 * 产出的是同一种东西，前端也是同一处消费（FileBrowser 的 initialJump）。
 * 这里保留 SearchPathNode 这个名字，调用方不必知道它 aliased 了谁。
 */
export type SearchPathNode = FolderPathNode

interface SearchHitBase {
  /** 属主 id。全站搜索时一行一个属主，前端据此（必要时）切换侧栏 */
  ownerId: number
  /** 属主显示名（用户名，没有则邮箱）。仅全站搜索需要展示 */
  ownerLabel: string | null
  /**
   * 从根到目标的每一级。
   *   目录命中 → 含目标自己（点开就是进它）
   *   文件命中 → 到它**所在目录**为止（文件不是容器，路径以目录收尾）
   */
  path: SearchPathNode[]
  /** 目标所在位置的文本路径，给列表第二行显示用 */
  relDir: string
}

export interface SearchFolderHit extends SearchHitBase {
  id: number
  name: string
}

export interface SearchFileHit extends SearchHitBase {
  id: number
  filename: string
  /**
   * COS 真实对象路径。
   *
   * **两道前提才给**：ownerId 非空时是我自己的文件，null 时调用方是超管。
   * 两种情况都已鉴权，所以照给 —— 预览要拿它换下载签名。将来若有人给
   * 搜索加「搜别人分享给我的」，这里必须按下载位抹掉（见
   * server/api/files/index.get.ts 的 withMeta 注释）。
   */
  fileKey: string
  fileSize: number
  contentType: string | null
  folderId: number | null
  createdAt: string | null
}

/**
 * 上溯 CTE 的原始行：同一个 hitId 有多行，depth 越大越靠近根。
 *
 * 命中的列（name / filename / …）只在 depth 最大的那几行里可靠 —— 递归
 * 出来的父级行没有它们。折叠时按 hitId 去重后取第一条，那时读到的就是
 * 命中行自己的值（SELECT 的列在递归里没有投影，所以走的是外层 hits 的列）。
 */
interface PathRow extends HitPathRow {
  hitId: number
  ownerId: number
  ownerUsername: string | null
  ownerEmail: string | null
  pathId: number | null
  pathName: string | null
  /** 目录命中才有 */
  name?: string
  /** 文件命中才有 */
  filename?: string
  fileKey?: string
  fileSize?: number
  contentType?: string | null
  folderId?: number | null
  createdAt?: string | null
}

function ownerLabelOf(row: PathRow): string | null {
  return row.ownerUsername || row.ownerEmail || null
}

/** LIKE 的模式串。转义后再包 % —— 顺序不能反，否则 % 会被转义掉 */
function likePattern(keyword: string): string {
  return `%${escapeLike(keyword)}%`
}

/**
 * 搜目录。
 *
 * 形状：hits（命中，带 LIMIT）→ up（从命中行向上走到根）→ 左连接回 hits。
 * 用 LEFT JOIN 而不是 JOIN 是为了根层命中也能出行 —— 对目录来说根层
 * 必然有一行（自己就是 depth=0），但写成 LEFT 让两边的 SQL 形状一致。
 *
 * `ESCAPE '\'` 必须和 escapeLike 配对出现：sqlite 默认没有转义字符，
 * 单独转义而不声明 ESCAPE 的话，反斜杠会被当成普通字符去匹配。
 */
export async function searchFolders(
  db: Database,
  keyword: string,
  ownerId: number | null,
  limit: number = SEARCH_RESULT_LIMIT
): Promise<{ hits: SearchFolderHit[]; truncated: boolean }> {
  const scoped = ownerId === null ? '' : 'AND f.user_id = ?'
  const args: any[] = [likePattern(keyword)]
  if (ownerId !== null) args.push(ownerId)
  args.push(limit + 1)

  const res = await db
    .prepare(`
      WITH RECURSIVE hits AS (
        SELECT f.id AS hitId, f.user_id AS ownerId, f.name AS name,
               f.parent_id AS parentId,
               u.username AS ownerUsername, u.email AS ownerEmail
        FROM folders f
        LEFT JOIN users u ON u.id = f.user_id
        WHERE f.name LIKE ? ESCAPE '\\' ${scoped}
        ORDER BY f.name COLLATE NOCASE ASC
        LIMIT ?
      ),
      up(rootId, ownerId, id, name, parentId, depth) AS (
        SELECT hitId, ownerId, hitId, name, parentId, 0 FROM hits
        UNION ALL
        SELECT up.rootId, up.ownerId, p.id, p.name, p.parent_id, up.depth + 1
        FROM folders p JOIN up ON p.id = up.parentId AND p.user_id = up.ownerId
      )
      SELECT h.hitId AS hitId, h.ownerId AS ownerId, h.name AS name,
             h.ownerUsername AS ownerUsername, h.ownerEmail AS ownerEmail,
             up.id AS pathId, up.name AS pathName, up.depth AS pathDepth
      FROM hits h
      LEFT JOIN up ON up.rootId = h.hitId
      ORDER BY h.hitId, up.depth DESC
    `)
    .bind(...args)
    .all()

  const rows = (res?.results || []) as PathRow[]

  // 去重、折叠路径、截断都在 collectHits 里，见 server/utils/folder-path.ts
  return collectHits<SearchFolderHit>(rows as unknown as Array<Record<string, any>>, limit, (row, path) => ({
    id: Number(row.hitId),
    name: String(row.name),
    ownerId: Number(row.ownerId),
    ownerLabel: ownerLabelOf(row as PathRow),
    path,
    // 目录的 relDir 是**父**路径：显示「它在哪」，不含自己
    relDir: folderRelDir(path)
  }))
}

/**
 * 搜文件。
 *
 * 和目录那份的差别只有两处：
 *   1. hits 从 files 里来，向上走要用 folder_id 起头（根层文件 folder_id
 *      为 NULL，命中行不会产出任何 up 行，path 自然是空的 —— 这正是
 *      「在根目录」的正确表达，不需要特判）
 *   2. relDir 取整条 path（path 到所在目录为止，本身就是「在哪」）
 */
export async function searchFiles(
  db: Database,
  keyword: string,
  ownerId: number | null,
  limit: number = SEARCH_RESULT_LIMIT
): Promise<{ hits: SearchFileHit[]; truncated: boolean }> {
  const scoped = ownerId === null ? '' : 'AND f.user_id = ?'
  const args: any[] = [likePattern(keyword)]
  if (ownerId !== null) args.push(ownerId)
  args.push(limit + 1)

  const res = await db
    .prepare(`
      WITH RECURSIVE hits AS (
        SELECT f.id AS hitId, f.user_id AS ownerId, f.filename AS filename,
               f.file_key AS fileKey, f.file_size AS fileSize,
               f.content_type AS contentType, f.created_at AS createdAt,
               f.folder_id AS folderId,
               u.username AS ownerUsername, u.email AS ownerEmail
        FROM files f
        LEFT JOIN users u ON u.id = f.user_id
        WHERE f.filename LIKE ? ESCAPE '\\' ${scoped}
        ORDER BY f.filename COLLATE NOCASE ASC
        LIMIT ?
      ),
      up(rootId, ownerId, id, name, parentId, depth) AS (
        SELECT h.hitId, h.ownerId, p.id, p.name, p.parent_id, 0
        FROM hits h JOIN folders p ON p.id = h.folderId AND p.user_id = h.ownerId
        UNION ALL
        SELECT up.rootId, up.ownerId, p.id, p.name, p.parent_id, up.depth + 1
        FROM folders p JOIN up ON p.id = up.parentId AND p.user_id = up.ownerId
      )
      SELECT h.hitId AS hitId, h.ownerId AS ownerId, h.filename AS filename,
             h.fileKey AS fileKey, h.fileSize AS fileSize,
             h.contentType AS contentType, h.createdAt AS createdAt,
             h.folderId AS folderId,
             h.ownerUsername AS ownerUsername, h.ownerEmail AS ownerEmail,
             up.id AS pathId, up.name AS pathName, up.depth AS pathDepth
      FROM hits h
      LEFT JOIN up ON up.rootId = h.hitId
      ORDER BY h.hitId, up.depth DESC
    `)
    .bind(...args)
    .all()

  const rows = (res?.results || []) as PathRow[]

  return collectHits<SearchFileHit>(rows as unknown as Array<Record<string, any>>, limit, (row, path) => ({
    id: Number(row.hitId),
    filename: String(row.filename),
    fileKey: String(row.fileKey),
    fileSize: Number(row.fileSize),
    contentType: row.contentType ?? null,
    folderId: row.folderId === null || row.folderId === undefined ? null : Number(row.folderId),
    createdAt: row.createdAt ?? null,
    ownerId: Number(row.ownerId),
    ownerLabel: ownerLabelOf(row as PathRow),
    path,
    relDir: fileRelDir(path)
  }))
}
