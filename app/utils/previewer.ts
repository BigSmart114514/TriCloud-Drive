// 预览器注册表与「这个文件默认用哪个预览器」的判定。
//
// ## 为什么这些逻辑不在组件里
//
// 项目没有组件挂载环境（没有 @vue/test-utils / happy-dom / Playwright），
// 判断留在 FilePreviewer.vue 里就只能靠 grep 源码来「测」，那断的是名字出现过，
// 不是算出来什么。放到这里之后，扩展名到预览器的映射、用户选择与默认值的优先级
// 都能直接 import 执行，断言具体返回值。
//
// 组件里只剩渲染：下拉遍历 PREVIEWERS，当前值由 resolvePreviewer 给出。
//
// ## 一个刻意的取舍：不按类型过滤下拉
//
// 下拉永远列出全部预览器，哪怕当前文件明显用不上。理由是「扩展名认不出来」和
// 「这个文件真的不是那种东西」看起来一样：一个没有扩展名的文件可能是 PDF，
// 也可能什么都不是。把选择权交出去，比替用户断定「暂不支持」要好。

export type PreviewerId = 'image' | 'pdf' | 'text' | 'code' | 'zip' | '7z' | 'none'

export interface Previewer {
  id: PreviewerId
  label: string
}

/**
 * 顺序即下拉里的顺序。
 *
 * 空的兜底项放最后：它是「别加载了」，不是一种内容呈现方式。
 *
 * ZIP 与 7z 是两个条目，不是隐藏在同一项后面的运行时二选一：两台引擎能力不同
 * （7z 能读 zip，zip.js 只读 zip），合并之后遇到改名或无扩展名的文件，用户
 * 既看不出正在用哪台，也没法换另一台重试。
 */
export const PREVIEWERS: readonly Previewer[] = [
  { id: 'image', label: '图片预览' },
  { id: 'pdf', label: 'PDF 预览' },
  { id: 'text', label: '文本预览' },
  { id: 'code', label: '代码预览' },
  { id: 'zip', label: 'ZIP 预览' },
  { id: '7z', label: '7z 预览' },
  { id: 'none', label: '不预览内容' }
] as const

export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'
])

/**
 * 文本与 Markdown 都归 text。
 *
 * 原来组件里 isText 与 isMd 是两套，再拼成 isTextLike —— 三处必须同时记得改。
 * 这里只有一张表。
 */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt', 'log', 'csv', 'json', 'xml', 'yml', 'yaml', 'ini', 'env', 'md', 'markdown'
])

/**
 * 压缩包。冷门格式是逐字从原组件搬过来的 —— 收窄会让某些格式静默失去默认预览，
 * 而表现只是「点开说暂不支持」，很难被联想到是这里少了一项。
 */
export const ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  'zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'tbz2', 'xz', 'txz',
  'zst', 'lz', 'lzma', 'cab', 'iso', 'arj', 'cpio', 'rpm', 'deb', 'dmg', 'msi', 'xar', 'z'
])

/** 最后一段扩展名，小写。没有扩展名（含 `a.` 这种）返回空串。 */
export function extensionOf(filename: string): string {
  const name = String(filename ?? '').toLowerCase()
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index + 1) : ''
}

/**
 * 按扩展名给出默认预览器。认不出来返回 null —— 调用方据此提示用户选择，
 * 而不是编一个默认值把一个二进制文件当文本打开。
 *
 * `.zip` 单独先判：它默认交给 zip.js，其余的压缩包交给 7z-wasm。这只是默认值，
 * 用户在下拉里仍然可以把 `.zip` 交给 7z、把 `.7z` 交给 zip.js 重试。
 */
export function previewerFor(filename: string): PreviewerId | null {
  const ext = extensionOf(filename)
  if (!ext) return null
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (ext === 'zip') return 'zip'
  if (ARCHIVE_EXTENSIONS.has(ext)) return '7z'
  return null
}

/**
 * 用户选择优先，没选才用默认。
 *
 * 选择只在当前文件有效，所以这里不收「按扩展名记住」的东西 —— 记住会让默认值
 * 失效：上一个文件被强行指定成图片之后，下一个 .md 也还是图片。
 */
export function resolvePreviewer(filename: string, chosen: PreviewerId | null | undefined): PreviewerId | null {
  return chosen ?? previewerFor(filename)
}

/** 挡住来自 DOM 的任意字符串（<select> 的值永远是 string）。 */
export function isPreviewerId(value: unknown): value is PreviewerId {
  return typeof value === 'string' && PREVIEWERS.some((p) => p.id === value)
}
