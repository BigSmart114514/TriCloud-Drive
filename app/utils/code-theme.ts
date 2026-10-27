// 代码预览器的主题：三档选择、系统深色解析、以及 localStorage 记忆。
//
// ## 为什么 auto 要单独存在
//
// 「浅色 / 深色」是用户对编辑器明暗的偏好；「跟随系统」是让偏好去跟操作系统。
// 只存一个布尔值会在系统主题变化时失灵 —— 用户晚上切换系统深色，已经打开的
// 预览器不会跟着变。这里存的是选择，解析放在渲染时做。
//
// ## storage 全部 try/catch
//
// Safari 隐私模式、被禁用的第三方存储、写满配额都会让 getItem/setItem 直接抛。
// 一个记不住的配色偏好不该把整个预览器带崩：读失败回默认，写失败静默放弃。
//
// ## 主题也是动态 import
//
// 两套 VS Code 主题（Light+ / Dark+）各自带一份高亮规则，只有真的打开代码
// 预览器才需要。和语言包同样按需加载，不背进首屏。
import type { Extension } from '@codemirror/state'

export type CodeThemeId = 'auto' | 'light' | 'dark'
export type ResolvedCodeTheme = 'light' | 'dark'

export interface CodeTheme {
  id: CodeThemeId
  label: string
}

/** 顺序即下拉里的顺序。默认放第一项，与 TEXT_ENCODINGS 的口径一致。 */
export const CODE_THEMES: readonly CodeTheme[] = [
  { id: 'auto', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' }
] as const

export const DEFAULT_CODE_THEME: CodeThemeId = 'auto'
export const CODE_THEME_STORAGE_KEY = 'tricloud.code-theme'

export function isCodeTheme(value: unknown): value is CodeThemeId {
  return typeof value === 'string' && CODE_THEMES.some((t) => t.id === value)
}

/** auto 看系统；显式选择永远压过系统。 */
export function resolveCodeTheme(choice: CodeThemeId, prefersDark: boolean): ResolvedCodeTheme {
  if (choice === 'auto') return prefersDark ? 'dark' : 'light'
  return choice
}

type StorageReader = Pick<Storage, 'getItem'> | null | undefined
type StorageWriter = Pick<Storage, 'setItem'> | null | undefined

export function readCodeTheme(storage: StorageReader): CodeThemeId {
  try {
    const value = storage?.getItem(CODE_THEME_STORAGE_KEY)
    return isCodeTheme(value) ? value : DEFAULT_CODE_THEME
  } catch {
    return DEFAULT_CODE_THEME
  }
}

export function writeCodeTheme(storage: StorageWriter, choice: CodeThemeId): void {
  if (!isCodeTheme(choice)) return
  try {
    storage?.setItem(CODE_THEME_STORAGE_KEY, choice)
  } catch {
    // 记不住就算了，本次预览仍然按用户选的渲染。
  }
}

export async function loadCodeThemeExtension(theme: ResolvedCodeTheme): Promise<Extension> {
  const { vscodeDark, vscodeLight } = await import('@uiw/codemirror-theme-vscode')
  return theme === 'dark' ? vscodeDark : vscodeLight
}
