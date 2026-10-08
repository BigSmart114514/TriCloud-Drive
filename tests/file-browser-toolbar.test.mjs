// 标题栏（FileBrowser 顶部那一行）在「文件夹名字很长」时的排版。
//
// ## 缺陷现场
//
// 截图里两层症状：
//   ① 面包屑里的长文件夹名没有变成「…」，而是把整行的宽度吃光
//   ② 紧挨着的「已复制 1 项」被压成一列竖着的字（每字一行）
//
// 根因是同一个，但它有两处，都得钉：
//
//   ① <nav> 上写着 `max-w-[60vw] sm:max-w-none`。sm: 断点（≥640px）把宽度上限
//      **整个撤掉**，于是 nav 的宽度 = 内容宽度 = 那个长名字的全宽。
//      而工具栏那一行在 fill 模式下是 `shrink-0`（不换行），所以长名字只能去
//      挤右边那组按钮。
//
//   ② 右边那组 div 没有 shrink-0，`{ clipboardActionLabel } { clipboardCount } 项`
//      这个 span 也没有 whitespace-nowrap。中文任意两字之间都能断行，于是空间
//      不足时它不是溢出、而是「一个字符一行」竖着排。
//
// 为什么这条只能源码断言：项目没有 @vue/test-utils / happy-dom，组件挂载不了，
// 也没有 Playwright（见 share-bulk-wiring.test.mjs 开头那段同样的说明）。
// 代价要写明白：**这份测试测的是「CSS 类有没有写在对的元素上」，不是「渲染出来
// 好不好看」**。真好不好看仍然得在浏览器里看一眼 —— 这份测试只保证下次改动不会
// 把已经修好的那两行悄悄改回去。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from '@vue/compiler-sfc'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const BROWSER = 'app/components/FileBrowser.vue'

/**
 * 去掉注释，免得注释里提到的东西把判定带偏。
 *
 * 三种都要去：JS 块注释、JS 行注释，**以及 Vue 模板里的 HTML 注释**。
 *
 * 少去一种就出真事故：FileBrowser 里那个 nav 上方就有一段 HTML 注释写着
 * 「overflow-x-auto + whitespace-nowrap」「max-w-[60vw]」—— 只去前两种的话，
 * 把这三个类从 nav 上删掉，断言照样绿（注释里还有一份）。这不是「测得宽松」，
 * 这叫**测的是注释**。所以 HTML 注释必须一起去，并由下面「切片自检」里那条
 * 反向断言盯着。
 */
function codeOnly(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*[*]/.test(l))
    .join('\n')
}

/** 顶层 <template>。嵌套 template（v-for 里的）会让正则非贪婪提前收尾 */
function templateOf(src) {
  const { descriptor, errors } = parse(src, { filename: 'x.vue' })
  assert.equal(errors?.length ?? 0, 0, 'SFC 解析出错 —— 测试的输入本身有问题')
  return codeOnly(descriptor.template?.content ?? '')
}

const tpl = templateOf(read(BROWSER))

/** 未去注释的模板 —— 只给「注释确实被去掉了」那条自检做对照 */
const rawTpl = (() => {
  const { descriptor, errors } = parse(read(BROWSER), { filename: 'x.vue' })
  assert.equal(errors?.length ?? 0, 0, 'SFC 解析出错 —— 测试的输入本身有问题')
  return descriptor.template?.content ?? ''
})()

/**
 * 一个 div 开闭标签（自闭合的 `<div … />` 也会被匹配上，由调用处处理）。
 *
 * `[^>]*` 而不是 `[\s\S]*?`：属性值里没有 `>`，够用；写成非贪婪跨行反而会在
 * 遇到下一个 `>` 时截断。
 */
const DIV_TAG = /<(\/?)div\b[^>]*>/g

