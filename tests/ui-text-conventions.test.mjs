// 界面文字的两条约定。
//
// ## 一、界面文案里不许出现 markdown 星号
//
// manage/browse.vue 里那句「…在这种状态下**不能**当成…」是把 markdown 写进了
// Vue 模板。Vue 不会解析 `**`，所以界面上就是两个星号。同一句话在
// manage/bucket.vue:103 是用 `<strong>` 写的 —— 抄的时候漏了这一步。
//
// 这条是全站通用规则，不是给某一页点的：HTML 模板里 `**` 永远是字面量。
// 判据要**先剥注释**再找 —— 否则 AppNavbar、AccountEditDialog 等处的解释性
// 注释里满是 `**`，全都会报上来（上一轮就是「注释盲视」那个坑的同一形状）。
//
// ## 二、字号下限
//
// 全站 `text-[11px]` 有 28 处，其中 14 处在两个 bucket 管理页（对象键、路径、
// 载荷快照）。`text-xs`（12px）123 处才是「次要信息」的基准字号。
//
// 12px 比 11px 看着明显干净，原因与「抗锯齿」无关：`text-[11px]` 是全站最小的
// 字号，而这批文字里有一半压在深底（`bg-gray-800`）上 —— 浅色细笔画 + 最小
// 字号 + 深底，是最难读的那种组合。11px 以下的字形细节已经落在渲染器提示信息
// 的精度边缘，加不加 `-webkit-font-smoothing` 都救不回来；而 `antialiased`
// 反而会把细笔画变淡（它是灰度抗锯齿，去子像素），多数情况下更糟。
//
// 范围只限这两个页面：ShareDialog 等地方的 `text-[11px]` 是弹窗里的密集列表，
// 另说。
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

function templateOf(absPath) {
  const { descriptor, errors } = parse(readFileSync(absPath, 'utf8'), { filename: absPath })
  assert.equal(errors?.length ?? 0, 0, `${absPath} SFC 解析出错 —— 测试的输入本身有问题`)
  return codeOnly(descriptor.template?.content ?? '')
}

const pages = walk(PAGES_DIR).map((abs) => ({ abs, p: relative(PAGES_DIR, abs), t: templateOf(abs) }))

/** 用户能读到的字符串：标签之间的文本，外加几个静态属性 */
function visibleStrings(t) {
  const out = []
  for (const m of t.matchAll(/>([^<>]+)</g)) {
    const s = m[1].trim()
    if (s && !/^\{[\s\S]*\}$/.test(s)) out.push({ s, where: '文本' })
  }
  for (const m of t.matchAll(/(?:^|\s)(title|aria-label|placeholder)="([^"]+)"/g)) {
    out.push({ s: m[2].trim(), where: m[1] })
  }
  return out
}

describe('界面文案里不许有 markdown', () => {
  test('自检：可见文本提取器真的抓得到东西', () => {
    // 不做这一步的话，下面那条可能在「什么都没提取到」的情况下恒绿。
    const all = pages.flatMap((x) => visibleStrings(x.t))
    assert.ok(all.length > 80, `只提取到 ${all.length} 条可见字符串 —— 提取器坏了`)
    assert.ok(
      all.some((x) => /[一-鿿]/.test(x.s)),
      '一条中文可见文本都没提取到 —— 提取器坏了'
    )
  })

  test('页面模板的可见文本与静态属性里没有 **', () => {
    const bad = []
    for (const x of pages) {
      for (const { s, where } of visibleStrings(x.t)) {
        if (s.includes('**')) bad.push(`${x.p}（${where}）：${s.slice(0, 60)}`)
      }
    }
    assert.deepEqual(
      bad,
      [],
      'Vue 模板不解析 markdown，`**` 会原样显示成两个星号：\n  ' + bad.join('\n  ')
    )
  })

  test('剥注释那一步是承重的（否则满屏都是解释性注释里的 **）', () => {
    // 不是「顺手写了」，是「不写就红」：AppNavbar 与 AccountEditDialog 的
    // 注释里都有 **通栏，两侧到底** 这类加粗。
    const raw = readFileSync(join(root, 'app/components/AppNavbar.vue'), 'utf8')
    const { descriptor } = parse(raw, { filename: 'AppNavbar.vue' })
    const unstripped = descriptor.template?.content ?? ''
    assert.ok(
      unstripped.includes('**'),
      'AppNavbar.vue 的模板注释里居然没有 ** 了 —— 这条自检的前提没了，去查 codeOnly'
    )
    assert.ok(
      !codeOnly(unstripped).includes('**'),
      'codeOnly 没剥掉 HTML 注释 —— 上面那条会满屏误报解释性注释里的加粗'
    )
  })
})

describe('字号下限：两个管理页不用 text-[11px]', () => {
  const TARGETS = ['manage/bucket.vue', 'manage/browse.vue']

  test('自检：目标页面确实存在', () => {
    for (const rel of TARGETS) {
      assert.ok(pages.some((x) => x.p === rel), `没扫到 ${rel}`)
    }
  })

  for (const rel of TARGETS) {
    test(`${rel} 没有小于 text-xs 的自定义字号`, () => {
      const x = pages.find((p) => p.p === rel)
      // 只查 9/10/11px 这三档：text-[8px] 之类不存在，而 12px 及以上
      // 由 Tailwind 的 text-xs/text-sm 承担，不该出现方括号写法。
      const hits = [...x.t.matchAll(/text-\[(\d+)px\]/g)].map((m) => m[1])
      assert.deepEqual(
        hits,
        [],
        `${rel} 用了 text-[${hits.join('px] text-[')}px] —— 次要信息的字号下限是 text-xs（12px）。` +
          `这批文字有一半压在 bg-gray-800 上，11px 的浅色细笔画已经落在渲染精度边缘`
      )
    })
  }
})
