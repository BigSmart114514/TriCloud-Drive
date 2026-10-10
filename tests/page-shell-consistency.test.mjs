// 页面的「外壳」口径：顶栏只有一种宽度，内容容器只有一种口径。
//
// ## 实际发生过什么
//
// AppNavbar 有一个 `fluid` prop，在两种宽度之间切换：
//
//   默认    max-w-7xl mx-auto px-4 sm:px-6 lg:px-8   ← 内容居中，两侧留白
//   fluid   w-full px-3 sm:px-4                      ← 通栏，贴到视口两边
//
// 它是 e834f74（做侧栏外壳那次）加进来的，为的是让整页铺满的页面能有通栏顶栏；
// 而默认值留在了旧样式上，于是另外五个页面一直没迁过去。结果是切换页面时
// 顶栏宽度突变 —— logo 从视口边缘跳到中间，再跳回来。
//
// 两种模式**不能**并存的原因不是审美，是可行性的其中一个方向做不到：
// 首页与文件总览是侧栏 + 文件列表的整页铺满应用外壳，把它们的顶栏改成居中
// 等于在通栏界面上方悬一条小岛。所以 2026-10-10 定为**永远通栏**，prop 删除 ——
// 让「两种样式」这件事在结构上无法再被问出来。
//
// 另外 manage/bucket.vue 与 manage/browse.vue 自创过 `max-w-6xl`（全仓库只有
// 这两页在用），已一并归到项目口径。那两页同时还把 fluid 顶栏配了居中内容，
// 导航与内容的左边缘对不上 —— 见下面「没有页面自创宽度口径」。
//
// ## 为什么只能用源码断言
//
// 同 share-bulk-wiring.test.mjs 开头那段：没有 DOM 环境。这里能断言的是
// **类名口径**，不是渲染出来的像素。好不好看仍然得在浏览器里看一眼。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { parse } from '@vue/compiler-sfc'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PAGES_DIR = join(root, 'app/pages')
const NAVBAR = join(root, 'app/components/AppNavbar.vue')

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

/** 收绝对路径。页面扫描给的是 walk() 的绝对路径，AppNavbar 给的是 join 出来的 ——
 *  混用两种基准过一次，报的是 ENOENT 加一个看着莫名其妙的路径。 */
function templateOf(absPath) {
  const { descriptor, errors } = parse(readFileSync(absPath, 'utf8'), { filename: absPath })
  assert.equal(errors?.length ?? 0, 0, `${absPath} SFC 解析出错 —— 测试的输入本身有问题`)
  return codeOnly(descriptor.template?.content ?? '')
}

function scriptOf(absPath) {
  const { descriptor, errors } = parse(readFileSync(absPath, 'utf8'), { filename: absPath })
  assert.equal(errors?.length ?? 0, 0, `${absPath} SFC 解析出错 —— 测试的输入本身有问题`)
  return codeOnly(descriptor.scriptSetup?.content ?? '')
}

/**
 * 整页铺满：内容根不设 max-w，靠侧栏或视口高度撑满。
 *
 * 刻意**不含** `min-h-screen`：manage/bucket 与 manage/browse 也是
 * min-h-screen，但它们的内容是有宽度上限的居中容器。把 min-h-screen 算成
 * 「铺满」的话那两页会蒙混过关 —— 这条判据必须是它蒙混不过去的那条。
 */
const FULL_BLEED_RE = /SidePanelLayout|h-\[100dvh\]|h-screen|flex-col overflow-hidden/

const pages = walk(PAGES_DIR)
  .map((abs) => {
    const t = templateOf(abs)
    return {
      abs,
      p: relative(PAGES_DIR, abs),
      t,
      hasNavbar: /<AppNavbar\b/.test(t),
      passesFluid: /<AppNavbar\b[^>]*\bfluid\b/.test(t),
      maxWs: [...new Set([...t.matchAll(/max-w-(\w+)/g)].map((m) => m[1]))],
      fullBleed: FULL_BLEED_RE.test(t)
    }
  })
  .filter((x) => x.hasNavbar)

const BUCKETISH = ['manage/bucket.vue', 'manage/browse.vue']