/** 从某个标记往前找最近的 `<div`，再往后配平 —— 用来精确定位「装着它的那个 div」 */
function ownerDivOf(tplText, marker) {
  const at = tplText.indexOf(marker)
  assert.ok(at > 0, `模板里找不到标记 ${marker} —— 锚点没了，下面所有断言都会是恒真`)
  const open = tplText.lastIndexOf('<div', at)
  assert.ok(open >= 0, `${marker} 前面没有 <div`)
  // 从 open 开始数 div 的开闭，取到配平的那个结束标签
  const rest = tplText.slice(open)
  let depth = 0
  for (const m of rest.matchAll(DIV_TAG)) {
    const isClose = m[1] === '/'
    const selfClosing = !isClose && m[0].endsWith('/>')
    if (selfClosing) continue
    depth += isClose ? -1 : 1
    if (depth === 0) return rest.slice(0, m.index + m[0].length)
  }
  throw new Error(`${marker} 所在的那个 <div> 没配平`)
}

/** 取装着 marker 的那个元素自身的开始标签 */
function ownTagOf(tplText, tagName, marker) {
  const at = tplText.indexOf(marker)
  assert.ok(at > 0, `模板里找不到标记 ${marker} —— 锚点没了，下面所有断言都会是恒真`)
  const open = tplText.lastIndexOf(`<${tagName}`, at)
  assert.ok(open >= 0, `${marker} 前面没有 <${tagName}`)
  const m = new RegExp(`<${tagName}\\b[^>]*>`).exec(tplText.slice(open))
  assert.ok(m, `<${tagName} 的开始标签没读完（marker=${marker}）`)
  return m[0]
}

/** <nav> 自身（到 </nav> 为止） */
const navTag = (() => {
  const a = tpl.indexOf('<nav')
  assert.ok(a > 0, '模板里没有 <nav> —— 面包屑被挪走了，下面所有断言都会是恒真')
  const b = tpl.indexOf('</nav>', a)
  assert.ok(b > a, '<nav> 没有闭合')
  return tpl.slice(a, b)
})()

/** 面包屑里点一下跳一级的那颗按钮。
 *
 *  锚点刻意**不用** `@click` / `:title` / `:disabled` 里的任何一个：这三个属性
 *  各自都是被断言的对象，拿它们当锚点的话，「把 @click 删了」这种变异会先
 *  把切片打瞎（找不到锚点 → 整个文件死），而不是老老实实地让一条断言红。
 *  所以按**结构**定位：nav 里的第一颗 button。
 */
const crumbButton = (() => {
  const m = /<button\b[^>]*>/.exec(navTag)
  assert.ok(m, 'nav 里没有 <button> —— 面包屑的跳转按钮没了，下面所有断言都会是恒真')
  return m[0]
})()

/** 右边那组按钮（「返回上一级」…「刷新」…） */
const toolbarActions = ownerDivOf(tpl, 'aria-label="返回上一级"')

/** 左边那组（复选框 + 标题 + 面包屑） */
const toolbarTitle = ownerDivOf(tpl, 'ref="masterCheckboxRef"')

/**
 * 上面两组的**开始标签**本身。
 *
 * 要这两个而不是只用子树切片：`flex-1` / `shrink-0` / `min-w-0` 这几个类在
 * 子树里**别处也有**（nav 自己也带 min-w-0，标题带 shrink-0）。拿子树去断言，
 * 会出现「左边那组摘掉 min-w-0，但 nav 的 min-w-0 顶上了 → 照样绿」——
 * 断言看着在管左边那组，实际量的是它的某个后代。
 */
const leftGroupTag = ownTagOf(tpl, 'div', 'ref="masterCheckboxRef"')
const rightGroupTag = ownTagOf(tpl, 'div', 'aria-label="返回上一级"')

assert.notEqual(leftGroupTag, rightGroupTag, '左右两组被切成了同一个 div —— 锚点撞了')

/** 「已复制 N 项」那个文字块 */
const clipboardLabel = (() => {
  const anchor = 'clipboardActionLabel'
  return ownTagOf(tpl, 'span', anchor)
})()

/**
 * 自检：上面四个切片必须**互不重叠、且各自只含自己那部分**。
 *
 * 不做这一步，上面每条断言都可能退化成「在整个文件里搜一个字符串」——
 * 那种断言恒真，等于没测。这里靠两个「不该出现的锚点」把边界钉死：
 *   nav 切片里不能有标题（<h3>）和右侧按钮
 *   toolbarActions 切片里不能有面包屑的跳转按钮
 */
