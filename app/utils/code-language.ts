// 代码预览器用哪套语法：扩展名或用户选择 → CodeMirror 语言包。
//
// ## 为什么不放在组件里
//
// 「a.tsx 用哪套语法」是一个纯判断，留在 SFC 里就只能 grep 源码。放到这里之后
// 测试可以直接 import 执行，断言具体 id；组件只负责把结果转给编辑器。
//
// ## 语言包是动态 import 的
//
// 每个语言包都单独切块。静态 import 会把它们全塞进首个 chunk —— 打开首页就
// 先下载一遍 Python 和 SQL 的语法。这里的 switch 让打包器为每个语言单独切一块，
// 只有真的预览到才加载。
//
// ## 认不出来就 plaintext，但用户能手动选
//
// 猜错的语法比没有高亮更糟：把 .toml 当 Python 解析，屏幕上会出现一片红。
// 扩展名表之外的一律 plaintext，用户仍然可以编辑；真的想高亮，可以在预览器
// 顶栏的语言下拉里直接指定 —— 没有扩展名、`.txt` 里放代码，都靠这个出口。
import type { Extension } from '@codemirror/state'
import { extensionOf } from '~/utils/previewer'

export type CodeLanguageId =
  | 'javascript'
  | 'json'
  | 'html'
  | 'css'
  | 'markdown'
  | 'vue'
  | 'python'
  | 'java'
  | 'go'
  | 'rust'
  | 'cpp'
  | 'php'
  | 'shell'
  | 'sql'
  | 'yaml'
  | 'toml'
  | 'xml'
  | 'plaintext'

export interface CodeLanguage {
  id: CodeLanguageId
  label: string
}

/**
 * 语言下拉的顺序：先 Web/脚本，再系统语言，最后结构化文本与兜底。
 *
 * 这张表同时是「合法 id」的唯一来源，`isCodeLanguageId` 与下拉都从这里取，
 * 不再维护第三份清单。
 */
export const CODE_LANGUAGES: readonly CodeLanguage[] = [
  { id: 'javascript', label: 'JavaScript / TS' },
  { id: 'json', label: 'JSON' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'vue', label: 'Vue' },
  { id: 'python', label: 'Python' },
  { id: 'java', label: 'Java' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'cpp', label: 'C / C++' },
  { id: 'php', label: 'PHP' },
  { id: 'shell', label: 'Shell' },
  { id: 'sql', label: 'SQL' },
  { id: 'yaml', label: 'YAML' },
  { id: 'toml', label: 'TOML' },
  { id: 'xml', label: 'XML / SVG' },
  { id: 'plaintext', label: '纯文本' }
] as const

/**
 * 一张表，不按「先判断是不是 JS 再判断是不是 TS」分叉。
 *
 * TS / JSX / TSX 共用 @codemirror/lang-javascript：它的 TypeScript 方言是 JS 的
 * 超集，`.js` 用同一套解析不会出错，反而省掉四份几乎相同的分支。
 */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, CodeLanguageId>> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'javascript',
  tsx: 'javascript',
  mts: 'javascript',
  cts: 'javascript',

  json: 'json',
  jsonc: 'json',

  html: 'html',
  htm: 'html',
  xhtml: 'html',

  css: 'css',

  md: 'markdown',
  markdown: 'markdown',

  vue: 'vue',

  py: 'python',

  java: 'java',

  go: 'go',

  rs: 'rust',

  c: 'cpp',
  h: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',

  php: 'php',

  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',

  sql: 'sql',

  yml: 'yaml',
  yaml: 'yaml',

  toml: 'toml',

  xml: 'xml',
  svg: 'xml',
  plist: 'xml'
}

/** 认不出来的（含无扩展名、`a.`）落到 plaintext。 */
export function languageForFilename(filename: string): CodeLanguageId {
  return LANGUAGE_BY_EXTENSION[extensionOf(filename)] ?? 'plaintext'
}

export function isCodeLanguageId(value: unknown): value is CodeLanguageId {
  return typeof value === 'string' && CODE_LANGUAGES.some((l) => l.id === value)
}

/** 下拉里的「自动」是第四种选择，不是语言包。 */
export type CodeLanguageChoice = 'auto' | CodeLanguageId

export function resolveCodeLanguage(filename: string, choice: CodeLanguageChoice): CodeLanguageId {
  return choice === 'auto' ? languageForFilename(filename) : choice
}

/** 下拉与提示用的人话名字。 */
export function languageLabel(id: CodeLanguageId): string {
  return CODE_LANGUAGES.find((l) => l.id === id)?.label ?? '纯文本'
}

/**
 * 只加载当前语言。
 *
 * `plaintext` 返回空表而不是 `[]` 以外的占位扩展：CodeMirror 接受空的扩展数组，
 * 不需要一个什么都不做的 LanguageSupport 对象。
 */
export async function loadLanguageExtension(id: CodeLanguageId): Promise<Extension> {
  switch (id) {
    case 'javascript': {
      const { javascript } = await import('@codemirror/lang-javascript')
      // typescript + jsx 同时打开：TS 方言覆盖 .js，JSX 覆盖 .jsx/.tsx。
      return javascript({ typescript: true, jsx: true })
    }
    case 'json': {
      const { json } = await import('@codemirror/lang-json')
      return json()
    }
    case 'html': {
      const { html } = await import('@codemirror/lang-html')
      return html()
    }
    case 'css': {
      const { css } = await import('@codemirror/lang-css')
      return css()
    }
    case 'markdown': {
      const { markdown } = await import('@codemirror/lang-markdown')
      return markdown()
    }
    case 'vue': {
      const { vue } = await import('@codemirror/lang-vue')
      return vue()
    }
    case 'python': {
      const { python } = await import('@codemirror/lang-python')
      return python()
    }
    case 'java': {
      const { java } = await import('@codemirror/lang-java')
      return java()
    }
    case 'go': {
      const { go } = await import('@codemirror/lang-go')
      return go()
    }
    case 'rust': {
      const { rust } = await import('@codemirror/lang-rust')
      return rust()
    }
    case 'cpp': {
      const { cpp } = await import('@codemirror/lang-cpp')
      return cpp()
    }
    case 'php': {
      const { php } = await import('@codemirror/lang-php')
      return php()
    }
    case 'shell': {
      const { StreamLanguage } = await import('@codemirror/language')
      const { shell } = await import('@codemirror/legacy-modes/mode/shell')
      return StreamLanguage.define(shell)
    }
    case 'sql': {
      const { sql } = await import('@codemirror/lang-sql')
      return sql()
    }
    case 'yaml': {
      const { yaml } = await import('@codemirror/lang-yaml')
      return yaml()
    }
    case 'toml': {
      const { StreamLanguage } = await import('@codemirror/language')
      const { toml } = await import('@codemirror/legacy-modes/mode/toml')
      return StreamLanguage.define(toml)
    }
    case 'xml': {
      const { xml } = await import('@codemirror/lang-xml')
      return xml()
    }
    case 'plaintext':
    default:
      return []
  }
}
