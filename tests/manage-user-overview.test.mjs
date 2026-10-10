// 用户管理页「概览」面板：两个环 + 一份共用图例。
//
// ## 数据从哪来（这一条决定了要不要动服务端）
//
// `/api/manage/listUsers` **已经**返回每个用户的 `usedStorage` / `maxStorage`
// / `usedDownload` / `maxDownload`（listUsers.get.ts:48），而且它没有
// LIMIT/OFFSET，返回的是**全部**用户。所以环是纯前端的事，一个新接口都不用。
//
// 面板里原有的「用户总数」也来自同一个响应，所以环跟着搜索框一起变是**一致**
// 的行为，不是新引入的不一致。
//
// ## 求和不重复计算（这一条差点搞错）
//
// 一度怀疑「各用户 usedStorage 加起来」会重复：`sub-account.ts:88` 里父账户的
// 池子是 `own + SUM(children)`。但每个用户的行只存自己那一份，子账户的用量
// 记在子账户行上（`reserveStorage` 更新的是 `s.id = 子账户`），所以按用户求和
// 是对的。生产库当前也没有任何父子关系。
//
// ## 分母只能是已用量的和
//
// `maxStorage` / `maxDownload` 为 0 表示不限（开发库有三个用户是 0），
// `usedDownload` 是累计字节不是次数 —— 所以「容量」不是一个有定义的总量，
// 环的整圈只能是各用户已用量的和。这条由 donut-utils 的测试兜着。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from '@vue/compiler-sfc'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = 'app/pages/manage/user.vue'
const CHART = 'app/components/DonutChart.vue'

function codeOnly(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*[*]/.test(l))
    .join('\n')
}

function parts(p) {
  const { descriptor, errors } = parse(readFileSync(join(root, p), 'utf8'), { filename: p })
  assert.equal(errors?.length ?? 0, 0, `${p} SFC 解析出错 —— 测试的输入本身有问题`)
  return {
    t: codeOnly(descriptor.template?.content ?? ''),
    s: codeOnly(descriptor.scriptSetup?.content ?? '')
  }
}

const page = () => parts(PAGE)
const chart = () => parts(CHART)

describe('自检（防恒真）', () => {
  test('概览面板确实在 manage/user.vue（路径写错就全绿）', () => {
    assert.match(page().t, /概览/, '没找到概览面板')
  })

  test('DonutChart 自己不画图例（颜色由父组件统一给，两环才能同色）', () => {
    // 图例画在页面里、每个环一份。合**共用颜色**是关键：各画各的图例时，
    // 同一个用户在左边是蓝色、右边是橙色，一眼扫过去会以为是两个人。
    // 所以 chartColors 必须由 assignColors 从**两个环**一起分配。
    const c = chart()
    assert.doesNotMatch(c.t, /legend|图例/, 'DonutChart 不该自带图例')
    assert.match(c.s, /colors/, '颜色必须由父组件传入')
  })
})

describe('概览面板：两个环并排', () => {
  test('rings 恰好两个：存储与下载', () => {
    // 断言的是**数据**（两个环各是什么指标），不是模板里出现几颗 <DonutChart>。
    // 第一版数模板里的标签个数，于是我改用 v-for 渲染两个环时它就红了 ——
    // 它量的其实是我怎么写的模板，不是「面板上有两个环」这件事。
    const s = page().s
    const at = s.indexOf('const rings = computed')
    assert.ok(at > 0, '找不到 rings')
    const body = s.slice(at, at + 400)
    assert.match(body, /存储空间/, 'rings 里要有存储')
    assert.match(body, /下载流量/, 'rings 里要有下载')
    const titles = [...body.matchAll(/title:\s*'([^']+)'/g)].map((m) => m[1])
    assert.deepEqual(titles, ['存储空间', '下载流量'], '恰好两个环，顺序为存储 → 下载')
    assert.match(body, /storageDonut\.value/, '存储环取 storageDonut')
    assert.match(body, /downloadDonut\.value/, '下载环取 downloadDonut')
  })

  test('两个环共用同一份 colors（这是「同用户同色」的全部机制）', () => {
    const t = page().t
    const tags = [...t.matchAll(/<DonutChart\b[\s\S]{0,400}?\/>/g)].map((m) => m[0])
    assert.equal(tags.length, 1, '模板里应只有一颗 DonutChart（由 v-for 渲染两次）')
    // v-for 在**外层容器**上，不在 DonutChart 自己身上 —— 第一版把两者当成
    // 同一个标签，于是对着正确的实现报红。
    const vAt = t.indexOf('v-for="ring in rings"')
    const cAt = t.indexOf('<DonutChart')
    assert.ok(vAt >= 0, '两个环应由 rings 渲染')
    assert.ok(vAt < cAt, 'DonutChart 必须落在 v-for 出来的容器里')
    assert.match(tags[0], /:slices="ring\.slices"/, '它取的是当前 ring 的切片')
    const binds = [...t.matchAll(/colors="([^"]+)"/g)].map((m) => m[1])
    assert.deepEqual(binds, ['chartColors'], '颜色只能来自共用的 chartColors')
  })

  test('颜色由 assignColors 从两个环的切片一起分配', () => {
    const s = page().s
    assert.match(s, /assignColors\(/, '必须用 assignColors 统一分配')
    // 传的是**两个**环，不能只传存储那个 —— 只传一个的话，下载环里排在前面的
    // 用户会拿到自己的颜色，于是同用户在两环不同色。
    const at = s.indexOf('assignColors(')
    const body = s.slice(at, at + 200)
    assert.match(body, /storageDonut[^)]*downloadDonut/, '必须把两个环都传进去')
  })
})

