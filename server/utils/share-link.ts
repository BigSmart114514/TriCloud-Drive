// 分享链接：匿名 bearer token，挂在文件或文件夹上，权限锁死「读 + 下载」。
//
// 判定规则（与 combineWithAncestor 同源但**独立实现**）：
//   从节点自己往上找第一个 `Shared != 继承` 的节点：
//     那儿挂着这条 token → 放行
//     那儿是「不分享」    → 拒绝（墙）
//     一路找到根目录还没遇到非继承 → 拒绝（根目录是阻止）
//
// 为什么不复用 combineWithAncestor：它按 userId 查 file_access / folder_access，
// 链接没有 userId，查询形状都不一样。共用同一套「三态 + 边界 + 墙」的语义，
// 但代码各写各的 —— 把两种授权塞进一个函数，两条路的边界条件会互相污染。
//
// 由此推出的一个语义（不是额外选择，是规则本身的结果）：**继承态下的链接是预设**。
// 设在继承目录上、但上游没人拍板（或被「不分享」墙挡）时，链接是死的；
// 等上游哪天出现「分享」节点，它自动生效，不必重新发链接。
import crypto from 'crypto'
import { getRequestURL } from 'h3'
import type { Database, FileService, FolderService, ManifestFile, OwnedFile } from '~~/server/utils/db'
import { resolveShareTarget } from '~~/server/utils/share'
import type { ShareTarget, ShareTargetType } from '~~/server/utils/share'
import {
  LINK_PERMISSION,
  normalizeShareLink,
  SHARE_INHERIT,
  SHARE_LINK_PAGE_PREFIX,
  SHARE_LINK_TOKEN_BYTES
} from '~~/types/share'

export interface ShareLinkRow {
  id: number
  link: string
  targetType: ShareTargetType
  targetId: number
  createdAt: string | null
}

function toTargetType(value: any): ShareTargetType {
  return value === 'file' ? 'file' : 'folder'
}

function toRow(r: any): ShareLinkRow {
  return {
    id: Number(r.id),
    link: String(r.link),
    targetType: toTargetType(r.targetType),
    targetId: Number(r.targetId),
    createdAt: r.createdAt ?? null
  }
}

/** 从入参里取出合法 token，形状不对直接 400（挡掉超长串和畸形串，省一次注定落空的查库） */
export function requireShareLink(value: any): string {
  const link = normalizeShareLink(value)
  if (!link) {
    throw createError({ statusCode: 400, message: '非法的分享链接' })
  }
  return link
}

/**
 * token → 链接行。找不到返回 null，由调用方决定 404 还是别的口径 ——
 * 「token 不存在」和「token 有效但你没权限」是两回事，别在底层就抹平。
 */
export async function findLinkRow(db: Database, link: string): Promise<ShareLinkRow | null> {
  const row = await db
    .prepare(
      `SELECT id, link, target_type AS targetType, target_id AS targetId, created_at AS createdAt
       FROM share_links WHERE link = ?`
    )
    .bind(link)
    .first()
  return row ? toRow(row) : null
}

/** 目标的属主 id。不存在返回 null */
export async function readTargetOwnerId(db: Database, type: ShareTargetType, id: number): Promise<number | null> {
  const table = type === 'file' ? 'files' : 'folders'
  const row = await db.prepare(`SELECT user_id AS userId FROM ${table} WHERE id = ?`).bind(id).first()
  return row ? Number(row.userId) : null
}

/** token → ShareTarget。无效或目标已删都按 404（不区分，避免探测） */
export async function resolveLinkTarget(db: Database, link: string): Promise<ShareTarget> {
  const row = await findLinkRow(db, link)
  if (!row) {
    throw createError({ statusCode: 404, message: '分享链接无效' })
  }
  const ownerId = await readTargetOwnerId(db, row.targetType, row.targetId)
  if (ownerId === null) {
    // 链接行还在但目标没了。FK 是 ON DELETE CASCADE，理论上不会发生 ——
    // 但外键没开时（PRAGMA foreign_keys 是连接级的）会真发生，当失效链接处理。
    throw createError({ statusCode: 404, message: '分享链接无效' })
  }
  return {
    type: row.targetType,
    table: row.targetType === 'file' ? 'files' : 'folders',
    id: row.targetId,
    ownerId
  }
}

