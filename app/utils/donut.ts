// 环状图：分片逻辑与弧长数学。
//
// ## 为什么自己写
//
// 项目里没有图表库（package.json 里没有 chart.js / echarts / d3 / apexcharts），
// 所以环是手写 SVG。这不是缺陷 —— 环状图需要的只是「一段弧」和「按比例切」，
// 引入一个几百 KB 的库来画两个圆不划算。
//
// 但代价是这一层得自己测。好在它是**纯函数**，不碰 DOM，所以能被真正执行 —
// 而项目里没有 @vue/test-utils / happy-dom，组件一律挂载不了。
// 这一层出错的后果也是静默的：角度差一个 π/2，图照样渲染，只是一块扇形转到了
// 错误的位置。所以 tests/donut-utils.test.mjs 断言的是具体坐标与路径字符串。
//
// ## 「省略太小的」是怎么定义的
//
// 占比低于 `DEFAULT_OMIT_THRESHOLD`（2%）的切片折进一片「其他」。就这一条规则。
//
// 零值用户**不进环**，单独计数。零值若进环，每个都「小于 2%」，于是全被折进
// 「其他」，得到一条「其他: 0 B，占 0%」——那是最蠢的一种图例，而且它把「有 6 个
// 用户在用」这件事实藏起来了。
//
// ## 配额的坑：分母只能是已用量的总和
//
// `maxStorage` / `maxDownload` 为 0 表示不限（开发库里有三个用户是 0），
// 而 `usedDownload` 是累计字节不是次数。所以「容量」不是一个有定义的总量，
// 环的整圈只能是**各用户已用量的和**。

export interface DonutItem {
  /** 稳定标识。用用户 id，不要用名字 —— 名字会重复也会改 */
  key: string
  label: string
  value: number
}

export interface DonutSlice {
  key: string
  label: string
  value: number
  /** 占总量的比例，0..1。所有切片之和为 1 */
  share: number
  /** 这一片是不是「其他」合并出来的 */
  isOther: boolean
}

export interface DonutResult {
  slices: DonutSlice[]
  /** 参与计算的总量（已剔除零值） */
  total: number
  /** 用量为 0、因而不进环的用户数 */
  zeroCount: number
}

export const OTHERS_KEY = '__others__'
export const OTHERS_LABEL = '其他'
export const DEFAULT_OMIT_THRESHOLD = 0.02

/**
 * 分类色板。按顺序取，用完从尾部循环。
 *
 * 选取标准是**明度相近**（都在中段）且两两可分 —— 环状图的切片彼此紧贴，
 * 深浅差别大的色板会让人以为某一片更重要。灰是留给「其他」的，所以色板里
 * 不含灰。
 *
 * 这些都是 Tailwind 的 500 档，与界面里其它地方的状态色同源。
 */
export const DONUT_PALETTE = [
  '#6366f1', // indigo
  '#f59e0b', // amber
  '#10b981', // emerald
  '#ec4899', // pink
  '#0ea5e9', // sky
  '#f97316', // orange
  '#8b5cf6', // violet
  '#14b8a6'  // teal
] as const

/** 「其他」固定用灰：它是「不细说」，不该看起来像某个具体用户 */
export const OTHERS_COLOR = '#9ca3af'

/**
 * 给多个环分配**同一套**颜色。
 *
 * 传入的顺序即优先级：靠前出现的先拿颜色。所以典型用法是
 * `assignColors([storageDonut.slices, downloadDonut.slices])` ——
 * 存储环里排第几的，决定了它在下载环里也是第几。同一用户在两个环里同色，
 * 一眼扫过去不会以为是两个人。
 *
 * 「其他」不参与分配，用固定灰。
 */
export function assignColors(...rings: DonutSlice[][]): Record<string, string> {
  const out: Record<string, string> = {}
  let next = 0
  for (const slices of rings) {
    for (const s of slices) {
      if (s.isOther) {
        out[s.key] = OTHERS_COLOR
        continue
      }
      if (out[s.key]) continue
      // `?? OTHERS_COLOR`：tsconfig 开了 noUncheckedIndexedAccess，按下标取值
      // 的类型是 `string | undefined`。循环取模理论上不会越界，但类型不认。
      out[s.key] = DONUT_PALETTE[next % DONUT_PALETTE.length] ?? OTHERS_COLOR
      next += 1
    }
  }
  return out
}

const TAU = Math.PI * 2

/** SVG 路径取整到 3 位小数：路径短、可读、可 diff，断言也能逐字比对 */
const round3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * 极坐标 → 直角坐标。
 *
 * **0 弧度在 12 点方向，正角度顺时针增大**（与 SVG 的 y 轴朝下一致，
 * 所以 y 那里是减 cos）。
 *
 * 之所以自己定义而不用 CSS/SVG 的 rotate：起始角在正上方时，两种坐标系的换算
 * 差一个 π/2，而错的 π/2 画出来仍然是个扇形 —— 只是每个用户被转到了旁边那个
 * 用户的角度上，而截图上完全看不出问题。
 */