describe('切片自检（防恒真）', () => {
  test('HTML 注释真的被去掉了（双向：raw 里有、tpl 里没有）', () => {
    // 正向：原始模板里确实有 HTML 注释 —— 否则下面那条等于恒真
    //（「本来就没有注释」也会让「去掉了」成立）。
    assert.ok(
      rawTpl.includes('<!--'),
      'FileBrowser.vue 的模板里一条 HTML 注释都没有？那这条自检是空的，去查 codeOnly'
    )
    // 反向：处理之后一条都不剩
    assert.ok(
      !tpl.includes('<!--') && !tpl.includes('-->'),
      'codeOnly 没去 HTML 注释 —— 注释里写着 shrink-0 / max-w-[60vw] 时，' +
        '下面那些断言测的就不是元素而是注释了'
    )
  })

  test('nav 切片不含标题栏右侧的东西', () => {
    assert.ok(!navTag.includes('我的文件'), 'nav 切片把 <h3> 也吃进来了 —— 切片边界错了')
    assert.ok(!navTag.includes('返回上一级'), 'nav 切片把右侧工具栏也吃进来了 —— 切片边界错了')
    assert.ok(navTag.includes('handleGoToBreadcrumb'), 'nav 切片里没有面包屑本身 —— 切片取错了')
  })

  test('toolbarActions 切片不含面包屑与标题', () => {
    assert.ok(!toolbarActions.includes('handleGoToBreadcrumb'), '右侧切片吃进了面包屑 —— 切片边界错了')
    assert.ok(!toolbarActions.includes('<h3'), '右侧切片吃进了标题 —— 切片边界错了')
    assert.ok(toolbarActions.includes('刷新'), '右侧切片里没有「刷新」按钮 —— 切片取错了')
  })

  test('toolbarTitle 切片不含右侧工具栏', () => {
    assert.ok(!toolbarTitle.includes('刷新'), '左侧切片吃进了右侧按钮 —— 切片边界错了')
    assert.ok(toolbarTitle.includes('<h3'), '左侧切片里没有标题 —— 切片取错了')
    assert.ok(toolbarTitle.includes('<nav'), '左侧切片里没有面包屑 —— 切片取错了')
  })

  test('crumbButton / clipboardLabel 切的是各自那个标签', () => {
    assert.ok(crumbButton.startsWith('<button') && crumbButton.endsWith('>'))
    assert.ok(crumbButton.includes('handleGoToBreadcrumb'), 'crumbButton 不是面包屑那颗按钮')
    assert.ok(clipboardLabel.startsWith('<span'), 'clipboardLabel 不是 span')
    assert.ok(clipboardLabel.includes('hasClipboard'), 'clipboardLabel 不是剪贴板状态那行')
  })
})