describe('扫描自检（防恒真）', () => {
  test('扫到页面了（目录或过滤写错就会扫 0 个而全绿）', () => {
    assert.ok(pages.length >= 7, `app/pages 下只扫到 ${pages.length} 个带 AppNavbar 的页面`)
  })

  test('两种内容形态都在（所以顶栏的统一才需要被钉）', () => {
    // 全站顶栏统一成通栏之后，内容**仍然**有两种形态（通栏外壳 / 居中 7xl）。
    // 若哪天全站都变成同一种，这条自检会报出来，届时下面的断言需要重新想。
    assert.ok(pages.some((x) => x.fullBleed), '没有任何整页铺满的页面')
    assert.ok(pages.some((x) => !x.fullBleed && x.maxWs.length > 0), '没有任何居中内容的页面')
  })
})

describe('顶栏只有一种宽度：通栏', () => {
  test('AppNavbar 的内层容器是静态类，且通栏', () => {
    const t = templateOf(NAVBAR)
    const nav = t.slice(t.indexOf('<nav'), t.indexOf('</nav>'))

    // 关键的一条：**静态** class，不是 :class 绑定的。
    // 两种样式的根源就是那一句 `:class="fluid ? … : …"`；只要它还在，
    // 「两种宽度」就还能被重新引入 —— 哪怕所有调用点都不传 fluid。
    const firstDiv = /<div\b([^>]*)>/.exec(nav)
    assert.ok(firstDiv, 'nav 里没有 div —— 切法变了，这条要跟着改')
    assert.doesNotMatch(
      firstDiv[1],
      /:class/,
      'nav 的内层容器不能用 :class 切宽度 —— 那是两种样式的根源。' +
        '要通栏就直接写死，通栏是唯一的口径'
    )

    const attr = /class="([^"]*)"/.exec(firstDiv[1])
    assert.ok(attr, 'nav 的内层容器没有 class 属性')
    const tokens = attr[1].split(/\s+/)
    assert.ok(tokens.includes('w-full'), `顶栏内容必须通栏（w-full），现有：${attr[1]}`)

    // 有 max-w-* 就是「居中那种」回来了
    const ws = tokens.filter((t2) => t2.startsWith('max-w-'))
    assert.deepEqual(ws, [], `顶栏内层不该有宽度上限：${ws.join(' ')}`)
  })

  test('fluid prop 删干净了', () => {
    assert.doesNotMatch(
      scriptOf(NAVBAR),
      /fluid/,
      'fluid 必须删干净 —— 留着 prop 就留着「两种样式」这个选项'
    )
  })

  test('没有任何页面再给顶栏传 fluid', () => {
    // prop 删了但模板还在传的话，Vue 会把它当 fallthrough attribute 落到
    // <nav> 上：界面上看不出差别，而源码里已经是一句骗人的话。
    for (const x of pages) {
      assert.ok(
        !x.passesFluid,
        `${x.p} 还在给 <AppNavbar> 传 fluid —— prop 已删除，这只是落到 <nav> 上的无意义属性`
      )
    }
  })

  test('带 #extra 插槽的两处顶栏都写成了不带 prop 的 <AppNavbar>', () => {
    // 第一版这条是**假绿**：写成 `/<AppNavbar>\s*<template #extra>/`，而 index.vue
    // 有两处 #extra 插槽（第 15 行带 fluid、第 145 行不带），于是它匹配上了
    // 第二处，绿了 —— 而它本该红。index.vue 有两个 v-if 分支各放一条顶栏，
    // 「只改其中一处」是这个页面最容易犯的错。
    //
    // 所以改成配对计数：插槽有几处，不带 prop 的写法就得有几处。
    const x = pages.find((p) => p.p === 'index.vue')
    assert.ok(x, '没扫到 index.vue')
    const slots = (x.t.match(/<template #extra>/g) || []).length
    assert.ok(slots >= 2, `index.vue 的 #extra 插槽数变成 ${slots} 了 —— 这条要跟着改，否则是空断言`)
    const bare = (x.t.match(/<AppNavbar>\s*<template #extra>/g) || []).length
    assert.equal(
      bare,
      slots,
      `index.vue 有 ${slots} 处 #extra 插槽，却只有 ${bare} 处写成了不带 prop 的 <AppNavbar> —— ` +
        '其中一处还带着 fluid。它不会被单独指出来，而首页顶栏会因此变居中'
    )
  })
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
      const ws = tokens.filter((t2) => t2.startsWith('max-w-'))
      assert.deepEqual(ws, ['max-w-7xl'], `${rel} 的 <main> 上有多个宽度上限：${ws.join(' ')}`)
    }
  })

  test('全仓库没有 max-w-6xl（它就是 bucket 自创的那个宽度）', () => {
    // 正向钉住「宽容器只有一种口径」之后，再从反面确认一次：
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
