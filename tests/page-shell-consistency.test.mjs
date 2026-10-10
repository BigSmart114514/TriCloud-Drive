// 页面的「外壳」口径：导航栏的宽度模式必须与页面内容一致。
//
// ## 实际发生过什么
//
// manage/bucket.vue 用 `<AppNavbar fluid />`（导航内容通栏铺到视口两边）配一个
// `max-w-6xl` 的居中内容容器。于是两者的左边缘对不上：从「文件总览」点进
// 「存储桶管理」，导航里的 logo 与菜单是贴边的，而下面的标题与表格是内缩的。
//
// 加上 `max-w-6xl` 这个宽度本身——全仓库只有 bucket 与 browse 在用，其余是
// 7xl（accounts / index / user）、5xl（shares，刻意更窄）、md（改密码，单卡）。
// browse.vue 是照着 bucket 抄的，等于把同一处分歧复制了一份。
//
// ## 为什么写成「模式必须一致」而不是「都用 7xl」
//
// 因为两种组合都成立，只是不该混用：
//
//   默认导航栏（内容 max-w-7xl 居中）  +  居中内容      ← accounts / user / shares
//   fluid 导航栏                        +  整页铺满    ← files（SidePanelLayout）
//
// index.vue 两种都有：它按分支选 —— 有侧栏时 fluid，没有侧栏时默认。
// 所以规则是「同页之内不得把 fluid 导航栏与 max-w-* 内容配在一起」，
// 多分支的页面则单独确认它确实整页铺满。
//
// ## 为什么不能用源码断言
//
// 同 share-bulk-wiring.test.mjs 开头那段：没有 DOM 环境。这里能断言的是
// **类名口径**（「内容容器有没有被约束」「导航栏是不是 fluid」），不是渲染
// 出来的像素。好不好看仍然得在浏览器里看一眼。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { parse } from '@vue/compiler-sfc'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PAGES_DIR = join(root, 'app/pages')

function codeOnly(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*[*]/.test(l))
    .join('\n')
}

function walk(dir) {
  const out = []
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (f.endsWith('.vue')) out.push(p)
  }
  return out
}

function templateOf(p) {
  const { descriptor, errors } = parse(readFileSync(p, 'utf8'), { filename: p })
  assert.equal(errors?.length ?? 0, 0, `${p} SFC 解析出错 —— 测试的输入本身有问题`)
  return codeOnly(descriptor.template?.content ?? '')
}

/**
 * 整页铺满：内容根不设 max-w，靠侧栏或视口高度撑满。
 *
 * 刻意**不含** `min-h-screen`：bucket/browse 也是 min-h-screen，但它们的内容
 * 是有宽度上限的居中容器。把 min-h-screen 算成「铺满」的话，那两页就直接
 * 蒙混过关了 —— 这条判据必须是它蒙混不过去的那条。
 */
const FULL_BLEED_RE = /SidePanelLayout|h-\[100dvh\]|h-screen|flex-col overflow-hidden/

/** 项目里「宽的居中容器」统一口径。三处（accounts / index / user）逐字相同。
 *  下面是按 token 断言的，所以这里只作文档用途 —— 见最后一个 describe 的注释。 */
const CENTERED_RECIPE = 'max-w-7xl mx-auto py-6 sm:px-6 lg:px-8'

const pages = walk(PAGES_DIR)
  .map((p) => {
    const t = templateOf(p)
    const tags = [...t.matchAll(/<AppNavbar\b([^>]*)>/g)].map((m) => m[1])
    return {
      p: relative(PAGES_DIR, p),
      t,
      hasNavbar: tags.length > 0,
      fluid: tags.filter((a) => /\bfluid\b/.test(a)).length,
      plain: tags.filter((a) => !/\bfluid\b/.test(a)).length,
      maxWs: [...new Set([...t.matchAll(/max-w-(\w+)/g)].map((m) => m[1]))],
      fullBleed: FULL_BLEED_RE.test(t)
    }
  })
  .filter((x) => x.hasNavbar)

const BUCKETISH = ['manage/bucket.vue', 'manage/browse.vue']

describe('扫描自检（防恒真）', () => {
  test('扫到页面了（目录或过滤写错就会扫 0 个而全绿）', () => {
    assert.ok(pages.length >= 7, `app/pages 下只扫到 ${pages.length} 个带 AppNavbar 的页面`)
    assert.ok(
      pages.some((x) => x.fluid > 0) && pages.some((x) => x.plain > 0),
      '两种导航栏模式一个都没扫到 —— 下面的「模式必须一致」会恒真'
    )
  })

  test('两种模式确实都在用（规则才有意义）', () => {
    const fluid = pages.filter((x) => x.plain === 0).map((x) => x.p)
    const plain = pages.filter((x) => x.fluid === 0).map((x) => x.p)
    assert.ok(fluid.length > 0, '没有任何页面用 fluid 导航栏')
    assert.ok(plain.length > 0, '没有任何页面用默认导航栏')
  })
})