/** 目标上挂的全部链接 */
export async function listShareLinks(db: Database, target: ShareTarget): Promise<ShareLinkRow[]> {
  const res = await db
    .prepare(
      `SELECT id, link, target_type AS targetType, target_id AS targetId, created_at AS createdAt
       FROM share_links
       WHERE target_type = ? AND target_id = ?
       ORDER BY id ASC`
    )
    .bind(target.type, target.id)
    .all()
  return (res?.results || []).map(toRow)
}

/**
 * 建一个链接。一节点多链接是有意的：发链接 A 给甲、发 B 给乙，
 * 泄露时可以精确撤销 A 而不动 B —— 「按目标整体替换」做不到这一点。
 */
export async function createShareLink(db: Database, target: ShareTarget): Promise<ShareLinkRow> {
  // UNIQUE(link) 冲突的概率是 2^-128，撞了就重试而不是报错。
  // 上限 8 次：真撞满说明不是随机数的问题，再试只是空转。
  for (let attempt = 0; attempt < 8; attempt++) {
    const link = crypto.randomBytes(SHARE_LINK_TOKEN_BYTES).toString('hex')
    try {
      const res = await db
        .prepare(
          `INSERT INTO share_links (link, target_type, target_id)
           VALUES (?, ?, ?)
           RETURNING id, link, target_type AS targetType, target_id AS targetId, created_at AS createdAt`
        )
        .bind(link, target.type, target.id)
        .first()
      if (res) return toRow(res)
    } catch (e: any) {
      if (attempt === 7) throw e
    }
  }
  throw createError({ statusCode: 500, message: '生成分享链接失败，请重试' })
}

/**
 * 按 token 撤销。
 *
 * **必须反查目标再验属主**：这个接口只收一个 token，不校验的话任何登录用户
 * 都能删掉别人的链接（纯破坏）。口径与 /api/share/mode 一致：属主只能是自己；
 * 管理员代管时 authUserId 已经是 targetUserId，同一套判定自动放行。
 */
export async function deleteShareLink(db: Database, link: string, actingUserId: number): Promise<void> {
  const row = await findLinkRow(db, link)
  if (!row) {
    // 已删 / 从没存在过 都归这里。返回「成功」而不是 404：撤销天然幂等，
    // 前端重试不该报错，也免得用 token 探测存在性。
    return
  }
  try {
    await resolveShareTarget(db, row.targetType, row.targetId, actingUserId)
  } catch (e: any) {
    // 404 = 目标行已经没了。resolveShareTarget 的权限失败是 403，不会走到这。
    // FK 是 ON DELETE CASCADE，理论上不该出现；外键没开时会，那就顺手清掉这条孤儿行。
    if (e?.statusCode !== 404) throw e
  }
  await db.prepare('DELETE FROM share_links WHERE link = ?').bind(link).run()
}

/** 分享链接页面的地址。前端路由和这里共用同一个常量，别各写一份字符串 */
export function buildShareLinkUrl(event: any, link: string): string {
  return `${getRequestURL(event).origin}${SHARE_LINK_PAGE_PREFIX}${link}`
}

/**
 * 给链接行补上完整地址。
 *
 * 三个返回 links 的接口（/api/share/list、/api/share/mode、/api/share/link/add）
 * **必须走这一个映射**。add 原来直接返回 listShareLinks 的裸行、没有 url，
 * 而另两个有 —— 前端 add 之后用返回值覆盖本地列表，链接就没地址可复制，
 * 重开弹窗才恢复。跟当年 grants 的「未知用户」是同一类 bug：返回结构不一致，
 * 后写的那个接口把前一个的字段抹掉。
 */
export function withShareLinkUrls(event: any, rows: ShareLinkRow[]) {
  return rows.map((l) => ({ ...l, url: buildShareLinkUrl(event, l.link) }))
}

/**
 * 判定用的 CTE：取回「节点自己 → 第一个非继承祖先（含自己）」这一段的全部行，
 * 并标出落点自己有没有这条 token。
 *
 * 种子行有两条（files / folders），**两条都要按 kind 过滤**：
 * files.id 和 folders.id 是两套独立序列，同一个数字两边都存在很正常。
 * 只过滤其中一条的话，另一种节点的行照样混进来，而种子都在 depth 0 ——
 * `MIN(depth)` 和 `depth = b.d` 会同时命中两行，取哪一行取决于返回顺序，不可复现。
 * （这个 bug 真出现过：查目录 10 时撞上同号文件 10，判定结果随机翻转。）
 *
 * 递归步只产出 folder 行：父指针两边语义相同（文件的 folder_id、目录的 parent_id）。
 *
 * `boundary.d` 为 NULL 表示整条链全是继承、没人拍板 → `depth = d` 永不成立
 * → 0 行 → 拒绝。这就是「根目录是阻止」：根目录自己继承时，上面什么都没有。
 *
 * 参数顺序：(?id, ?kind, ?id, ?kind, ?link)
 */
