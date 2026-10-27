// 代码预览（CodeMirror 6）。
//
// ## 为什么先钉「语言」和「主题」两个纯模块
//
// 项目没有 SFC 挂载环境，编辑器本身只能到真浏览器里才跑得起来。但「.ts 用哪套
// 语法」「auto 在深色系统下解析成 dark」这两件事是纯判断，留在组件里就只能 grep
// 源码 —— 断的是名字出现过，不是算出来什么。拆出来后直接 import 执行。
//
// ## 「默认预览器不变」是刻意的
//
// 新增 code 只增加一个可选项，没有把 .js / .ts 的默认预览器从 null 改成 code。
// 用户没要求改默认值，这里就用一条断言把它钉住 —— 否则以后谁顺手加一行
// `if (CODE_EXTENSIONS.has(ext)) return 'code'`，现有文件的打开行为会静默变化。
//
// ## 编辑器只有一个实例，挂载与同步都靠源码形状
//
// CodeTextEditor 需要 DOM，node 里起不来。这里钉的是几条会直接决定「能不能用」
// 的接线：CM6 必须是 onMounted 里的动态 import（否则首个 SFC chunk 就把编辑器
// 背进首页）、外部改 modelValue 要能替换文档且不回环 emit、只读要同时关掉
// EditorState.readOnly 与 EditorView.editable、卸载要 destroy。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { register } from 'node:module'
import { parse, compileScript } from '@vue/compiler-sfc'

register(new URL('./helpers/resolve-nuxt-alias.mjs', import.meta.url), import.meta.url)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const { PREVIEWERS, previewerFor } = await import('../app/utils/previewer.ts')
const {
  CODE_LANGUAGES,
  languageForFilename,
  languageLabel,
  isCodeLanguageId,
  resolveCodeLanguage,
  loadLanguageExtension
} = await import('../app/utils/code-language.ts')
const {
  CODE_THEMES,
  DEFAULT_CODE_THEME,
  CODE_THEME_STORAGE_KEY,
  isCodeTheme,
  resolveCodeTheme,
  readCodeTheme,
  writeCodeTheme,
  loadCodeThemeExtension
} = await import('../app/utils/code-theme.ts')

// ── 预览器注册表 ─────────────────────────────────────────────────────────

describe('PREVIEWERS：新增的代码预览器', () => {
  test('注册表里有 code，位置在 text 之后，文案 4 字', () => {
    const ids = PREVIEWERS.map((p) => p.id)
    assert.ok(ids.includes('code'), '注册表里没有 code')
    assert.equal(ids.indexOf('code'), ids.indexOf('text') + 1, '代码预览应紧跟在文本预览之后')
    const code = PREVIEWERS.find((p) => p.id === 'code')
    assert.equal(code?.label, '代码预览')
  })

  test('没有顺手改默认：.js / .ts 仍然要用户自己选，.json 仍是 text', () => {
    assert.equal(previewerFor('a.js'), null, '新增预览器不该改变 .js 的默认行为')
    assert.equal(previewerFor('a.ts'), null, '新增预览器不该改变 .ts 的默认行为')
    assert.equal(previewerFor('a.json'), 'text')
  })
})

// ── 语言判定 ─────────────────────────────────────────────────────────────