describe('① 长文件夹名要截断成「…」，不能把整行宽度吃光', () => {
  test('nav 的宽度上限在所有断点都还在（sm: 不能把上限撤掉）', () => {
    assert.match(
      navTag,
      /max-w-\[/,
      'nav 必须有宽度上限 —— 否则长名字的宽度就是整行的宽度，右侧按钮只能被挤掉'
    )
    // 双向：既要有上限，也不能有一个 sm: 变体把它撤销。
    // `sm:max-w-none` 是截图那个缺陷的原文；这里禁掉整类 sm:max-w-*，
    // 因为任何 sm:max-w-* 都能重新开一个「≥640px 时不受限」的口子。
    assert.doesNotMatch(
      navTag,
      /sm:max-w-/,
      'nav 不能有 sm:max-w-* 变体 —— 它在 ≥640px 时把上限整个撤掉，恰好是长名字把工具栏挤扁的那一步'
    )
    assert.doesNotMatch(
      navTag,
      /sm:max-w-none/,
      'sm:max-w-none 就是缺陷原文：sm 断点以上 nav 无上限'
    )
  })

  test('nav 仍然可压缩、可横向滚动（上限是给宽度兜底，不是把路径藏起来）', () => {
    assert.match(navTag, /min-w-0/, 'nav 需要 min-w-0 —— flex 子项默认 min-width:auto，压不下去')
    assert.match(navTag, /overflow-x-auto/, 'nav 必须能横向滚动 —— 层级深时不该把路径藏掉')
    assert.match(navTag, /whitespace-nowrap/, 'nav 不能换行 —— 换行会把标题栏撑高')
  })

  test('每一级面包屑自己也要有上限并 truncate（单级名字再长也不能顶满）', () => {
    assert.match(
      crumbButton,
      /truncate/,
      '面包屑按钮要 truncate —— 只有 nav 的总上限时，一级超长名字仍会把 nav 顶到 60vw'
    )
    assert.match(
      crumbButton,
      /max-w-\[[^\]]+\]/,
      '面包屑按钮要有自己的 max-w —— truncate 需要一个确定宽度才会出省略号'
    )
  })

  test('截断掉的原文要能靠 title 拿回来（否则「截断」就是信息丢失）', () => {
    assert.match(
      crumbButton,
      /:title="crumb\.name"/,
      '面包屑按钮要带 :title="crumb.name" —— 截断后悬停才看得到完整名字'
    )
  })

  test('截断不能顺手把「点面包屑跳级」改没了', () => {
    // 防的是一种「修法」：嫌名字太长，直接把 button 换成 span。
    assert.match(crumbButton, /<button\b/, '面包屑必须还是 button —— 换成 span 就点不动了')
    assert.match(crumbButton, /@click="handleGoToBreadcrumb\(idx\)"/, '跳转调用不能变')
    assert.match(
      crumbButton,
      /:disabled="idx === breadcrumbs\.length - 1"/,
      '当前这一级仍然要 disabled —— 截断改动不该碰这个判定'
    )
  })
})

describe('② 右侧工具栏不该被挤成一列竖字', () => {
  test('右侧那组按钮 shrink-0（要挤就挤面包屑，不是挤按钮和文字）', () => {
    assert.match(
      rightGroupTag,
      /shrink-0/,
      '右侧那组的 div 本身要 shrink-0 —— 缺它时空间不足会先压这一组，' +
        '「已复制 N 项」就是被压成竖排的那一个'
    )
    // 断言落在自己的开始标签上，不是子树里（子树里有别的 shrink-0 会顶替掉）
    assert.doesNotMatch(
      rightGroupTag,
      /<button/,
      'rightGroupTag 切错了 —— 它应该只是那个 div 的开始标签，不含里面的按钮'
    )
  })

  test('左侧那组 flex-1（它吃满剩余空间，被压时才只压面包屑）', () => {
    assert.match(
      leftGroupTag,
      /flex-1/,
      '左侧那组的 div 本身要 flex-1 —— 没有它，剩下的空间不会自动让给面包屑，' +
        '空间一紧就先压右侧那组（「已复制 N 项」竖排就是这么来的）'
    )
    assert.match(
      leftGroupTag,
      /min-w-0/,
      '左侧那组的 div 本身要 min-w-0 —— 压不下时就压不下去了'
    )
    // 断言落在自己的开始标签上，不是子树里（nav 自带 min-w-0，会顶替掉）
    assert.doesNotMatch(
      leftGroupTag,
      /<nav/,
      'leftGroupTag 切错了 —— 它不该包含 nav 本身'
    )
  })

  test('「已复制 N 项」那行文字 whitespace-nowrap（中文两字之间能断，不加就竖排）', () => {
    assert.match(
      clipboardLabel,
      /whitespace-nowrap/,
      '剪贴板状态文字要 whitespace-nowrap —— 中文在任意两字之间都能断行，没有它就会一个字一行竖着排'
    )
    assert.match(
      clipboardLabel,
      /v-if="hasClipboard"/,
      '这条断言要落在剪贴板状态那行上（锚点自检 —— 别改成在整行里随便找一个 span）'
    )
  })

  test('上一级的标题栏结构没被动过（面包屑仍然在标题右边、按钮组仍在面包屑右边）', () => {
    const h3 = tpl.indexOf('<h3')
    const nav = tpl.indexOf('<nav')
    const back = tpl.indexOf('aria-label="返回上一级"')
    assert.ok(h3 > 0 && nav > h3 && back > nav, '顺序应为 标题 → 面包屑 → 右侧按钮')
  })
})
