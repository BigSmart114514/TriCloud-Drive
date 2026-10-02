// 压缩包预览的**界面**只有一个实现 —— 回归测试。
//
// ## 为什么这件事需要测试
//
// 上一轮把树逻辑抽进了 useArchiveTree，用的是「行为测试」（跑 composable、比结果）。
// 这次抽的是**模板** —— 模板没有行为可测，只有源码可测。
//
// 而模板重复正是最容易被无声改回去的东西：有人要加个按钮，直接在
// ZipPreview.vue 里加，SevenZipPreview.vue 里忘了加。两个预览器界面就此分叉，
// 没有任何测试会红。
//
// 所以这份测试的全部内容是：**两份界面不许重新出现，组件契约不许漂**。
//
// ## 覆盖不到的部分
//
// 本项目没有 @vue/test-utils / happy-dom，**组件挂载后渲染不了**。
// 所以「props 真的传对了」「事件真的接上了」这类运行时行为测不到 ——
// 只能断言「父组件绑定的每个 prop / 事件，ArchiveBrowser 都声明了」，
// 以及「模板确实只剩一份」。
//
// 布局有没有塌、交互对不对，最终仍需浏览器里看一眼。这不是这份测试能替代的。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from '@vue/compiler-sfc'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const BROWSER = 'app/components/ArchiveBrowser.vue'
const PARENTS = ['app/components/ZipPreview.vue', 'app/components/SevenZipPreview.vue']

/** 去掉注释，免得注释里提到的东西把判定带偏 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
    .join('\n')
}

/**
 * 取顶层 <template> 的内容。
 *
 * **不能**用 `/<template>([\s\S]*?)<\/template>/` —— 非贪婪会在**第一个**
 * `</template>` 处停下，而面包屑那个 `<template v-for>` 正好是嵌套的：
 * 结果只拿到模板的前半截，后面两条断言直接假失败（踩过一次）。
 * 交给 @vue/compiler-sfc 的 parser，它知道嵌套层级。
 */
function templateOf(src) {
  const { descriptor, errors } = parse(src, { filename: 'x.vue' })
  assert.equal(errors?.length ?? 0, 0, 'SFC 解析出错 —— 测试的输入本身有问题')
  return descriptor.template?.content ?? ''
}

/** 从 `:kebab-case="..."` 里取出 prop 名 */
function boundProps(tpl) {
  return [...tpl.matchAll(/\s:([a-z0-9-]+)="[^"]*"/g)].map((m) => m[1])
}

/** 从 `@kebab-case="..."` 里取出事件名（不含 v-model:xxx） */
function listenedEvents(tpl) {
  return [...tpl.matchAll(/\s@(?!update:)([a-z0-9-]+)="[^"]*"/g)].map((m) => m[1])
}

/** `v-model:search="..."` → 'search' */
function modelNames(tpl) {
  return [...tpl.matchAll(/\sv-model:([a-z0-9-]+)="[^"]*"/g)].map((m) => m[1])
}

/** 从 defineProps<{ ... }>() 的类型字面量里取出属性名 */
function declaredProps(src) {
  const m = src.match(/defineProps<\{([\s\S]*?)\}>\(\)/)
  if (!m) return []
  return [...m[1].matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*)\??:/gm)].map((x) => x[1])
}

/** 从 defineEmits<{ ... }>() 里取出事件名（kebab） */
function declaredEmits(src) {
  const m = src.match(/defineEmits<\{([\s\S]*?)\}>\(\)/)
  if (!m) return []
  return [...m[1].matchAll(/'([a-z-]+)':/g)].map((x) => x[1])
}

/**
 * 模板里的 `:kebab-case` → camelCase，才能和 defineProps 的声明对齐。
 *
 * 第一版这里写反了方向（camel→kebab，`archiveName` → `archive-name`），
 * 于是拿模板里的 `:archive-name` 去比，两个父组件都被判「没声明这个 prop」。
 */
const camel = (kebab) => kebab.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())