describe('languageForFilename：按扩展名挑语法', () => {
  test('JS 家族（含 TS、JSX）都归 javascript', () => {
    for (const name of ['a.js', 'a.mjs', 'a.cjs', 'a.jsx', 'a.ts', 'a.tsx', 'a.mts', 'a.cts']) {
      assert.equal(languageForFilename(name), 'javascript', name)
    }
  })

  test('常见结构化文本各归各位', () => {
    const cases = {
      'a.json': 'json',
      'a.jsonc': 'json',
      'a.html': 'html',
      'a.htm': 'html',
      'a.xhtml': 'html',
      'a.css': 'css',
      'a.md': 'markdown',
      'a.markdown': 'markdown',
      'a.py': 'python',
      'a.xml': 'xml',
      'a.svg': 'xml',
      'a.plist': 'xml',
      'a.sql': 'sql',
      'a.yml': 'yaml',
      'a.yaml': 'yaml',
      'a.toml': 'toml'
    }
    for (const [name, expected] of Object.entries(cases)) {
      assert.equal(languageForFilename(name), expected, name)
    }
  })

  test('项目里真正会遇到的源码类型：Vue / Go / Rust / Java / C / PHP / Shell', () => {
    const cases = {
      'App.vue': 'vue',
      'main.go': 'go',
      'lib.rs': 'rust',
      'Main.java': 'java',
      'a.c': 'cpp',
      'a.h': 'cpp',
      'a.cpp': 'cpp',
      'a.hpp': 'cpp',
      'index.php': 'php',
      'run.sh': 'shell',
      'run.bash': 'shell',
      'run.zsh': 'shell'
    }
    for (const [name, expected] of Object.entries(cases)) {
      assert.equal(languageForFilename(name), expected, name)
    }
  })

  test('纯文本与认不出来的扩展名落到 plaintext', () => {
    for (const name of ['a.txt', 'a.log', 'a.csv', 'a.ini', 'a.env', 'a.png', 'a.tar.gz', 'README', 'a.', '']) {
      assert.equal(languageForFilename(name), 'plaintext', name)
    }
  })

  test('大小写不敏感', () => {
    assert.equal(languageForFilename('A.TS'), 'javascript')
    assert.equal(languageForFilename('A.JSON'), 'json')
  })
})

describe('loadLanguageExtension：按需加载，不把全部语法打进首屏', () => {
  test('每个 id 装的是对应的语法，不是随便一个语言包', async () => {
    // 只断「非空」的话，把 yaml 分支写成 json() 也能过 —— 屏幕上的高亮全错，
    // 而测试仍然绿。LanguageSupport.language.name 是各语言包自己定的稳定名字；
    // legacy-modes 的 StreamLanguage 直接是 Language 实例，名字在顶层。
    const names = {
      javascript: 'typescript', // javascript({ typescript: true }) 的方言名
      json: 'json',
      html: 'html',
      css: 'css',
      markdown: 'markdown',
      vue: 'vue',
      python: 'python',
      java: 'java',
      go: 'go',
      rust: 'rust',
      cpp: 'cpp',
      php: 'php',
      shell: 'shell',
      sql: 'sql',
      yaml: 'yaml',
      toml: 'toml',
      xml: 'xml'
    }
    const nameOf = (extension) => extension?.language?.name ?? extension?.name
    for (const [id, name] of Object.entries(names)) {
      const extension = await loadLanguageExtension(id)
      assert.ok(extension != null, `${id} 没有返回扩展`)
      assert.equal(nameOf(extension), name, `${id} 装错了语言包`)
    }
    assert.deepEqual(await loadLanguageExtension('plaintext'), [], 'plaintext 不需要语法扩展')
  })
})

describe('CODE_LANGUAGES / 语言下拉', () => {
  test('顺序与 id 固定', () => {
    assert.deepEqual(
      CODE_LANGUAGES.map((l) => l.id),
      ['javascript', 'json', 'html', 'css', 'markdown', 'vue', 'python', 'java', 'go',
       'rust', 'cpp', 'php', 'shell', 'sql', 'yaml', 'toml', 'xml', 'plaintext']
    )
  })

  test('id 唯一，label 非空，不含 markdown 星号', () => {
    assert.equal(new Set(CODE_LANGUAGES.map((l) => l.id)).size, CODE_LANGUAGES.length)
    for (const l of CODE_LANGUAGES) {
      assert.ok(l.label.trim().length > 0, `${l.id} 的 label 是空的`)
      assert.ok(!l.label.includes('**'), `${l.id} 的 label 漏出了 markdown 星号`)
    }
  })

  test('languageLabel 对每个 id 都给出下拉里的同一句', () => {
    for (const l of CODE_LANGUAGES) assert.equal(languageLabel(l.id), l.label, l.id)
  })

  test('isCodeLanguageId 只认表里的 id', () => {
    for (const l of CODE_LANGUAGES) assert.equal(isCodeLanguageId(l.id), true, l.id)
    for (const bad of ['auto', '', 'TYPESCRIPT', 'nope', null, undefined, 1]) {
      assert.equal(isCodeLanguageId(bad), false, String(bad))
    }
  })

  test('resolveCodeLanguage：auto 看扩展名，显式选择压过扩展名', () => {
    assert.equal(resolveCodeLanguage('App.vue', 'auto'), 'vue')
    assert.equal(resolveCodeLanguage('a.txt', 'auto'), 'plaintext')
    assert.equal(resolveCodeLanguage('a.txt', 'javascript'), 'javascript')
    assert.equal(resolveCodeLanguage('App.vue', 'python'), 'python')
  })
})

