/**
 * 重名消解：把 `报告.txt` 变成 `报告 (2).txt`、`报告 (3).txt`…
 *
 * ## 为什么单独立一个模块
 *
 * 这套算法在本项目里存在过**三份**实现，且已经开始分叉：
 *
 *   server/utils/file.ts       `${base} (${nextN})${ext}`
 *   server/utils/folders.ts    `${base} (${nextN})`
 *   server/api/files/save.post.ts  buildName(): n <= 1 ? 无括号 : 有括号
 *
 * 三份的「找最大 n」「怎么判冲突」「怎么转义」全都一样，只有扩展名处理不同。
 * 分叉的后果是具体的：save.post.ts 的 buildName 在 n===1 时不加括号，另两处
 * 无条件加。目前恰好不出问题（resolveUnique* 只在 nextN >= 2 时才拼名），
 * 但那是巧合，不是设计 —— 任何一处改动都可能让同一个文件在同一份代码里
 * 得到两种命名。
 *
 * 现在只有这一份。
 */
import { escapeLike, escapeRegExp } from '~~/server/utils/escape'

/**
 * 拼出第 n 个候选名。
 *
 * n === 1 时**不加括号**：那不是「第 1 个副本」，而是原名本身。
 */
export function dedupeName(base: string, ext: string, n: number): string {
  return n <= 1 ? `${base}${ext}` : `${base} (${n})${ext}`
}

/**
 * 表与列的对应关系。列名是内部常量，不来自用户输入，拼进 SQL 没有注入面。
 */
export interface NameSpec {
  table: 'files' | 'folders'
  /** 存名字的那一列 */
  nameColumn: 'filename' | 'name'
  /** 父级列。files 是 folder_id，folders 是 parent_id */
  parentColumn: 'folder_id' | 'parent_id'
  /** 结果集里取名字用的键 */
  rowKey: 'filename' | 'name'
}

export const FILE_NAMES: NameSpec = {
  table: 'files',
  nameColumn: 'filename',
  parentColumn: 'folder_id',
  rowKey: 'filename'
}

export const FOLDER_NAMES: NameSpec = {
  table: 'folders',
  nameColumn: 'name',
  parentColumn: 'parent_id',
  rowKey: 'name'
}

/**
 * 在 (userId, parentId) 这一格里，给 desired 找一个不冲突的名字。
 *
 * ## 为什么不拆扩展名由调用方决定
 *
 * 文件要拆（`a.txt` 的副本是 `a (2).txt`），目录不能拆 —— 目录名里带点是
 * 常态（`v1.2 备份`），按点拆会得到 `v1 (2).2 备份` 这种鬼东西。
 * 所以 `splitExt` 是显式参数，而不是「目录自动不拆」那种隐式约定。
 */
export async function resolveUniqueName(
  db: any,
  spec: NameSpec,
  userId: number,
  parentId: number | null,
  desired: string,
  splitExt: boolean
): Promise<{ name: string; base: string; ext: string; nextN: number }> {
  let base = desired
  let ext = ''
  if (splitExt) {
    const i = desired.lastIndexOf('.')
    // i <= 0：`.gitignore`（点在开头）与 `README`（无点）都不拆
    if (i > 0) {
      base = desired.slice(0, i)
      ext = desired.slice(i)
    }
  }

  // 精确匹配 + 「base (n)ext」形状的通配，一次查完。转义与 ESCAPE 配对，
  // 否则名字里本来就有 % 或 _ 时会把不相关的行也算进来。
  const likePattern = `${escapeLike(base)} (%)${escapeLike(ext)}`
  const sql =
    parentId === null
      ? `SELECT ${spec.nameColumn} AS n FROM ${spec.table}
         WHERE user_id = ? AND ${spec.parentColumn} IS NULL
           AND (${spec.nameColumn} = ? OR ${spec.nameColumn} LIKE ? ESCAPE '\\')`
      : `SELECT ${spec.nameColumn} AS n FROM ${spec.table}
         WHERE user_id = ? AND ${spec.parentColumn} = ?
           AND (${spec.nameColumn} = ? OR ${spec.nameColumn} LIKE ? ESCAPE '\\')`
  const args = parentId === null
    ? [userId, desired, likePattern]
    : [userId, parentId, desired, likePattern]

  const rows = await db.prepare(sql).bind(...args).all()
  const existing = new Set<string>((rows?.results || []).map((r: any) => String(r.n)))

  if (!existing.has(desired)) {
    return { name: desired, base, ext, nextN: 1 }
  }

  // 在已有的 (n) 里找最大值。没有任何一个 (n) 时从 2 开始（原名已占着 1）
  const re = new RegExp(`^${escapeRegExp(base)} \\((\\d+)\\)${escapeRegExp(ext)}$`)
  let maxN = 1
  for (const name of existing) {
    const m = name.match(re)
    if (m) {
      // 匹配成功时 m[1] 必然是那对捕获括号抓到的数字串，但 tsc 在
      // noUncheckedIndexedAccess 下只看到 string | undefined，所以给个非空断言。
      const n = parseInt(m[1]!, 10)
      if (Number.isFinite(n) && n > maxN) maxN = n
    }
  }
  const nextN = maxN + 1
  return { name: dedupeName(base, ext, nextN), base, ext, nextN }
}
