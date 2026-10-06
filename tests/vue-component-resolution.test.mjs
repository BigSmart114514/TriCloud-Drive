// 模板里用到的组件必须真的能解析。
//
// ## 为什么要有这个测试
//
// 实际踩过一次：PromptDialog.vue 的模板里用了 `<XMarkIcon />`，而 import 列表
// 漏了它。表现是运行时一条
//
//     [Vue warn]: Failed to resolve component: XMarkIcon
//
// 而**项目里现有的两道关卡都看不见**：
//
//   sfc-check.mjs   只编 template 的语法。第 49 行的注释写明了「expression 里的
//                   未定义标识符编译期抓不到，这里只抓语法」。组件解析不在其中。
//   tsc --noEmit    根本不检查 .vue 的模板 —— 那是 vue-tsc 的活，而这个项目跑的是
//                   裸 tsc（见 package.json 的 typecheck）。
//
// 所以这类错误在提交前完全无声，只能靠人打开页面看到。而它不会导致功能失效，
// 只会让一个图标变成空白 —— 恰恰是最容易被忽略、又最该被拦下的那一类。
//
// ## 判据
//
// 一个组件标签算「能解析」，满足其一：
//
//   1. script 里出现了这个名字（显式 import，含 `Foo as Bar` 的别名）
//   2. app/components/ 下存在同名文件 —— Nuxt 会自动导入
//   3. 在 BUILTINS 白名单里（Vue 与 Nuxt 自己提供的那些）
//
// 只收 PascalCase 与 kebab-case 两种自定义形状：小写无连字符的是原生标签，
// 不归这里管。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from '@vue/compiler-sfc'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Vue 与 Nuxt 自己提供的组件 / 内置元素。
 * 它们由框架注入，不需要 import。
 */
const BUILTINS = new Set([
  // Vue 内置
  'Teleport', 'Transition', 'TransitionGroup', 'KeepAlive', 'Suspense', 'component',
  // Nuxt
  'NuxtLayout', 'NuxtPage', 'NuxtLink', 'NuxtLoadingIndicator', 'NuxtErrorBoundary',
  'ClientOnly', 'NuxtWelcome', 'NuxtImg', 'NuxtTime'
])

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.nuxt', '.output', 'dist'].includes(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (full.endsWith('.vue')) yield full
  }
}

/** PascalCase 或 kebab-case 的自定义组件标签 */
function customTags(tpl) {
  const tags = new Set()
  for (const m of tpl.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)) tags.add(m[1])
  for (const m of tpl.matchAll(/<([a-z][a-z0-9]*-[a-z0-9-]+)[\s/>]/g)) tags.add(m[1])
  return tags
}

const pascalOf = (t) =>
  t.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join('')

/** Nuxt 自动导入：app/components 下存在同名文件 */
function autoImportable(tag) {
  const base = join(root, 'app/components')
  return existsSync(join(base, tag + '.vue')) || existsSync(join(base, pascalOf(tag) + '.vue'))
}

/** 这个 .vue 里所有解析不了的组件标签 */
function unresolvedOf(file) {
  const { descriptor, errors } = parse(readFileSync(file, 'utf8'), { filename: file })
  assert.equal(errors?.length ?? 0, 0, `${file} SFC 解析出错`)
  const tpl = descriptor.template?.content ?? ''
  const script = `${descriptor.scriptSetup?.content ?? ''}\n${descriptor.script?.content ?? ''}`
  const out = []
  for (const tag of customTags(tpl)) {
    if (BUILTINS.has(tag)) continue
    if (new RegExp(`\\b${tag}\\b`).test(script)) continue
    if (autoImportable(tag)) continue
    out.push(tag)
  }
  return out
}

const files = [...walk(join(root, 'app'))]

describe('模板里的组件都能解析', () => {
  test('扫到了 SFC（防止上面那个 walk 悄悄扫了 0 个而全绿）', () => {
    // 第一版的风险正是这个：walk 写错一个目录，for 循环空转，测试零断言全过。
    assert.ok(files.length >= 28, `期望至少 28 个 .vue，实际扫到 ${files.length} 个`)
  })

  test('app/ 下没有任何未解析的组件标签', () => {
    const bad = []
    for (const f of files) {
      for (const tag of unresolvedOf(f)) {
        bad.push(`${f.replace(root + '/', '')}: <${tag}>`)
      }
    }
    assert.deepEqual(
      bad,
      [],
      `模板用了但解析不了的组件：\n${bad.join('\n')}\n\n` +
        '要么补 import，要么改用 app/components 下已有的组件。' +
        'sfc-check 只查模板语法、裸 tsc 不查 .vue 模板，所以这两道关卡都拦不住。'
    )
  })

  // 单独钉住实际踩过的那一个，失败信息更直白，也免得以后靠泛化断言去猜是哪个文件。
  test('PromptDialog 用到的 XMarkIcon 确实 import 了', () => {
    // 这条是本次的真实 bug：import 列表漏了 XMarkIcon，运行时只剩一条 warn，
    // 图标渲染成空白。所有既有检查都通过（见文件头）。
    const file = join(root, 'app/components/PromptDialog.vue')
    const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file })
    const script = descriptor.scriptSetup?.content ?? ''
    assert.match(
      script,
      /XMarkIcon/,
      'PromptDialog 用了 <XMarkIcon /> 却没 import —— 右上角关闭键会渲染成空白'
    )
  })

  test('白名单里的都是框架自带，不是靠它放行真·未解析的标签', () => {
    // 白名单最容易变成「什么都往里塞」的垃圾桶。钉住它当前该有的内容：
    // 只允许 Vue 内置 + Nuxt 内置，且不许出现以 Icon 结尾的（那些都该显式 import）。
    for (const tag of BUILTINS) {
      assert.doesNotMatch(tag, /Icon$/, `${tag} 不该在白名单里 —— 图标必须显式 import`)
    }
    assert.ok(BUILTINS.has('NuxtLink'), 'NuxtLink 由框架提供，不该要求 import')
    assert.ok(BUILTINS.has('Teleport'), 'Teleport 是 Vue 内置')
  })
})