const BOUNDARY_CTE = `
  WITH RECURSIVE up(kind, id, parent_id, shared, depth) AS (
    SELECT 'file', id, folder_id, Shared, 0 FROM files WHERE id = ? AND ? = 'file'
    UNION ALL
    SELECT 'folder', id, parent_id, Shared, 0 FROM folders WHERE id = ? AND ? = 'folder'
    UNION ALL
    SELECT 'folder', f.id, f.parent_id, f.Shared, up.depth + 1
    FROM up JOIN folders f ON f.id = up.parent_id
  ),
  boundary AS (SELECT MIN(depth) AS d FROM up WHERE shared IN (0, 1))
  SELECT u.kind AS kind, u.shared AS shared,
    EXISTS (
      SELECT 1 FROM share_links sl
      WHERE sl.link = ? AND sl.target_type = u.kind AND sl.target_id = u.id
    ) AS hasLink
  FROM up u, boundary b
  WHERE u.depth = b.d
`

/**
 * 落点那行是不是「分享 + 挂着这条 token」。
 *
 * 只有这一种算放行。「不分享」落在这里和「走到了墙」在结果上都是拒绝，
 * 但原因不同，日志里要能分开 —— 所以保留 shared 让调用方自己判。
 */
function isAllowRow(row: any): boolean {
  return !!row && Number(row.shared) !== 0 && Number(row.hasLink) === 1
}

/** token 能不能访问这个文件 */
export async function linkGrantsFile(db: Database, link: string, fileId: number): Promise<boolean> {
  const rows = await db
    .prepare(BOUNDARY_CTE)
    .bind(fileId, 'file', fileId, 'file', link)
    .all()
    .catch(() => ({ results: [] }))
  return isAllowRow((rows?.results || [])[0])
}

/** token 能不能访问这个文件夹 */
export async function linkGrantsFolder(db: Database, link: string, folderId: number): Promise<boolean> {
  const rows = await db
    .prepare(BOUNDARY_CTE)
    .bind(folderId, 'folder', folderId, 'folder', link)
    .all()
    .catch(() => ({ results: [] }))
  return isAllowRow((rows?.results || [])[0])
}

/**
 * token + fileKey → 该文件。
 *
 * 两道校验：文件必须属于链接目标的属主（子树里父子同属主，schema 触发器保证），
 * 且 token 必须真能覆盖它（linkGrantsFile 走上行边界判定）。
 * 任一不满足都按 404 —— 不区分「链接无效」和「这个文件不在链接范围内」，
 * 免得拿链接探测目录结构。
 */
export async function findFileByLink(
  db: Database,
  files: FileService,
  link: string,
  fileKey: string
): Promise<OwnedFile> {
  const target = await resolveLinkTarget(db, link)
  const file = await files.findOwnedByKey(target.ownerId, fileKey)
  if (!file || !(await linkGrantsFile(db, link, file.id))) {
    throw createError({ statusCode: 404, message: '分享链接无效或无权访问该文件' })
  }
  return file
}

/**
 * 链接视角下列目录。
 *
 * 只给**继承态**的子项：任何非继承的子节点都是它自己那道边界，链接到不了它 ——
 * 除非那条链接就挂在它身上，那是另一个 token 的事。
 *
 * 取数直接复用 FolderService / FileService 的既有方法（它们按属主 id 过滤，
 * 子树里的行天然同属主），在内存里按 Shared 过滤。不重写一遍 SELECT *：
 * 那会把 toOwnedFolder / toOwnedFile 的列名映射也复制一份，两边迟早漂移。
 */