// ── 主题 ─────────────────────────────────────────────────────────────────

describe('CODE_THEMES：主题下拉', () => {
  test('顺序与 id 固定', () => {
    assert.deepEqual(CODE_THEMES.map((t) => t.id), ['auto', 'light', 'dark'])
  })

  test('默认跟随系统，且是第一项', () => {
    assert.equal(DEFAULT_CODE_THEME, 'auto')
    assert.equal(CODE_THEMES[0].id, DEFAULT_CODE_THEME)
  })

  test('id 唯一，label 2–6 字，不含 markdown 星号', () => {
    assert.equal(new Set(CODE_THEMES.map((t) => t.id)).size, CODE_THEMES.length)
    for (const t of CODE_THEMES) {
      const len = [...t.label].length
      assert.ok(len >= 2 && len <= 6, `${t.id} 的 label「${t.label}」是 ${len} 字`)
      assert.ok(!t.label.includes('**'), `${t.id} 的 label 漏出了 markdown 星号`)
    }
  })
})

describe('isCodeTheme：挡住 DOM 来的任意字符串', () => {
  test('认全部合法 id', () => {
    for (const t of CODE_THEMES) assert.equal(isCodeTheme(t.id), true, t.id)
  })

  test('空串、大写、非字符串一律拒绝', () => {
    assert.equal(isCodeTheme(''), false)
    assert.equal(isCodeTheme('DARK'), false)
    assert.equal(isCodeTheme('nope'), false)
    assert.equal(isCodeTheme(null), false)
    assert.equal(isCodeTheme(undefined), false)
    assert.equal(isCodeTheme(1), false)
  })
})

describe('resolveCodeTheme：auto 听系统，其余听用户', () => {
  test('auto + 系统深色 = dark', () => {
    assert.equal(resolveCodeTheme('auto', true), 'dark')
  })

  test('auto + 系统浅色 = light', () => {
    assert.equal(resolveCodeTheme('auto', false), 'light')
  })

  test('显式选择压过系统', () => {
    assert.equal(resolveCodeTheme('light', true), 'light')
    assert.equal(resolveCodeTheme('dark', false), 'dark')
  })
})

describe('主题记忆：localStorage 读写', () => {
  const storage = (initial) => {
    const map = new Map(Object.entries(initial ?? {}))
    return {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => { map.set(key, String(value)) }
    }
  }

  test('storage key 固定（改了就丢掉所有人的偏好）', () => {
    assert.equal(CODE_THEME_STORAGE_KEY, 'tricloud.code-theme')
  })

  test('没存过 / 坏值 / storage 不可用都回默认', () => {
    assert.equal(readCodeTheme(null), DEFAULT_CODE_THEME)
    assert.equal(readCodeTheme(undefined), DEFAULT_CODE_THEME)
    assert.equal(readCodeTheme(storage()), DEFAULT_CODE_THEME)
    assert.equal(readCodeTheme(storage({ [CODE_THEME_STORAGE_KEY]: 'nope' })), DEFAULT_CODE_THEME)
    assert.equal(
      readCodeTheme({ getItem() { throw new Error('blocked') } }),
      DEFAULT_CODE_THEME,
      '隐私模式下读取抛异常不能把预览器带崩'
    )
  })

  test('存过的合法值原样读回', () => {
    for (const t of CODE_THEMES) {
      assert.equal(readCodeTheme(storage({ [CODE_THEME_STORAGE_KEY]: t.id })), t.id)
    }
  })

  test('写入合法值；非法值不落盘', () => {
    const s = storage()
    writeCodeTheme(s, 'dark')
    assert.equal(s.getItem(CODE_THEME_STORAGE_KEY), 'dark')
    writeCodeTheme(s, 'nope')
    assert.equal(s.getItem(CODE_THEME_STORAGE_KEY), 'dark', '非法值不该覆盖已存的偏好')
  })

  test('storage 写入抛异常时不让保存失败', () => {
    assert.doesNotThrow(() => writeCodeTheme({ setItem() { throw new Error('quota') } }, 'light'))
  })
})

