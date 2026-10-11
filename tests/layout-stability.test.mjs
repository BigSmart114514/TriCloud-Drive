// 布局稳定性：滚动条预留 + 两个管理页的骨架屏。
//
// ## 症状一：加载完右边的滚动条突然出现，整页抖一下
//
// 内容加载后长过视口 → 页面开始能滚 → 滚动条占掉 10px（实验主题）或约 15px
// （默认主题）→ **整个视口的宽度变了**，于是所有横向位置向左移一截。
//
// 全站原本一处 `scrollbar-gutter` 都没有。这条属性就是为「稍后会出现的东西」
// 预留位置的：它让凹槽**一直**存在，于是宽度不再变。
//
// 关键是这条规则必须**不在主题作用域里**。experimental.css 整份都挂在
// `html[data-ui='experimental']` 下面，而实验主题是**可选开关**（默认关闭）——
// 规则写在那里的话，默认模式下照样抖。所以它得进一份基础样式表，且不能被
// 主题选择器包住。这条断言就是防「顺手挪进 experimental.css」。
//
// ## 症状二：没有加载动画，而且加载态本身在骗人
//
// 8 个文件里 10 处是纯文字「正在加载…」，用户管理与存储桶管理这两页尤其糟：
//
//   · 概览面板加载中时，两个环按「0 用量」渲染（真的 0 与还没加载长得一样），
//     加载完再长出环与图例 —— 高度跳两跳。
//   · 存储桶管理的「清理历史」**根本没有加载态**，`onMounted` 立刻显示
//     「还没有任何清理记录。」，请求回来之后才变成表格。那句话在请求返回前
//     是**假的**，而且假得很有自信。
//
// 骨架屏占住**最终高度**时，两个问题一起解决：给了反馈，也顺手消掉了高度跳变。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from '@vue/compiler-sfc'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

function codeOnly(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*[*]/.test(l))
    .join('\n')
}

function parts(p) {
  const { descriptor, errors } = parse(read(p), { filename: p })
  assert.equal(errors?.length ?? 0, 0, `${p} SFC 解析出错 —— 测试的输入本身有问题`)
  return { t: codeOnly(descriptor.template?.content ?? ''), s: codeOnly(descriptor.scriptSetup?.content ?? '') }
}

/**
 * 剥掉 CSS 注释。注释不影响层叠，拿它当选择器或声明来分析会得出错误结论。
 *
 * 这不是预防性的洁癖：**这份文件自己就踩了**。base.css 里那段解释
 * 「为什么不能挪进 experimental.css」的注释写着 `scrollbar-gutter: stable`，
 * 于是把声明改成 `auto` 之后「必须预留凹槽」那条断言照样绿。
 */
function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 剥掉 // 行注释。nuxt.config.ts 里那段讲分层的注释写着 `base.css`，
 *  于是把 css 数组里的 base.css 删掉之后「必须注册」那条照样绿。 */