describe('DonutChart 本身的几处硬约束', () => {
  // 这三条都对应一个**曾经写错过的具体实现**，不是「预防性」的断言。
  test('不许用描边盖出分隔缝（那一圈会把整条环带覆盖）', () => {
    // 常见做法是叠一圈白描边制造切片间隙，但那一圈要落在 r=(OUTER+INNER)/2、
    // 线宽=OUTER-INNER 上 —— 正好把 OUTER..INNER 整条带子盖住，所有扇形全没。
    // 我第一版就是这么写的，肉眼才看出来。所以钉死。
    assert.doesNotMatch(
      chart().t,
      /stroke-width/,
      '不许叠描边来分隔切片 —— 那会盖住整条环带（第一版就犯过）'
    )
  })

  test('外半径必须大于内半径', () => {
    const s = chart().s
    const outer = Number(/const OUTER = (\d+(?:\.\d+)?)/.exec(s)?.[1])
    const inner = Number(/const INNER = (\d+(?:\.\d+)?)/.exec(s)?.[1])
    assert.ok(Number.isFinite(outer) && Number.isFinite(inner), `解析不到 OUTER/INNER：${s.slice(0, 0)}`)
    assert.ok(outer > inner, `OUTER(${outer}) 必须大于 INNER(${inner}) —— 反了会画成自相交图形`)
  })

  test('空状态的占位圈与环同尺寸（否则数据加载完面板会跳一格）', () => {
    const s = chart().s
    const outer = Number(/const OUTER = (\d+(?:\.\d+)?)/.exec(s)?.[1])
    const empty = /<circle[^>]*v-if="!slices\.length"[^>]*>/.exec(chart().t)?.[0]
    assert.ok(empty, '全部为零时要有一个占位圈，不能是一片空白')
    const r = Number(/r="(\d+(?:\.\d+)?)"/.exec(empty)?.[1])
    assert.equal(r, outer, `占位圈半径 ${r} 必须等于 OUTER(${outer})，否则 svg 高度会跳`)
  })
})

describe('概览面板：rings 恰好两个', () => {
  test('图例跟着各自的环（同一份 colors 让同用户在两个环里同色）', () => {
    const t = page().t
    assert.match(t, /v-for="s in ring\.slices"/, '图例要循环自己的切片')
    assert.match(t, /backgroundColor/, '色块颜色取自共用的 chartColors')
    assert.match(t, /chartColors\[s\.key\]/, '色块必须按切片 key 取色，不能写死')
  })

  test('零值用户不进环，但要说清有多少个', () => {
    // 零值若进环，每个都「小于 2%」，全被折进「其他」，得到一条
    // 「其他: 0 B，占 0%」—— 而且把「有 6 个用户在用」这件事藏起来了。
    // zeroCount 只在模板里出现就够了 —— script 不需要知道它。
    assert.match(page().t, /storageDonut\.zeroCount/, '模板要读 zeroCount')
    assert.match(page().t, /个用户没有用量/, '界面上要说出「有几个用户没有用量」')
  })

  test('没有任何用量时给空状态，不画空环', () => {
    assert.match(chart().t, /还没有用量/, '空状态文案')
    assert.match(chart().t, /v-if="!slices\.length"/, '空状态必须挂在 slices 为空上')
  })

  test('用户总数与最近刷新仍在（原有内容不许被环挤掉）', () => {
    const t = page().t
    assert.match(t, /用户总数/, '用户总数要保留')
    assert.match(t, /最近刷新/, '最近刷新要保留')
  })
})

describe('概览面板：数据来源不新增接口', () => {
  test('环的数据来自已加载的 users，不发第二个请求', () => {
    const s = page().s
    assert.match(s, /usedStorage/, '要用 usedStorage')
    assert.match(s, /usedDownload/, '要用 usedDownload')
    // 直接数端点字符串出现次数。
    // 第一版用 `\$fetch[^;]*?['"]\/api\/[^'"]+['"]/g` 去匹配调用，然后卡在
    // 0 —— 因为 `[^;]*?` 撞上了 TypeScript 类型字面量里的分号
    // （`$fetch<{ users: ApiUser[]; totalCount: number }>`）。测接口调用次数
    // 不该去匹配调用语法。
    const calls = [...s.matchAll(/\/api\/manage\/listUsers/g)]
    assert.equal(calls.length, 1, 'listUsers 只能调一次 —— 两个环必须用同一份数据')
  })

  test('空/脏数据不会让环崩掉（total 为 0 是常态，不是异常）', () => {
    const s = page().s
    assert.match(s, /\?\? \[\]/, 'users 缺失时要有兜底空数组')
    assert.match(s, /buildDonut\(/, '必须走 buildDonut（它处理了 0 与负值）')
  })
})
