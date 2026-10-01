// 「命中行 × 祖先行」这种平铺结果的折叠工具。
//
// 抽出来是因为有两处要做同一件事，而它们对**SQL 的形状有硬要求**，
// 抄一份就等于把要求也抄一份、改一处忘一处：
//
//   server/utils/search.ts        —— 按名称搜索（LIKE 命中）
//   server/utils/share-settings.ts —— 分享管理列表（非默认设置命中）
//
// 两者都用同一个三段式 CTE：
//
//   hits —— 命中行，带条件与 LIMIT
//   up   —— 从命中行沿父指针向上走到根
//   外层 —— LEFT JOIN 回 hits，按 (hitId, depth DESC) 平铺输出
//
// 于是每一行带着「我 + 我的每一级祖先」，一次查询同时得到展示用的路径文本
// 和前端重建面包屑用的 id 链。
//
// ## 为什么折叠依赖 SQL 的排序
//
// 外层必须 `ORDER BY hitId, depth DESC`：同一个 hitId 下行的到达顺序就是
// 「根 → 目标」，直接 push 进数组就是对的。少了这个 ORDER BY，返回顺序由
// SQLite 自己决定，路径会随机变成「目标 → 根」。

/** 面包屑的一级。path 是「从根到目标」的完整链路，供前端重建导航 */
export interface FolderPathNode {
  id: number
  name: string
}

/** 折叠只用到这三列，其余列（命中自己的字段）由调用方自己读 */
export interface HitPathRow {
  hitId: number | string
  pathId: number | string | null
  pathName: string | null
}

/** 目录命中的展示路径：父路径，**不含它自己** */
export function folderRelDir(path: FolderPathNode[]): string {
  return path.slice(0, -1).map((n) => n.name).join('/')
}

/** 文件命中的展示路径：整条链。文件不是容器，path 本身到所在目录为止 */
export function fileRelDir(path: FolderPathNode[]): string {
  return path.map((n) => n.name).join('/')
}

/**
 * 把「命中行 × 祖先行」折叠成「一次命中 = 一条结果」。
 *
 * 顺带做三件事，调用方不必各写一遍：
 *   1. 按首次出现顺序去重（同一 hitId 的多行只出一条，取第一条 —— 那是命中行自己）
 *   2. 截断到 limit
 *   3. 报 truncated：SQL 里取的是 limit + 1，多出来那条就是「还有更多」的信号
 *
 * `rows` 声明成 `Record<string, any>`：不同调用的命中列差别很大（目录有 name、
 * 文件有 filename/fileKey），与其在这里定义一个谁都不全的公共行类型，
 * 不如让调用方在自己的 build 回调里按需断言 —— 类型收窄留在有字段信息的那一侧。
 */
export function collectHits<T>(
  rows: Array<Record<string, any>>,
  limit: number,
  build: (row: any, path: FolderPathNode[]) => T
): { hits: T[]; truncated: boolean } {
  const paths = new Map<number, FolderPathNode[]>()
  for (const row of rows) {
    if (row.pathId === null || row.pathId === undefined) continue
    const hitId = Number(row.hitId)
    const list = paths.get(hitId) ?? []
    list.push({ id: Number(row.pathId), name: String(row.pathName) })
    paths.set(hitId, list)
  }

  const seen = new Set<number>()
  const ordered: T[] = []
  for (const row of rows) {
    const hitId = Number(row.hitId)
    if (seen.has(hitId)) continue
    seen.add(hitId)
    ordered.push(build(row, paths.get(hitId) ?? []))
  }

  return { hits: ordered.slice(0, limit), truncated: ordered.length > limit }
}