function stripLineComments(src) {
  return src
    .split('\n')
    .map((l) => (/^\s*\/\//.test(l) ? '' : l.replace(/(^|\s)\/\/.*$/, '$1')))
    .join('\n')
}

const BASE_CSS = 'app/assets/css/base.css'
const SKELETON = 'app/components/UiSkeleton.vue'
const USER_PAGE = 'app/pages/manage/user.vue'
const BUCKET_PAGE = 'app/pages/manage/bucket.vue'

describe('滚动条凹槽：预留，不许挪进主题里', () => {
  test('基础样式表存在，且两个样式表都注册了', () => {
    // 全部在**剥掉注释**之后的文本上找。nuxt.config.ts 里讲分层的那段注释
    // 本身就写着 base.css —— 不剥的话，它就是文件里第一个 base.css，
    // 于是「必须注册」这条断言对着一个被删掉的注册照样绿。
    //
    // **不**断言 base.css 排在 experimental.css 前面：第一版写了 `base < theme`，
    // 变异扫描的 B 段立刻报「守卫过紧」。查过了，那两份文件**没有任何选择器
    // 重叠**（base 只管 scrollbar-gutter 与 reduced-motion，主题只管滚动条外观），
    // 所以顺序不影响层叠。把它写成断言等于把一条约定升级成硬约束 ——
    // 哪天有人调换顺序，测试红了而界面没有任何变化。分层这件事记在
    // nuxt.config.ts 的注释里就够了。
    const nuxt = stripLineComments(read('nuxt.config.ts'))
    assert.ok(nuxt.indexOf('base.css') > 0, "nuxt.config.ts 的 css 数组里没有 base.css —— 写了也不生效")
    assert.ok(nuxt.indexOf('experimental.css') > 0, 'nuxt.config.ts 的 css 数组里没有 experimental.css')
  })

  test('html 上声明了 scrollbar-gutter: stable', () => {
    // 同理：base.css 的注释里有一句「`scrollbar-gutter: stable` 让那道凹槽…」
    const css = stripCssComments(read(BASE_CSS))
    assert.match(css, /scrollbar-gutter:\s*stable/, '必须预留凹槽')
    assert.match(css, /(^|[\s,}])(html|:root)\s*\{/, '必须挂在 html 或 :root 上')
  })

  test('这条规则**不在**主题作用域里（否则默认模式下照样抖）', () => {
    // experimental.css 整份都在 html[data-ui='experimental'] 下面，而实验主题
    // 是默认关闭的可选开关。把规则挪进去 = 默认模式继续抖，而实验模式正常 ——
    // 也就是说只在你自己开了开关时才不抖。
    //
    // 先剥 CSS 注释：base.css 里那段解释「为什么不能挪进 experimental.css」
    // 的注释本身就写着 html[data-ui='experimental']，而注释不影响层叠。第一版
    // 没剥，于是对着正确的规则报红。
    const css = stripCssComments(read(BASE_CSS))
    const at = css.indexOf('scrollbar-gutter')
    assert.ok(at > 0, '没找到 scrollbar-gutter')
    const blockStart = css.lastIndexOf('{', at)
    const selector = css.slice(css.lastIndexOf('}', blockStart) + 1, blockStart)
    assert.ok(
      !selector.includes('[data-ui'),
      `这条规则被包在「${selector.trim()}」里 —— 主题是可选开关，默认模式下这条不生效`
    )
    assert.match(selector.trim(), /(^|[\s,}])(html|:root)\s*$/, `选择器不只一个：${selector.trim()}`)
  })

  test('base.css 里不重复实验主题的滚动条外观（那是主题的活）', () => {
    // 只管「有没有凹槽」，不管凹槽长什么样。外观是 experimental.css 的职责，
    // 两边都写就会互相覆盖，而且覆盖顺序还依赖 css 数组的顺序。
    assert.doesNotMatch(stripCssComments(read(BASE_CSS)), /::-webkit-scrollbar/, '滚动条外观留给 experimental.css')
  })
})

describe('骨架屏组件', () => {
  /** 取出 variant 那个 <div> 自身的开始标签 */
  function rootDivTag(t) {
    const m = /<div\b[^>]*>/.exec(t)
    assert.ok(m, '骨架组件的根 div 不见了')
    return m[0]
  }

  test('存在，且有 text / circle 两种形态', () => {
    const s = parts(SKELETON)
    assert.match(s.s, /variant/, '必须有 variant')
    assert.match(s.s, /text/, '要有文字条形态')
    assert.match(s.s, /circle/, '要有圆形形态（概览面板那两个环）')
  })

  test('圆形形态真的变成圆的（只在根 div 的 class 上）', () => {
    // 第一版只断言「script 里出现过 circle」—— 把 rounded-full 去掉照样绿。
    // 要问的是「圆那个分支产出的是不是圆」。
    const tag = rootDivTag(parts(SKELETON).t)
    assert.match(tag, /'circle'/, '根 div 必须按 variant 分支')
    assert.match(tag, /rounded-full/, "variant==='circle' 时要 rounded-full —— 否则环的占位是方块")
  })

  test('用 animate-pulse（这是全站唯一会用的动画语义）', () => {
    assert.match(rootDivTag(parts(SKELETON).t), /animate-pulse/, '骨架要有呼吸感')
  })

  test('颜色走 bg-gray-200 —— 两种主题下都已经被接管', () => {
    // experimental.css 里 .bg-gray-200 被覆盖成半透明白，所以这一条在
    // 「液态玻璃」和默认两个模式下都成立，不必各写一套。
    assert.match(rootDivTag(parts(SKELETON).t), /bg-gray-200/, '骨架底色用 bg-gray-200')
  })
})

describe('用户管理页：加载时不许说「没有」', () => {
  test('概览面板有骨架分支', () => {
    const t = parts(USER_PAGE).t
    // 「用户总数」那个骨架：锚在它**自己**的那一段上。
    // 第一版断言「模板里有 <UiSkeleton」就算过，于是把「总数直接显示 0」这条
    // 违规也放过 —— 页面上还有另外两处骨架在，那个断言压根没被碰到。
    const count = t.indexOf('width="3.5rem"')
    assert.ok(count > 0, '用户总数处要有骨架')
    const region = t.slice(Math.max(0, count - 200), count + 200)
    assert.match(region, /<UiSkeleton[^>]*v-if="loading"/, '它必须由 loading 把门')
    assert.match(region, /v-else/, '加载中不能显示数字 —— 真的 0 和还没加载长得一样')
  })

  test('环区在加载中走骨架分支', () => {
    // 同理：环区那个分支必须自己判 loading，不能靠页面上别处的 v-if 蒙混过关。
    const t = parts(USER_PAGE).t
    const ring = t.indexOf('variant="circle"')
    assert.ok(ring > 0, '环区要有圆形骨架')
    // 找**开着这批圆形骨架的那个** v-if，而不是页面上第一个 v-if="loading"
    // （用户总数那个在它上面 20 行）。
    const openAt = t.lastIndexOf('<div v-if="loading"', ring)
    assert.ok(openAt > 0, '找不到环区的加载分支')
    assert.ok(ring - openAt < 400, `圆形骨架离它的 v-if 有 ${ring - openAt} 字符 —— 不是同一个分支`)
    // 真实内容必须是同一条链上的 v-else，方向在骨架**之后**（第一版只看之前，
    // 于是对着正确实现报红）。
    assert.match(
      t.slice(ring, ring + 900),
      /<div v-else\b/,
      '环区的真实内容必须是同一个链上的 v-else —— 否则加载中会画出两个空环并说「还没有用量」'
    )
  })

  test('概览面板为骨架预留了高度（min-h），不是让它自己撑', () => {
    const t = parts(USER_PAGE).t
    // 锚在**环区那个**圆形骨架上。第一版用 `<UiSkeleton` 的首次出现当锚点，
    // 而那一处是「用户总数」的小方块，离环区的 min-h 有一屏远 —— 于是对着
    // 正确实现报红。锚点必须是被测的那一个。
    const ring = t.indexOf('variant="circle"')
    assert.ok(ring > 0, '环区要有圆形骨架')
    const region = t.slice(Math.max(0, ring - 600), ring + 600)
    assert.match(region, /min-h-/, '环区要预留高度，否则数据回来时图例长出来、下面整体下移')
  })

  test('用户列表加载中出骨架行，而不是一行「正在加载」', () => {
    const t = parts(USER_PAGE).t
    // 锚在这一行自己的 <tr> 上。「页面上有 v-for 循环」和「有 variant=text 的
    // UiSkeleton」这两条第一版都写成全页搜索，于是把行换回 colspan 单行之后
    // 照样绿 —— 因为环区的骨架也有 v-for。
    const row = t.indexOf('<tr v-if="loading">')
    assert.ok(row > 0, '列表的加载分支不见了')
    const region = t.slice(row, t.indexOf('</tr>', row))
    assert.match(region, /v-for="n in 6"/, '骨架行数写死（行数变了高度就变）')
    assert.match(region, /<UiSkeleton/, '行内必须是骨架')
    assert.doesNotMatch(region, /colspan/, '不能退回一行 colspan 的文字 —— 高度从 6 行掉到 1 行')
  })

  test('不再有纯文字的「正在加载用户数据...」', () => {
    assert.doesNotMatch(
      parts(USER_PAGE).t,
      /正在加载用户数据/,
      '纯文字换成骨架 —— 顺带它还占不住高度'
    )
  })
})

describe('存储桶管理页：清理历史不许在请求返回前说「没有」', () => {
  test('purgeLogLoading 会真的落回 false（否则清理历史永远是骨架）', () => {
    // 只断言「有这个变量」不够：写成 ref(!!0) 的话变量在、清空分支也永远不显示。
    const s = parts(BUCKET_PAGE).s
    assert.match(s, /const purgeLogLoading = ref\(true\)/, '初始为 true')
    assert.match(s, /finally\s*\{[\s\S]{0,200}?purgeLogLoading\.value = false/, '必须在 finally 里落回 false')
  })

  test('空状态在加载中不显示', () => {
    // 原来只有 `v-if="!purgeLog.length"`，而请求还没回来时长度确实是 0 ——
    // 于是「还没有任何清理记录。」在加载期间是**假的**。
    const t = parts(BUCKET_PAGE).t
    const at = t.indexOf('还没有任何清理记录')
    assert.ok(at > 0, '找不到那句空状态')
    // 结构上的判据：它是 v-else-if，且同一个链上前面是 v-if="purgeLogLoading"。
    // 第一版用「前 300 字符里有没有 purgeLogLoading」来判，而那一句在 400 字符外 ——
    // 于是对着正确实现报红。
    const region = t.slice(Math.max(0, at - 600), at)
    assert.match(region, /v-if="purgeLogLoading"/, '加载分支必须排在空状态前面')
    const openTag = /<p\s[^>]*>/.exec(region.slice(region.lastIndexOf('<p')))
    assert.ok(openTag, '找不到承载空状态的那个 <p>')
    assert.match(
      openTag[0],
      /v-else-if/,
      '空状态必须是 v-else-if —— 用 v-if 的话加载期间它会自己冒出来'
    )
  })

  test('清理历史有骨架，且预留高度', () => {
    const t = parts(BUCKET_PAGE).t
    assert.match(t, /<UiSkeleton/, '清理历史加载中要出骨架')
    const at = t.indexOf('<UiSkeleton')
    const region = t.slice(Math.max(0, at - 400), at + 400)
    assert.match(region, /min-h-/, '要预留高度，否则表格长出来时下面整体下移')
  })
})