describe('loadCodeThemeExtension：两套主题都能加载', () => {
  test('light / dark 返回不同的扩展', async () => {
    const light = await loadCodeThemeExtension('light')
    const dark = await loadCodeThemeExtension('dark')
    assert.ok(light)
    assert.ok(dark)
    assert.notEqual(light, dark, '浅色与深色必须是两份不同的主题扩展')
  })
})

// ── FilePreviewer：代码分支的接线 ─────────────────────────────────────────

const previewerSource = read('app/components/FilePreviewer.vue')
const { descriptor: previewerSfc, errors: previewerErrors } = parse(previewerSource, { filename: 'FilePreviewer.vue' })
const previewerScript = previewerSfc.scriptSetup?.content ?? ''
const previewerAst = previewerSfc.template?.ast

const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return
  if (node.type === 1) visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

const collectElements = (tag) => {
  const found = []
  walk(previewerAst, (node) => {
    if (node.tag === tag) found.push(node)
  })
  return found
}

const directiveExp = (node, name) =>
  String((node.props ?? []).find((p) => p.type === 7 && p.name === name)?.exp?.content ?? '')

const bound = (node, arg) =>
  String((node.props ?? []).find((p) => p.type === 7 && p.name === 'bind' && p.arg?.content === arg)?.exp?.content ?? '')

const handler = (node, event) =>
  String((node.props ?? []).find((p) => p.type === 7 && p.name === 'on' && p.arg?.content === event)?.exp?.content ?? '')

const attrNames = (node) => (node.props ?? []).filter((p) => p.type === 6).map((p) => p.name)
const norm = (s) => String(s).replace(/\s+/g, ' ').trim()

const sliceBetween = (start, end) => {
  const from = previewerScript.indexOf(start)
  assert.ok(from >= 0, `script 里找不到「${start}」`)
  const to = previewerScript.indexOf(end, from + start.length)
  assert.ok(to > from, `script 里找不到「${end}」`)
  return previewerScript.slice(from, to)
}

