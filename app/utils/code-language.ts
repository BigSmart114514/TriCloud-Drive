// 代码预览器用哪套语法：扩展名 → CodeMirror 语言包。
//
// ## 为什么不放在组件里
//
// 「a.tsx 用哪套语法」是一个纯判断，留在 SFC 里就只能 grep 源码。放到这里之后
// 测试可以直接 import 执行，断言具体 id；组件只负责把结果转给编辑器。
//
// ## 语言包是动态 import 的
//
// 九个语言包加起来比编辑器核心还大，而一次预览只会用到其中一个。静态 import
// 会把它们全塞进首个 chunk —— 打开首页就先下载一遍 Python 和 SQL 的语法。
// 这里的 switch 让打包器为每个语言单独切一块，只有真的预览到才加载。
//
// ## 认不出来就 plaintext，不猜
//
// 猜错的语法比没有高亮更糟：把 .toml 当 Python 解析，屏幕上会出现一片红。
// 扩展名表之外的一律 plaintext，用户仍然能编辑，只是没有着色。
import type { Extension } from '@codemirror/state'
import { extensionOf } from '~/utils/previewer'

export type CodeLanguageId =
  | 'javascript'
  | 'json'
  | 'html'
  | 'css'
  | 'markdown'
  | 'python'
  | 'xml'
  | 'sql'
  | 'yaml'
  | 'plaintext'

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

  py: 'python',

  xml: 'xml',
  svg: 'xml',
  plist: 'xml',

  sql: 'sql',

  yml: 'yaml',
  yaml: 'yaml'
}

/** 认不出来的（含无扩展名、`a.`）落到 plaintext。 */
export function languageForFilename(filename: string): CodeLanguageId {
  return LANGUAGE_BY_EXTENSION[extensionOf(filename)] ?? 'plaintext'
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
    case 'python': {
      const { python } = await import('@codemirror/lang-python')
      return python()
    }
    case 'xml': {
      const { xml } = await import('@codemirror/lang-xml')
      return xml()
    }
    case 'sql': {
      const { sql } = await import('@codemirror/lang-sql')
      return sql()
    }
    case 'yaml': {
      const { yaml } = await import('@codemirror/lang-yaml')
      return yaml()
    }
    case 'plaintext':
    default:
      return []
  }
}