export function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angle: number
): { x: number; y: number } {
  return {
    x: round3(cx + radius * Math.sin(angle)),
    y: round3(cy - radius * Math.cos(angle))
  }
}

/**
 * 一段圆环扇形的 SVG 路径。
 *
 * @param startAngle 起始角（弧度，0 = 12 点方向）
 * @param endAngle   结束角（弧度，顺时针）
 *
 * 外弧 sweep=1（顺时针）、内弧 sweep=0（逆时针回来），这样路径才是简单闭合的。
 *
 * **整圆必须拆成两个半圆**：SVG 的 A 指令画不出首尾重合的整圆，那样会得到一条
 * 空路径（一个都不画）。这在本页不是理论问题 —— 生产数据 6 个用户里 2 个有量，
 * 零值被排除之后单切片占 100% 是会发生的。
 */
export function arcPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startAngle: number,
  endAngle: number
): string {
  const span = endAngle - startAngle
  // 覆盖整圈（含浮点误差）。用 >= 2π - 1e-9 而不是 === 0。
  if (span >= TAU - 1e-9) {
    const mid = startAngle + Math.PI
    return (
      arcPath(cx, cy, rOuter, rInner, startAngle, mid) +
      ' ' +
      arcPath(cx, cy, rOuter, rInner, mid, startAngle + TAU)
    )
  }

  const largeArc = span > Math.PI ? 1 : 0
  const o0 = polarToCartesian(cx, cy, rOuter, startAngle)
  const o1 = polarToCartesian(cx, cy, rOuter, endAngle)
  const i1 = polarToCartesian(cx, cy, rInner, endAngle)
  const i0 = polarToCartesian(cx, cy, rInner, startAngle)

  return (
    `M ${o0.x} ${o0.y} ` +
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${o1.x} ${o1.y} ` +
    `L ${i1.x} ${i1.y} ` +
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${i0.x} ${i0.y} Z`
  )
}

/**
 * 把「每个用户一个值」变成可直接画的切片。
 *
 * @param threshold 折进「其他」的占比阈值，缺省 2%
 *
 * 顺序：剔负 → 去零 → 按值降序 → 小于阈值的折成一片「其他」→ 算 share。
 *
 * **要折至少两片才折。** 只有一片低于阈值时保留它自己的名字 —— 折了之后图例
 * 一行都不少，却把一个真实用户的名字换成了「其他」，是纯信息损失。而「其他」
 * 这条图例存在的意义就是「这里还有人，别一个个列」，一片的时候那个意义不成立。
 *
 * 排序里的次级键是 label，为的是**同值时有稳定顺序**：否则两条用户用量相同时
 * 切片顺序取决于数据库返回顺序，而 ORDER BY created_at DESC 在同一天注册的
 * 账号之间是不确定的 —— 同一份数据两次刷新出来的环会不一样，图例也会跳。
 */
export function buildDonut(items: DonutItem[], opts: { threshold?: number } = {}): DonutResult {
  const threshold = opts.threshold ?? DEFAULT_OMIT_THRESHOLD

  const positive = items.filter((i) => Number.isFinite(i.value) && i.value > 0)
  const zeroCount = items.length - positive.length
  const sorted = [...positive].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
  const total = sorted.reduce((s, i) => s + i.value, 0)

  if (total <= 0) return { slices: [], total: 0, zeroCount }

  const big = sorted.filter((i) => i.value / total >= threshold)
  const small = sorted.filter((i) => i.value / total < threshold)

  const slices: DonutSlice[] = big.map((i) => ({
    key: i.key,
    label: i.label,
    value: i.value,
    share: i.value / total,
    isOther: false
  }))

  if (small.length) {
    const value = small.reduce((s, i) => s + i.value, 0)
    // `head` 的存在性要真的判：`if (small.length)` 不让 TS 收窄 `small[0]`，
    // 于是 `small[0].key` 报 TS2532（用了可能为 undefined 的属性）。
    const head = small[0]
    slices.push(
      small.length === 1 && head
        ? { key: head.key, label: head.label, value, share: value / total, isOther: false }
        : { key: OTHERS_KEY, label: OTHERS_LABEL, value, share: value / total, isOther: true }
    )
  }

  return { slices, total, zeroCount }
}

/** 切片的起始角累积量。画的时候要按顺序把角度一路推下去。 */
export function sliceAngles(slices: DonutSlice[]): Array<{ start: number; end: number }> {
  let acc = 0
  return slices.map((s) => {
    const start = acc
    acc += s.share * TAU
    return { start, end: acc }
  })
}
