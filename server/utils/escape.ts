/**
 * 字符串转义工具。
 *
 * 独立成模块的原因：这两个函数原先住在 `server/utils/file.ts`，但它们是纯字符串
 * 函数、跟文件表毫无关系。`search.ts` 为了拿 `escapeLike` 得从 file.ts 里 import，
 * 而 file.ts 又 import 了 db.ts —— 于是 db.ts 一旦想用就得绕开 file.ts（见
 * `search.ts` 顶部注释里记的那条依赖约束）。挪出来后依赖是单向的。
 */

/**
 * 转义 LIKE 模式里的三个特殊字符：`%`、`_` 和转义符本身 `\`。
 *
 * **必须和 SQL 里的 `ESCAPE '\'` 配对**。sqlite 默认没有转义字符，单独转义而
 * 不声明 ESCAPE 的话，反斜杠会被当成普通字符去匹配 —— 比不转义更糟。
 */
export function escapeLike(input: string): string {
  return input.replace(/([%_\\])/g, '\\$1')
}

/**
 * 转义正则元字符，用于把用户输入安全地拼进 `new RegExp(...)`。
 */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