describe('导航栏的宽度模式必须与页面内容一致', () => {
  for (const x of pages) {
    const multi = x.fluid > 0 && x.plain > 0
    test(`${x.p}`, () => {
      if (multi) {
        // 多分支页面（index.vue：有侧栏用 fluid，没有用默认）。规则对它是
        // 「两种模式都出现」，只要求它确实整页铺满。
        assert.ok(
          x.fullBleed,
          `${x.p} 两种导航栏模式都有，却没有整页铺满的结构 —— ` +
            `fluid 那条分支的内容会与导航左边缘对不上`
        )
        return
      }
      const constrained = x.maxWs.length > 0
      if (x.fluid > 0) {
        assert.ok(
          !constrained,
          `${x.p} 用 fluid 导航栏（内容通栏贴边）却把内容限制在 max-w-${x.maxWs.join('/')} —— ` +
            `导航的内容边缘与页面内容的边缘对不上，切换菜单项时能看出来。` +
            `要么内容整页铺满，要么导航栏改回默认（内容居中）`
        )
      } else {
        assert.ok(
          constrained || x.fullBleed,
          `${x.p} 用默认导航栏（内容 7xl 居中）却没有居中内容容器 —— 导航是居中的而内容是通栏的`
        )
      }
    })
  }
})

describe('没有页面自创宽度口径', () => {
  test('bucket 与 browse 用项目统一的居中容器口径', () => {
    // 逐字比对整串 class 是过紧的：`max-w-7xl mx-auto` 与 `mx-auto max-w-7xl`
    // 语义完全相同，多一个无害的 class（如 antialiased）也一样。变异扫描的 B 段
    // 把这两种改法判成「竟然抓到」—— 那说明判据在量字符串，不在量口径。
    //
    // 所以逐个 token 断言：宽度上限是 7xl（且有且只有一个）、居中、响应式内边距在。
    // 其余宽容器页面（accounts / index / user）就是这三样。shares 是 5xl
    // （刻意更窄，窄列表好读），改密码是 md（单张卡片），都不在「宽容器」这一档。
    const NEEDED = ['max-w-7xl', 'mx-auto', 'sm:px-6', 'lg:px-8']
    for (const rel of BUCKETISH) {
      const x = pages.find((p) => p.p === rel)
      assert.ok(x, `没扫到 ${rel}`)
      const main = /<main class="([^"]*)"/.exec(x.t)
      assert.ok(main, `${rel} 没找到 <main>`)
      const tokens = main[1].split(/\s+/)
      for (const need of NEEDED) {
        assert.ok(tokens.includes(need), `${rel} 的 <main> 缺 ${need}（现有：${main[1]}）`)
      }
      // 宽度上限有且只有一个 —— 两个 max-w-* 同时挂着会互相打架
      const ws = tokens.filter((t) => t.startsWith('max-w-'))
      assert.deepEqual(ws, ['max-w-7xl'], `${rel} 的 <main> 上有多个宽度上限：${ws.join(' ')}`)
    }
  })

  test('全仓库没有 max-w-6xl（它就是 bucket 自创的那个宽度）', () => {
    // 正向地钉住「宽容器只有一种口径」之后，再从反面确认一次：
    // 6xl 出现过一次，就说明又有人自己定了一个宽度。
    for (const x of pages) {
      assert.ok(
        !x.maxWs.includes('6xl'),
        `${x.p} 用了 max-w-6xl —— 全仓库的宽容器口径是 7xl（shares 的 5xl、` +
          `改密码的 md 是各自有理由的更窄，不是同一条线）`
      )
    }
  })

  test('标题带的内层容器与 main 同宽（否则标题与下面的表格不对齐）', () => {
    for (const rel of BUCKETISH) {
      const x = pages.find((p) => p.p === rel)
      assert.ok(x, `没扫到 ${rel}`)
      // 标题在 <header> 的内层 div，表格在 <main>。两个宽度上限必须一致。
      const band = /<header[\s\S]*?<div class="([^"]*max-w-\w+[^"]*)"/.exec(x.t)
      assert.ok(band, `${rel} 的标题带里没找到带 max-w 的内层容器`)
      const main = /<main class="([^"]*)"/.exec(x.t)
      assert.ok(main, `${rel} 没找到 <main>`)
      const w = (s) => /max-w-(\w+)/.exec(s)?.[1]
      assert.equal(
        w(band[1]),
        w(main[1]),
        `${rel}：标题带是 max-w-${w(band[1])} 而 main 是 max-w-${w(main[1])} —— 标题与内容左右边缘对不上`
      )
    }
  })
})