describe('压缩包预览的界面只有一份', () => {
  for (const p of PARENTS) {
    test(`${p.split('/').pop()} 用的是共享的 ArchiveBrowser`, () => {
      const tpl = templateOf(read(p))
      assert.match(
        tpl,
        /<ArchiveBrowser/,
        p + ' 的模板里没有 <ArchiveBrowser> —— 界面又被抄回本文件了？'
      )
    })
  }

  test('两个父组件都不含界面 markup（面包屑 / 空态 / 跳过提示）', () => {
    // 这几串是「界面」的特征。之前它们各有两份，现在应该一份都没有。
    //
    // 每一条都要**够独特**：第一版里的 '压缩包内容' 匹配到了 ZipPreview 里
    // `failTree(e?.message || '无法读取压缩包内容')` 这句错误文案，于是
    // 明明清干净了却报「还留着界面 markup」。判断重复片段时不能只挑眼熟的部分。
    const MARKUP = [
      'max-w-[12rem] truncate hover:text-indigo-600', // 面包屑按钮
      '已跳过 {{ skippedCount }}',
      '搜索当前目录',
      '">压缩包内容</p>' // 带标签，避免撞上错误文案
    ]
    for (const p of PARENTS) {
      const code = codeOnly(read(p))
      for (const m of MARKUP) {
        assert.doesNotMatch(
          code,
          new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          `${p} 里还留着界面 markup「${m}」—— 它应该只在 ${BROWSER} 里`
        )
      }
    }
  })

  test('两个父组件都不再直接渲染 FileList', () => {
    // FileList 现在归 ArchiveBrowser 管。父组件里留着 <FileList> 说明
    // 有人绕过共享组件自己塞了个列表进去。
    for (const p of PARENTS) {
      assert.doesNotMatch(
        codeOnly(read(p)),
        /<FileList/,
        p + ' 直接用了 <FileList>，应通过 ArchiveBrowser'
      )
    }
  })

  test('界面的 markup 在 ArchiveBrowser 里只有一份', () => {
    const tpl = templateOf(read(BROWSER))
    assert.match(tpl, /已跳过 \{\{ skippedCount \}\}/, '跳过提示应该在共享组件里')
    assert.match(tpl, /<FileList/, 'FileList 应该在共享组件里')
    assert.match(tpl, /v-if="!error"/, '出错时隐藏列表的逻辑也应该只有一份')
  })

  // 只断言「没重复」是不够的：把共享那份里的 class 改掉、把面包屑的点击目标
  // 删掉，重复断言依然全绿 —— 第一版的扫描就是这么漏掉一条变异的。
  // 这一节把共享那份的**内容**也钉住。
  test('共享那份的界面内容完好（不是只「没重复」）', () => {
    const tpl = templateOf(read(BROWSER))

    const bits = [
      ['面包屑按钮的样式', /class="max-w-\[12rem\] truncate hover:text-indigo-600"/],
      ['面包屑按钮的点击', /@click="emit\('go-to-path', crumb\.path\)"/],
      ['面包屑的分隔符', /<span v-if="index > 0" class="text-gray-300">\/<\/span>/],
      ['面包屑的当前项高亮', /index === breadcrumbs\.length - 1/],
      ['搜索框的双向绑定', /v-model="search"/],
      ['搜索框的 placeholder', /placeholder="搜索当前目录"/],
      ['总数统计', /\{\{ totalCount \}\} 项/],
      ['过滤后另报可见数', /v-if="visibleCount !== totalCount"/],
      ['错误红条', /v-if="error" class="mb-3 rounded-md bg-red-50/],
      ['超限黄条', /v-if="skippedCount > 0" class="mb-3 rounded-md bg-amber-50/],
      ['空态标题随搜索词变', /:empty-title="search\.trim\(\) \? '没有匹配项' : '压缩包为空'"/],
      ['列表不可选', /:selectable="false"/],
      ['列表不显示操作', /:show-actions="false"/]
    ]
    for (const [what, re] of bits) {
      assert.match(tpl, re, `共享组件里 ${what} 不见了`)
    }
  })

  test('两个父组件绑定的 prop / 事件 / model 就是预期的那一套（不多不少）', () => {
    // 反向断言。第一版只查「绑的东西都有声明」，方向是单向的：
    // 把 v-model:search 整个删掉时，被遍历的 model 列表变空，循环空转，
    // 测试照样绿 —— 实际上父组件已经不绑搜索词了。
    // 这里要求两个方向的集合都精确相等。
    const EXPECT_PROPS = [
      'archive-name', 'breadcrumbs', 'total-count', 'visible-count',
      'error', 'skipped-count', 'loading', 'visible-folders', 'visible-files'
    ].sort()
    const EXPECT_EVENTS = ['go-to-path', 'navigate-folder', 'preview-file'].sort()
    const EXPECT_MODELS = ['search']

    for (const p of PARENTS) {
      const tpl = templateOf(read(p))
      const name = p.split('/').pop()
      assert.deepEqual([...new Set(boundProps(tpl))].sort(), EXPECT_PROPS,
        `${name} 绑定的 prop 集合与预期不符`)
      assert.deepEqual([...new Set(listenedEvents(tpl))].sort(), EXPECT_EVENTS,
        `${name} 监听的事件集合与预期不符`)
      assert.deepEqual([...new Set(modelNames(tpl))].sort(), EXPECT_MODELS,
        `${name} 的 v-model 集合与预期不符（少了 search = 搜索框不工作了）`)
    }
  })
})

describe('ArchiveBrowser 的契约与两个父组件的绑定一致', () => {
  const browser = codeOnly(read(BROWSER))
  const props = declaredProps(browser)
  const emits = declaredEmits(browser)

  test('ArchiveBrowser 声明了 props 与 emits', () => {
    assert.ok(props.length >= 8, `props 只声明了 ${props.length} 个，看着不对`)
    assert.ok(
      emits.includes('preview-file'),
      'ArchiveBrowser 必须 emit preview-file —— 否则父组件的 openFile 永远不会被调'
    )
    assert.ok(
      emits.includes('navigate-folder'),
      '必须 emit navigate-folder，否则点文件夹没有反应'
    )
    assert.ok(emits.includes('go-to-path'), '必须 emit go-to-path，否则点面包屑没有反应')
  })

  for (const p of PARENTS) {
    const tpl = templateOf(read(p))
    const bound = boundProps(tpl)
    const listened = listenedEvents(tpl)
    const models = modelNames(tpl)
    const name = p.split('/').pop()

    test(`${name} 绑定的每个 prop 都有声明`, () => {
      // 绑了但没声明 = 那个值传不进去，运行时静默变成 undefined。
      // 这类错误 tsc 抓不到（.vue 不进 tsc），组件也挂不上来。
      for (const b of bound) {
        assert.ok(
          props.includes(camel(b)),
          `${name} 绑了 :${b}="..."，但 ArchiveBrowser 没声明这个 prop（已声明：${props.join(', ')}）`
        )
      }
    })

    test(`${name} 监听的事件都有声明`, () => {
      for (const e of listened) {
        assert.ok(
          emits.includes(e),
          `${name} 监听了 @${e}，但 ArchiveBrowser 没有 emit 它（已声明：${emits.join(', ')}）`
        )
      }
    })

    test(`${name} 的 v-model 双向绑定有对应的 model`, () => {
      for (const m of models) {
        assert.match(
          browser,
          new RegExp(`defineModel<[^>]*>\\('${m}'`),
          `${name} 用了 v-model:${m}，ArchiveBrowser 里没有 defineModel('${m}')`
        )
      }
    })

    test(`${name} 把三个交互都接上了`, () => {
      // 少接一个就是「点了没反应」，而且不报错。
      for (const e of ['go-to-path', 'navigate-folder', 'preview-file']) {
        assert.ok(
          listened.includes(e),
          `${name} 没接 @${e} —— 那用户在 ${name} 里点${e === 'preview-file' ? '文件' : e === 'navigate-folder' ? '文件夹' : '面包屑'}不会有反应`
        )
      }
    })

    test(`${name} 没有把 formatDate 之类的东西漏进模板`, () => {
      // 反向的过宽检查：模板里只该出现绑定的 prop。
      // 冒出来一个别的标识符，多半是解构漏了、模板引用了本地变量。
      const known = new Set([...bound, ...models, ...listened])
      known.add('ArchiveBrowser')
      const interpolations = [
        ...templateOf(read(p)).matchAll(/\{\{([^}]+)\}\}/g)
      ].map((m) => m[1].trim())
      for (const expr of interpolations) {
        assert.ok(
          known.has(expr) || /^[a-zA-Z_][\w.()'" -]*$/.test(expr),
          `${name} 模板里插值 {{ ${expr} }} 看着不像绑定来的 —— 检查一下`
        )
      }
    })
  }

  test('ArchiveBrowser 自身不持有状态（search 必须是 defineModel，不是 ref）', () => {
    // 它是纯展示组件。search 归父组件的 useArchiveTree 所有 ——
    // 子组件自己存一份的话，两个预览器的搜索词就与树脱钩了。
    assert.match(
      browser,
      /defineModel<[^>]*>\('search'/,
      "search 应该用 defineModel('search')，不能自己 ref 一份"
    )
    assert.doesNotMatch(
      browser,
      /ref\s*\(\s*['"]search['"]/,
      'ArchiveBrowser 不该自己 ref 一份 search —— 状态归父组件'
    )
  })
})