export async function listChildrenByLink(
  folders: FolderService,
  files: FileService,
  ownerId: number,
  parentId: number
): Promise<{ folders: any[]; files: OwnedFile[] }> {
  const childFolders = (await folders.listChildren(ownerId, parentId)).filter(
    (f) => f.Shared === SHARE_INHERIT
  )
  const childFiles = (await files.listFolderContents(parentId, ownerId)).filter(
    (f) => f.Shared === SHARE_INHERIT
  )
  return { folders: childFolders, files: childFiles }
}

/**
 * 链接视角下的整棵子树（整包下载的清单）。
 *
 * 一次 CTE 走完，携带 ok 标志：起点（挂链接的那个目录）是 1；每向下一层，
 * 若该层是非继承（新边界）或上游已经断了，就清零。于是 ok=1 的部分恰好是
 * 「链接能覆盖的子树」。文件自己非继承也是边界，`Shared = 继承` 一起带上。
 *
 * 形状与 FolderService.listSubtreeManifest 一致（**同一个 ManifestFile 契约**，
 * 连那三个权限过滤要用的列也带上），只是多了 ok 过滤和 skipped 计数。
 */
export async function listSubtreeByLink(
  db: Database,
  ownerId: number,
  rootId: number
): Promise<{ files: ManifestFile[]; skipped: number }> {
  const inScope = await db
    .prepare(
      `WITH RECURSIVE tree(id, name, rel_dir, ok) AS (
         SELECT id, name, '' AS rel_dir, 1 FROM folders WHERE id = ? AND user_id = ?
         UNION ALL
         SELECT f.id, f.name,
                CASE WHEN tree.rel_dir = '' THEN f.name ELSE tree.rel_dir || '/' || f.name END,
                CASE WHEN tree.ok = 0 OR f.Shared IN (0, 1) THEN 0 ELSE 1 END
         FROM folders f JOIN tree ON f.parent_id = tree.id
         WHERE f.user_id = ?
       )
       SELECT tree.rel_dir AS relDir, fl.id AS id, fl.filename AS filename,
              fl.file_key AS fileKey, fl.file_size AS fileSize,
              fl.folder_id AS folderId, fl.Shared AS Shared, fl.IsPublic AS IsPublic
       FROM tree JOIN files fl ON fl.folder_id = tree.id
       WHERE fl.user_id = ? AND tree.ok = 1 AND fl.Shared = ?
       ORDER BY relDir, filename`
    )
    .bind(rootId, ownerId, ownerId, ownerId, SHARE_INHERIT)
    .all()
  const files = (inScope?.results || []) as ManifestFile[]

  // 范围外的数量：整棵子树的文件总数 − 范围内的。
  // 「整棵子树」这里不按 ok 也不按 fl.Shared 过滤 —— skipped 是给人看的粗略提示，
  // 不需要精确到「哪几个因为是边界被排除」，再跑一遍 CTE 去精确数不划算。
  const total = await db
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM folders WHERE id = ? AND user_id = ?
         UNION ALL
         SELECT f.id FROM folders f JOIN tree ON f.parent_id = tree.id WHERE f.user_id = ?
       )
       SELECT COUNT(*) AS total FROM files fl
       JOIN tree ON fl.folder_id = tree.id WHERE fl.user_id = ?`
    )
    .bind(rootId, ownerId, ownerId, ownerId)
    .first()

  return { files, skipped: Math.max(0, Number(total?.total ?? files.length) - files.length) }
}

/**
 * 链接给的权限掩码，以及它对应的「来源」标记。
 *
 * 链接没有 userId，所以回答不了「我为什么能看到这个」——只能答「你拿着链接」。
 * 集中在一处，别在 handler 里硬写 9 或字符串 'link'。
 */
export const LINK_ACCESS = { perm: LINK_PERMISSION, permSource: 'link' as const }

/**
 * token 存在但当前覆盖不到目标时的提示。
 *
 * 与「token 不存在」分开：后者由 resolveLinkTarget 直接 404「分享链接无效」，
 * 而前者几乎总是**属主自己设置的问题** —— 在继承目录上发了链接，但上游没有
 * 「分享」节点拍板，或者被一道「不分享」的墙挡住了（链接是预设，没人拍板不生效）。
 * 说清楚这点，属主才知道去改哪里；笼统报「无效」会让人以为是链接坏了。
 */
export const LINK_NOT_ACTIVE_MESSAGE =
  '分享链接当前无效：链接所在的目录上方没有「分享」节点，或被「不分享」挡住了（继承态下链接只是预设，需要上游有人拍板才生效）'