describe('FilePreviewer：可编辑与解码', () => {
  test('模板与脚本能解析', () => {
    assert.equal(previewerErrors.length, 0, previewerErrors.map((e) => e.message).join('; '))
    assert.ok(previewerAst, '没有 template')
    assert.ok(previewerScript.length > 0, '没有 script setup')
  })

  test('可编辑 = 不是链接视角，且当前是文本或代码预览器', () => {
    assert.match(
      previewerScript,
      /const isEditable = computed\(\(\) => !linkMode\.value && \(activePreviewer\.value === 'text' \|\| activePreviewer\.value === 'code'\)\)/,
      'isEditable 必须正好覆盖 text 与 code 两种视角'
    )
    assert.doesNotMatch(previewerScript, /defaultPreviewer/, '不能又退回按扩展名卡编辑权')
  })

  test('代码模式和文本模式走同一条解码路（同一份字节、同一个编码）', () => {
    const render = sliceBetween('const renderPreview =', 'const load = async')
    assert.match(render, /target === 'text' \|\| target === 'code'/, '代码预览器没有被纳入解码分支')
    assert.match(render, /decodeText\(new Uint8Array\(await blob\.arrayBuffer\(\)\), encoding\.value\)/)
    assert.doesNotMatch(render, /blob\.text\(\)/)
  })

  test('语言默认按扩展名推，可被用户选择覆盖', () => {
    assert.match(previewerScript, /const autoCodeLanguage = computed\(\(\) => languageForFilename\(/)
    assert.match(previewerScript, /const codeLanguage = computed\(\(\) => resolveCodeLanguage\(/)
    assert.match(previewerScript, /const codeLanguageChoice = ref<CodeLanguageChoice>\('auto'\)/)
  })
})

describe('FilePreviewer：代码分支的模板', () => {
  const branch = collectElements('div').find(
    (d) => norm(directiveExp(d, 'else-if')) === "activePreviewer === 'text' || activePreviewer === 'code'"
  )

  test('文本与代码共用一个分支（编码下拉只有一份）', () => {
    assert.ok(branch, '没有找到 text/code 合并分支')
    assert.equal(
      collectElements('div').filter(
        (d) => norm(directiveExp(d, 'else-if')) === "activePreviewer === 'text' || activePreviewer === 'code'"
      ).length,
      1
    )
  })

  test('分支里有 CodeTextEditor，接线齐全', () => {
    const found = []
    walk(branch, (node) => found.push(node))
    const editor = found.find((n) => n.tag === 'CodeTextEditor')
    assert.ok(editor, '代码分支里没有 CodeTextEditor')
    assert.equal(directiveExp(editor, 'model'), 'textContent')
    assert.equal(bound(editor, 'language'), 'codeLanguage')
    assert.equal(bound(editor, 'theme'), 'resolvedCodeTheme')
    assert.equal(bound(editor, 'readonly'), '!isEditable', '链接视角必须是只读')
  })

  test('文本的 textarea / pre 仍在，互斥关系没被破坏', () => {
    const found = []
    walk(branch, (node) => found.push(node))
    const textarea = found.find((n) => n.tag === 'textarea')
    const pre = found.find((n) => n.tag === 'pre')
    assert.ok(textarea && pre)
    assert.equal(directiveExp(textarea, 'else-if'), 'isEditable')
    assert.ok(
      (pre.props ?? []).some((p) => p.type === 7 && p.name === 'else'),
      '只读分支必须是 v-else，否则会和 textarea 同时出现'
    )
  })

  test('分支里保留编码下拉，并新增语言与主题下拉', () => {
    const found = []
    walk(branch, (node) => found.push(node))
    const selects = found.filter((n) => n.tag === 'select')

    const encoding = selects.find((s) =>
      (s.children ?? []).some((c) => c.type === 1 && c.tag === 'option' && norm(directiveExp(c, 'for')) === 'e in TEXT_ENCODINGS')
    )
    assert.ok(encoding, '合并分支里没有编码下拉')

    const language = selects.find((s) =>
      (s.children ?? []).some((c) => c.type === 1 && c.tag === 'option' && norm(directiveExp(c, 'for')) === 'l in CODE_LANGUAGES')
    )
    assert.ok(language, '没有语言下拉')
    assert.equal(bound(language, 'value'), 'codeLanguageChoice')
    assert.equal(norm(directiveExp(language, 'if')), "activePreviewer === 'code'", '语言只属于代码预览')
    assert.equal(handler(language, 'change'), 'pickCodeLanguage')
    assert.ok(attrNames(language).includes('title'))
    assert.ok(attrNames(language).includes('aria-label'))

    // 第一项是「自动」，并且把当前文件名解析出来的语言直接写进去 ——
    // 否则用户选了 auto 却看不出到底选中的是哪套语法。
    const autoOption = (language.children ?? []).find(
      (c) => c.type === 1 && c.tag === 'option' && (c.props ?? []).some((p) => p.type === 6 && p.name === 'value' && p.value?.content === 'auto')
    )
    assert.ok(autoOption, '语言下拉没有 auto 选项')
    const autoText = (autoOption.children ?? []).filter((c) => c.type === 2).map((c) => c.content).join('')
    assert.ok(autoText.includes('自动'), `auto 选项的文案是「${autoText}」`)
    const autoExpr = (autoOption.children ?? []).filter((c) => c.type === 5).map((c) => c.content?.content ?? '').join('')
    assert.equal(autoExpr.trim(), 'languageLabel(autoCodeLanguage)')

    const theme = selects.find((s) =>
      (s.children ?? []).some((c) => c.type === 1 && c.tag === 'option' && norm(directiveExp(c, 'for')) === 't in CODE_THEMES')
    )
    assert.ok(theme, '没有主题下拉')
    assert.equal(bound(theme, 'value'), 'codeTheme')
    assert.equal(norm(directiveExp(theme, 'if')), "activePreviewer === 'code'", '主题只属于代码预览，不该出现在文本模式')
    assert.equal(handler(theme, 'change'), 'pickCodeTheme')
    assert.ok(attrNames(theme).includes('title'))
    assert.ok(attrNames(theme).includes('aria-label'))

    const option = (theme.children ?? []).find((c) => c.type === 1 && c.tag === 'option')
    assert.equal(norm(directiveExp(option, 'for')), 't in CODE_THEMES')
    const text = (option.children ?? []).find((c) => c.type === 5)
    assert.equal(text.content?.content?.trim(), 't.label')
  })

  test('CodeTextEditor 从组件导入（模板标签能解析）', () => {
    assert.match(previewerScript, /import CodeTextEditor from '~\/components\/CodeTextEditor\.vue'/)
  })
})

describe('FilePreviewer：主题状态跟随系统并记住选择', () => {
  test('读存储、解析 auto、写回', () => {
    assert.match(previewerScript, /readCodeTheme\(getLocalStorage\(\)\)/)
    assert.match(
      previewerScript,
      /const resolvedCodeTheme = computed<ResolvedCodeTheme>\(\(\) => resolveCodeTheme\(codeTheme\.value, prefersDark\.value\)\)/
    )
    const pick = sliceBetween('const pickCodeTheme =', 'watch(() => props.file?.id')
    assert.match(pick, /isCodeTheme\(raw\)/)
    assert.match(pick, /writeCodeTheme\(getLocalStorage\(\), raw\)/)
    assert.match(pick, /codeTheme\.value = raw/)
  })

  test('监听系统深浅变化，卸载时摘掉监听', () => {
    assert.match(previewerScript, /window\.matchMedia\('\(prefers-color-scheme: dark\)'\)/)
    assert.match(previewerScript, /addEventListener\('change', syncSystemTheme\)/)
    assert.match(previewerScript, /removeEventListener\('change', syncSystemTheme\)/)
  })

  test('换语言不落盘（只对当前文件有效），换文件回到 auto', () => {
    const pick = sliceBetween('const pickCodeLanguage =', 'watch(() => props.file?.id')
    assert.match(pick, /raw === 'auto'/)
    assert.match(pick, /isCodeLanguageId\(raw\)/)
    assert.match(pick, /codeLanguageChoice\.value = raw/)
    assert.doesNotMatch(pick, /writeCodeTheme|localStorage/, '语言是文件属性，不该跨文件记住')

    const fileWatch = sliceBetween('watch(() => props.file?.id', 'watch(() => props.file?.fileKey')
    assert.match(fileWatch, /codeLanguageChoice\.value = 'auto'/)
  })
})

// ── CodeTextEditor：CM6 的挂载与同步 ────────────────────────────────────

const editorSource = read('app/components/CodeTextEditor.vue')
const { descriptor: editorSfc, errors: editorErrors } = parse(editorSource, { filename: 'CodeTextEditor.vue' })
const editorScript = editorSfc.scriptSetup?.content ?? ''
const editorAst = editorSfc.template?.ast

describe('CodeTextEditor：编译与根节点', () => {
  test('SFC 能解析并编译', () => {
    assert.equal(editorErrors.length, 0, editorErrors.map((e) => e.message).join('; '))
    assert.doesNotThrow(() => compileScript(editorSfc, { id: 'code-editor' }))
  })

  test('根节点是挂载宿主，撑满容器', () => {
    const rootEl = (editorAst?.children ?? []).find((n) => n.type === 1)
    assert.ok(rootEl, '没有根元素')
    assert.equal(rootEl.tag, 'div')
    assert.equal(rootEl.props?.find((p) => p.type === 6 && p.name === 'ref')?.value?.content, 'host')
    const cls = rootEl.props?.find((p) => p.type === 6 && p.name === 'class')?.value?.content ?? ''
    assert.ok(cls.includes('h-full'), `根节点没有撑满高度：${cls}`)
  })
})

describe('CodeTextEditor：CM6 只在客户端、只在挂载后加载', () => {
  test('没有顶层静态引入 codemirror（避免首个 chunk 背上编辑器）', () => {
    const withoutTypeImports = editorScript.replace(
      /import\s+type\s+[\s\S]*?from\s+['"][^'"]+['"]\s*/g,
      ''
    )
    assert.doesNotMatch(
      withoutTypeImports,
      /from\s+['"](?:codemirror|@codemirror\/[^'"]+|@uiw\/[^'"]+)['"]/,
      'CM6 必须动态 import，否则首屏就把它下载下来'
    )
  })

  test('onMounted 里动态加载 state / view / basicSetup', () => {
    assert.match(editorScript, /onMounted\(async \(\) => \{/)
    // 只切挂载函数这一段：类型注解里也有 typeof import('@codemirror/...')，
    // 在整段 script 里搜会连类型位置一起算进来 —— 删掉运行时 import 也照样通过。
    const from = editorScript.indexOf('onMounted(async () => {')
    const to = editorScript.indexOf('// 外部换文本', from)
    assert.ok(from >= 0 && to > from, '找不到 onMounted 的收尾')
    const mounted = editorScript.slice(from, to)
    for (const spec of ['@codemirror/state', '@codemirror/view', 'codemirror']) {
      assert.ok(
        mounted.includes(`import('${spec}')`),
        `没有在挂载后按需加载 ${spec}`
      )
    }
  })

  test('主题也走 util 的按需加载，不在组件里写死 import', () => {
    assert.match(editorScript, /loadCodeThemeExtension\(props\.theme\)/)
    assert.match(editorScript, /loadLanguageExtension\(props\.language\)/)
  })
})

describe('CodeTextEditor：编辑、同步与只读', () => {
  test('doc 变化才 emit，且发的是整篇文档', () => {
    assert.match(editorScript, /EditorView\.updateListener\.of\(/)
    assert.match(
      editorScript,
      /if \(!update\.docChanged \|\| applyingExternal\) return[\s\S]{0,120}emit\('update:modelValue', update\.state\.doc\.toString\(\)\)/,
      'updateListener 必须在 docChanged 时把整篇文档发出去（选择变化不算）'
    )
  })

  test('外部换文本（换编码）会替换文档，但不回环 emit', () => {
    assert.match(editorScript, /watch\(\(\) => props\.modelValue, \(value\) => \{/)
    assert.match(editorScript, /if \(current === value\) return/)
    assert.match(editorScript, /applyingExternal = true/)
    assert.match(editorScript, /view\.dispatch\(\{ changes: \{ from: 0, to: current\.length, insert: value \} \}\)/)
  })

  test('只读同时关掉 state 与 view 两层', () => {
    assert.match(editorScript, /EditorState\.readOnly\.of\(readOnly\)/)
    assert.match(editorScript, /EditorView\.editable\.of\(!readOnly\)/)
  })

  test('语言 / 主题 / 只读变化都用 compartment 重配，不重建编辑器', () => {
    assert.equal((editorScript.match(/new state\.Compartment\(\)/g) ?? []).length, 3)
    assert.match(editorScript, /languageCompartment\.of\(language\)/)
    assert.match(editorScript, /themeCompartment\.of\(theme\)/)
    assert.match(editorScript, /readonlyCompartment\.of\(readonlyExtensions\(props\.readonly === true\)\)/)
    assert.match(editorScript, /languageCompartment\.reconfigure\(extension\)/)
    assert.match(editorScript, /themeCompartment\.reconfigure\(extension\)/)
    assert.match(editorScript, /readonlyCompartment\.reconfigure\(readonlyExtensions\(readOnly === true\)\)/)
    for (const prop of ['language', 'theme', 'readonly']) {
      assert.match(editorScript, new RegExp(`watch\\(\\(\\) => props\\.${prop},`), `没有监听 props.${prop}`)
    }
  })

  test('卸载时 destroy，别把 DOM 监听留在身后', () => {
    assert.match(editorScript, /onBeforeUnmount\(\(\) => \{[\s\S]{0,160}view\?\.destroy\(\)/)
  })
})
