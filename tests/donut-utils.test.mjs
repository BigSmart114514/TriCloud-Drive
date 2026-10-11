// 环状图的数学与分片逻辑（app/utils/donut.ts）。
//
// ## 为什么单独测这个
//
// 项目里没有图表库（package.json 里没有 chart.js / echarts / d3），所以环是
// 手写 SVG。这意味着弧长数学是自己写的 —— 而它是这一层里唯一**能真正执行**
// 的部分：没有 DOM、没有组件挂载环境（项目没有 @vue/test-utils /
// happy-dom），但纯函数可以直接 import 跑。
//
// 这一层出错的后果是静默的：角度差一个 π/2，图照样渲染，只是一块扇形转到
// 错误的位置；坐标不取整，路径字符串带一串浮点尾巴。所以下面断言的是
// **具体坐标与路径字符串**，不是「返回了一个字符串」。
//
// ## 一个刻意的决定：坐标取整到 3 位
//
// SVG 路径字符串会短很多（可读、可 diff、截图对比稳定），也让断言可以逐字
// 比对。不取整的话 `Math.cos(Math.PI / 2)` 是 6.12e-17，期望值写不出来。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register(new URL('./helpers/resolve-nuxt-alias.mjs', import.meta.url), import.meta.url)

const {
  buildDonut,
  arcPath,
  polarToCartesian,
  sliceAngles,
  assignColors,
  toDonutItems,
  DONUT_PALETTE,
  OTHERS_COLOR,
  OTHERS_KEY,
  DEFAULT_OMIT_THRESHOLD
} = await import('../app/utils/donut.ts')

const TAU = Math.PI * 2

describe('polarToCartesian：0 点在 12 点方向，顺时针增大', () => {
  test('四个基准角度', () => {
    assert.deepEqual(polarToCartesian(50, 50, 40, 0), { x: 50, y: 10 }, '0 弧度 = 正上方')
    assert.deepEqual(polarToCartesian(50, 50, 40, Math.PI / 2), { x: 90, y: 50 }, 'π/2 = 正右方')
    assert.deepEqual(polarToCartesian(50, 50, 40, Math.PI), { x: 50, y: 90 }, 'π = 正下方')
    assert.deepEqual(polarToCartesian(50, 50, 40, -Math.PI / 2), { x: 10, y: 50 }, '-π/2 = 正左方')
  })

  test('坐标取整（而不是原样吐出浮点尾巴）', () => {
    // 不取整的话这里会是 50.000000000000014 —— 断言根本写不出来，
    // 而路径字符串会带一串小数尾巴，diff 与截图对比都变得没法看。
    //
    // 判据是「取整到某个固定位数」，**不是「正好 3 位」**。第一版钉死 3 位，
    // 于是把 round3 改成 round2 被扫成「守卫过紧」—— 可 2 位小数同样去掉了
    // 浮点尾巴，渲染上没有任何差别。所以这里给容差。
    const p = polarToCartesian(50, 50, 40, Math.PI / 2)
    assert.equal(p.y, 50, 'π/2 的 y 必须正好是 50 —— 不取整的话是 50 - 2.4e-15')
    const q = polarToCartesian(0, 0, 1, Math.PI / 6)
    assert.equal(q.x, 0.5, '不取整的话 x 是 0.49999999999999994')
    assert.ok(Math.abs(q.y - -0.8660254) < 0.01, `y 应约等于 -0.866，实际 ${q.y}`)
  })
})

describe('arcPath', () => {
  test('90° 扇形的路径是确定的字符串', () => {
    const d = arcPath(50, 50, 40, 25, 0, Math.PI / 2)
    assert.equal(
      d,
      'M 50 10 A 40 40 0 0 1 90 50 L 75 50 A 25 25 0 0 0 50 25 Z',
      '外弧顺时针（sweep=1）、内弧逆时针（sweep=0），闭合回起点'
    )
  })

  test('超过 180° 时 largeArc=1', () => {
    const d = arcPath(50, 50, 40, 25, 0, Math.PI * 1.5)
    assert.match(d, /A 40 40 0 1 1 /, '270° 必须用 largeArc=1，否则画成 90° 的补弧')
  })

  test('正好 180° 时 largeArc=0（两个方向都能画，选小的那个）', () => {
    const d = arcPath(50, 50, 40, 25, 0, Math.PI)
    assert.match(d, /A 40 40 0 0 1 /)
  })

  test('整圆拆成两个半圆 —— SVG 的 A 指令画不出闭合整圆', () => {
    // 这条是「不处理，就画环」那个决定的直接后果：生产数据下 6 个用户里只有
    // 2 个有量，其中一个占 97%，非常接近整圆；再叠加 0 值用户被排除后，
    // 单切片 100% 是**会发生的**。一条 M...A...A...Z 路径在整圆时首尾重合、
    // 什么都不画，所以必须拆。
    const d = arcPath(50, 50, 40, 25, 0, TAU)
    const arcs = [...d.matchAll(/A /g)]
    assert.equal(arcs.length, 4, '两段半圆 = 外弧两条 + 内弧两条')
    assert.match(d, /^M /, '仍然是一条子路径（不是两条），中间靠 L 连')
    // 每一段的终点必须是下一段的起点，否则中间会断
    const nums = d.match(/-?\d+(?:\.\d+)?/g).map(Number)
    assert.ok(d.includes('L '), '两段之间用 L 连接')
    assert.ok(!d.includes('NaN'), `路径里不能有 NaN：${d}`)
    assert.ok(nums.length > 0)
  })

  test('零角度切片不产生 NaN', () => {
    const d = arcPath(50, 50, 40, 25, 1, 1)
    assert.ok(!d.includes('NaN'), `路径里不能有 NaN：${d}`)
  })

  test('外半径必须大于内半径（否则是自相交图形）', () => {
    // 不抛异常，但要能看出问题：起点在外圈、终点在内圈同角度，
    // 两个半径相等时退化成一条线，图形消失。
    const d = arcPath(50, 50, 25, 25, 0, Math.PI / 2)
    assert.ok(!d.includes('NaN'))
    assert.equal((d.match(/A /g) || []).length, 2, '半径相等时两段弧都在，图形退化为线段')
  })
})

describe('端到端：真实数据 → 弧的角度确实等于占比', () => {
  // 这一组是为了替代「看一眼」。项目没有浏览器工具可连，而弧长数学出错的后果
  // 是静默的 —— 图照样渲染，只是一块扇形转到了别人的角度上。所以这里不看图，
  // 直接把生成出来的路径坐标解回来，验证它落在预期的角度上。
  //
  // 数字取自生产库：6 个用户里 2 个有量，另外 4 个全是 0。
  const PROD = [
    { key: '2', label: 'BigSmart1145', usedStorage: 27021628, usedDownload: 3747028 },
    { key: '6', label: 'dehou23333', usedStorage: 823296, usedDownload: 4115030 },
    { key: '7', label: 'jenson', usedStorage: 0, usedDownload: 0 },
    { key: '8', label: 'Ivanc1234567', usedStorage: 0, usedDownload: 0 },
    { key: '9', label: 'JoeyZJH', usedStorage: 0, usedDownload: 0 },
    { key: '10', label: 'Admin', usedStorage: 0, usedDownload: 0 }
  ]
  const items = (field) => PROD.map((u) => ({ key: u.key, label: u.label, value: u[field] }))

  test('存储环的两段角度分别是 97.0% 与 3.0% 的整圈', () => {
    const d = buildDonut(items('usedStorage'))
    assert.equal(d.zeroCount, 4, '4 个零值用户应被排除并单独计数')
    assert.equal(d.slices.length, 2)
    assert.equal(d.total, 27021628 + 823296)

    const ang = sliceAngles(d.slices)
    assert.ok(Math.abs(ang[0].end - d.slices[0].share * TAU) < 1e-9)
    // 从第一条路径里把外弧终点解回来，算出它的极角。
    //
    // 必须**按 2π 取模**再比：97% 的终点在 349.4°，而 atan2 只返回 (-π, π]，
    // 于是同一个角度回来是 -0.1858。第一版直接比，于是对着正确的弧长报了红。
    const d0 = arcPath(50, 50, 38, 26, ang[0].start, ang[0].end)
    const [, , , x1, y1] = /M (\S+) (\S+) A \S+ \S+ 0 \S 1 (\S+) (\S+)/.exec(d0).map(Number)
    const recovered = Math.atan2(x1 - 50, 50 - y1)
    const norm = (a) => ((a % TAU) + TAU) % TAU
    assert.ok(
      Math.abs(norm(recovered) - norm(ang[0].end)) < 1e-3,
      `路径终点反解出的角度 ${norm(recovered)} 应等于 ${norm(ang[0].end)}`
    )
  })

  test('下载环的两片顺序与存储环相反，但角度仍按占比', () => {
    const d = buildDonut(items('usedDownload'))
    assert.deepEqual(d.slices.map((s) => s.key), ['6', '2'], 'dehou 的下载更多，排在前面')
    const ang = sliceAngles(d.slices)
    assert.ok(Math.abs(ang[0].end - 0.523 * TAU) < 0.01, `52.3% 应约 ${0.523 * TAU}`)
    assert.ok(Math.abs(ang[1].end - TAU) < 1e-9, '两段必须正好收在整圈')
  })

  test('所有切片首尾相接、合计整圈（不留缝也不重叠）', () => {
    for (const field of ['usedStorage', 'usedDownload']) {
      const d = buildDonut(items(field))
      const ang = sliceAngles(d.slices)
      assert.equal(ang[0].start, 0, `${field}: 第一片必须从 12 点方向开始`)
      for (let i = 1; i < ang.length; i++) {
        assert.ok(
          Math.abs(ang[i].start - ang[i - 1].end) < 1e-12,
          `${field}: 第 ${i} 片起点与上一片终点之间有缝或重叠`
        )
      }
      assert.ok(Math.abs(ang[ang.length - 1].end - TAU) < 1e-9, `${field}: 未收在整圈`)
    }
  })

  test('全部为零时不出任何路径（不能画出一个空环或 NaN）', () => {
    const d = buildDonut(PROD.map((u) => ({ key: u.key, label: u.label, value: 0 })))
    assert.deepEqual(d.slices, [])
    assert.deepEqual(sliceAngles(d.slices), [])
    assert.equal(d.zeroCount, 6)
  })

  test('单切片 100% 时路径拆成两段半圆而不是一条空路径', () => {
    const d = buildDonut([{ key: 'only', label: 'only', value: 42 }])
    const ang = sliceAngles(d.slices)
    const path = arcPath(50, 50, 38, 26, ang[0].start, ang[0].end)
    assert.equal((path.match(/A /g) || []).length, 4, '两段半圆 = 外弧两条 + 内弧两条')
    assert.ok(!path.includes('NaN'))
    // 零值用户被排除之后，剩下单切片占满是常态，不是异常
    const many = [{ key: 'a', label: 'a', value: 42 }, ...PROD.slice(2).map((u) => ({ key: u.key, label: u.label, value: 0 }))]
    assert.equal(buildDonut(many).slices.length, 1)
  })
})

describe('toDonutItems：页面的数据形状 → 环的输入', () => {
  // ## 这组是补上一次的洞
  //
  // 上一轮环画出来是空的：7 个用户、两个空圈、提示「另有 7 个用户没有用量」。
  // 而开发库里明明有三个用户有量。根因是 user.vue 存的是 `formatBytes(...)`
  // 出来的**显示字符串**（"9.37 KB"，给编辑弹窗的输入框用），而我的环算的是
  // `Number(u.usedStorage)` → NaN → `NaN || 0` → 0。
  //
  // 为什么那一整轮测试都没抓到：它们断言的都是**名字与调用形式** ——
  // 「源码里出现过 usedStorage」「调了 buildDonut」。而 `DbUser.usedStorage`
  // 的类型是 `number | string`，`Number(x || 0)` 对两者都通过类型检查，
  // tsc 也就没话说。**提到名字不等于值对。**
  //
  // 所以这条通路必须有**能执行**的测试，而它只能是纯函数 —— 项目没有 DOM 环境。

  const u = (over) => ({ id: 1, username: 'a', usedStorageBytes: 100, usedDownloadBytes: 50, ...over })

  test('正常的数值直接用（数字与数字字符串都算）', () => {
    const r = toDonutItems([u({ id: 1 }), u({ id: 2, usedStorageBytes: '200' })], 'usedStorageBytes')
    assert.deepEqual(r.items.map((i) => i.value), [100, 200])
    assert.deepEqual(r.unreadable, [], '不该有读不出来的')
  })

  test('显示字符串（"9.37 KB"）**不算 0**，而是进 unreadable', () => {
    // 这就是上一轮那个 bug 的形状。若这里返回 0，界面上就是「没有用量」，
    // 而真相是「读错了」—— 两者在屏幕上无法区分。
    const r = toDonutItems([u({ usedStorageBytes: '9.37 KB' })], 'usedStorageBytes')
    assert.equal(r.items[0].value, 0, '读不出时这一项只能是 0（画不出扇形）')
    assert.deepEqual(r.unreadable, ['a'], '但必须被记下来报给界面')
  })

  test('null / undefined / 空串算「没有用量」，不是「读不出来」', () => {
    // 0 是一个合法值；「字段根本没来」是另一回事。两者不该混。
    for (const v of [null, undefined, '']) {
      const r = toDonutItems([u({ usedStorageBytes: v })], 'usedStorageBytes')
      assert.equal(r.items[0].value, 0, `${JSON.stringify(v)} 应算 0`)
      assert.deepEqual(r.unreadable, [], `${JSON.stringify(v)} 不该算读不出来`)
    }
  })

  test('负值夹到 0，不画反向扇形', () => {
    const r = toDonutItems([u({ usedStorageBytes: -5 })], 'usedStorageBytes')
    assert.equal(r.items[0].value, 0)
    assert.deepEqual(r.unreadable, [])
  })

  test('key 用 id、label 有三级兜底', () => {
    const r = toDonutItems(
      [u({ id: 7, username: '有名' }), u({ id: 8, username: '', email: 'e@x' }), u({ id: 9, username: '', email: '' })],
      'usedStorageBytes'
    )
    assert.deepEqual(r.items.map((i) => i.key), ['7', '8', '9'])
    assert.deepEqual(r.items.map((i) => i.label), ['有名', 'e@x', '#9'])
  })

  test('下载与存储是两个独立字段，不能串', () => {
    const rows = [u({ usedStorageBytes: 100, usedDownloadBytes: 7 })]
    assert.equal(toDonutItems(rows, 'usedStorageBytes').items[0].value, 100)
    assert.equal(toDonutItems(rows, 'usedDownloadBytes').items[0].value, 7)
  })

  test('空数组、null、undefined 都安全（兜底在函数里，不在每个调用点）', () => {
    assert.deepEqual(toDonutItems([], 'usedStorageBytes'), { items: [], unreadable: [] })
    assert.deepEqual(toDonutItems(null, 'usedStorageBytes'), { items: [], unreadable: [] })
    assert.deepEqual(toDonutItems(undefined, 'usedStorageBytes'), { items: [], unreadable: [] })
  })
})

describe('assignColors：两个环共用一套配色', () => {
  const ring = (pairs) => pairs.map(([key, label, value]) => ({ key, label, value, isOther: false }))

  test('同一个用户在两个环里拿到同一个颜色', () => {
    // 这条是「两环图例共用一份配色」的前提。
    //
    // 第一版写的是 `assert.equal(colors['2'], colors['2'])` —— **恒真**，
    // 于是把 `if (out[s.key]) continue` 删掉（第二个环重新分配颜色）这条变异
    // 也照样绿。现在改成断言「颜色由哪个环决定」：存储环里排第一的拿色板第 0 号，
    // 第二的拿第 1 号，而下载环里顺序是反的 —— 如果第二个环又分配一遍，
    // dehou 会被改成第 2 号色。
    const storage = ring([['2', 'BigSmart', 27021628], ['6', 'dehou', 823296]])
    const download = ring([['6', 'dehou', 4115030], ['2', 'BigSmart', 3747028]])
    const colors = assignColors(storage, download)
    assert.equal(colors['2'], DONUT_PALETTE[0], '存储环里第一名的色号')
    assert.equal(colors['6'], DONUT_PALETTE[1], '存储环里第二名的色号（下载环里顺序相反但同色）')
    assert.notEqual(colors['2'], colors['6'], '不同用户必须不同色')
    assert.equal(Object.keys(colors).length, 2, '两个用户就两种颜色，不多不少')
  })

  test('只在一处出现的用户也有颜色', () => {
    const colors = assignColors(ring([['2', 'a', 10]]), ring([['9', 'b', 20]]))
    assert.ok(colors['2'] && colors['9'], '只在一个环里出现的用户也要分到颜色')
    assert.notEqual(colors['2'], colors['9'])
  })

  test('「其他」是固定灰，且不占色板位置', () => {
    const withOther = [
      { key: OTHERS_KEY, label: '其他', value: 5, share: 0.01, isOther: true }
    ]
    const colors = assignColors([{ key: 'a', label: 'a', value: 95, share: 0.95, isOther: false }, ...withOther])
    assert.equal(colors[OTHERS_KEY], OTHERS_COLOR)
    assert.equal(colors['a'], DONUT_PALETTE[0], '「其他」不该把色板往后推')
  })

  test('色板用完从尾部循环，且长度足够画开', () => {
    const many = Array.from({ length: DONUT_PALETTE.length + 2 }, (_, i) => ({
      key: `u${i}`, label: `u${i}`, value: 1000 - i, share: 0, isOther: false
    }))
    const colors = assignColors(many)
    assert.equal(colors[`u${DONUT_PALETTE.length}`], DONUT_PALETTE[0], '用完要循环')
    assert.ok(DONUT_PALETTE.length >= 8, `色板只有 ${DONUT_PALETTE.length} 色，超出就开始撞色`)
    const used = new Set(Object.values(colors))
    assert.equal(used.size, DONUT_PALETTE.length, '前 N 个用户颜色两两不同')
  })
})

describe('sliceAngles：角度按占比累积', () => {
  test('第一片从 0 开始，各段首尾相接，总跨度是整圈', () => {
    const slices = [
      { key: 'a', label: 'a', value: 75, share: 0.75, isOther: false },
      { key: 'b', label: 'b', value: 25, share: 0.25, isOther: false }
    ]
    const a = sliceAngles(slices)
    assert.equal(a[0].start, 0, '第一片从 12 点方向开始')
    assert.ok(Math.abs(a[0].end - Math.PI * 1.5) < 1e-9, '75% = 270°')
    assert.equal(a[1].start, a[0].end, '首尾必须相接，否则中间出现空隙')
    assert.ok(Math.abs(a[1].end - TAU) < 1e-9, '总和收在整圈')
  })

  test('空切片返回空数组（不能返回一个 0 宽度的段）', () => {
    assert.deepEqual(sliceAngles([]), [])
  })
})

describe('buildDonut：分片与「省略太小的」', () => {
  const users = (pairs) => pairs.map(([label, value]) => ({ key: label, label, value }))

  test('空输入：没有切片，总量为 0', () => {
    const r = buildDonut([])
    assert.deepEqual(r.slices, [])
    assert.equal(r.total, 0)
    assert.equal(r.zeroCount, 0)
  })

  test('全部为 0：零值用户单独计数，不进环', () => {
    // 零值若进环，7 个用户里 5 个是 0，它们各自都「小于 2%」，
    // 于是全被折进「其他」——「其他: 0 B，占 0%」是最蠢的一种图例。
    const r = buildDonut(users([['a', 0], ['b', 0]]))
    assert.deepEqual(r.slices, [])
    assert.equal(r.zeroCount, 2)
    assert.equal(r.total, 0)
  })

  test('按值降序', () => {
    const r = buildDonut(users([['小', 10], ['大', 100], ['中', 50]]))
    assert.deepEqual(r.slices.map((s) => s.label), ['大', '中', '小'])
  })

  test('占比小于 2% 的折成「其他」，默认阈值 0.02', () => {
    assert.equal(DEFAULT_OMIT_THRESHOLD, 0.02)
    // 1000 与 2×10：20/1020 ≈ 1.96%，两片都低于阈值
    const r = buildDonut(users([['大', 1000], ['小1', 10], ['小2', 10]]))
    assert.deepEqual(r.slices.map((s) => s.key), ['大', OTHERS_KEY])
    const other = r.slices[1]
    assert.equal(other.value, 20)
    assert.equal(other.label, '其他')
    assert.equal(other.isOther, true)
    assert.ok(other.share > 0 && other.share < 0.02, `「其他」占比应保留真实值，实际 ${other.share}`)
  })

  test('只有一片低于阈值时保留它自己的名字（不折）', () => {
    // 第一版这条断言的是「1.96% 那一折成其他」。那是错的：折了之后图例一行都
    // 没少，却把一个真实用户的名字换成了「其他」——纯信息损失。所以规则是
    // **要折至少两片才折**。
    const r = buildDonut(users([['大', 1000], ['小', 20]]))
    assert.deepEqual(r.slices.map((s) => s.key), ['大', '小'])
    assert.ok(!r.slices.some((s) => s.isOther))
  })

  test('正好 2% 的**不**折（判据是 < 阈值，不是 <=）', () => {
    const r = buildDonut(users([['大', 980], ['小', 20]]))  // 20/1000 = 2%
    assert.deepEqual(r.slices.map((s) => s.key), ['大', '小'])
    assert.equal(r.slices.length, 2)
  })

  test('小于阈值的**全部**折进「其他」，不管那一批加起来有多小', () => {
    // 第一版这里写的是「折起来不足 2% 就不折」，而上面那条要求 1.96% 的那一片
    // **必须**折 —— 两条测试没有任何一条规则能同时满足。那条额外的规则是我自己
    // 想出来的，不是需求里的。规则就是需求说的那句：太小的省略。
    //
    // 后果是「其他」可能细到看不见（这里 0.2%）。但那是真的 0.2%，图例里写着
    // 数值，不是渲染故障；而且按生产数据现在根本不会触发（6 个用户里 2 个有量，
    // 最小的那个占 2.96%，本来就在阈值之上）。
    const r = buildDonut(users([['大', 10000], ['微1', 10], ['微2', 10]]))
    assert.deepEqual(r.slices.map((s) => s.key), ['大', OTHERS_KEY])
    assert.equal(r.slices[1].value, 20)
    assert.ok(r.slices[1].share < 0.005, `实际 ${r.slices[1].share}`)
  })

  test('单切片占 100%（生产数据的常见形态）', () => {
    const r = buildDonut(users([['唯一', 27021628]]))
    assert.equal(r.slices.length, 1)
    assert.equal(r.slices[0].share, 1)
    assert.equal(r.zeroCount, 0)
  })

  test('share 之和为 1（有「其他」时也是）', () => {
    const r = buildDonut(users([['a', 1000], ['b', 20], ['c', 15], ['d', 5]]))
    const sum = r.slices.reduce((s, x) => s + x.share, 0)
    assert.ok(Math.abs(sum - 1) < 1e-9, `share 之和 ${sum}，应为 1`)
  })

  test('负值被夹到 0（脏数据不该画出一块反向的扇形）', () => {
    const r = buildDonut(users([['a', 100], ['坏', -50]]))
    assert.equal(r.total, 100)
    assert.equal(r.slices.length, 1)
    assert.equal(r.slices[0].label, 'a')
  })

  test('阈值可配置', () => {
    const items = users([['大', 1000], ['小1', 100], ['小2', 100]])
    assert.equal(buildDonut(items).slices.length, 3, '9% 的两片在 2% 阈值下都保留')
    const r = buildDonut(items, { threshold: 0.2 })
    assert.deepEqual(
      r.slices.map((s) => s.key),
      ['大', OTHERS_KEY],
      '阈值 20% 时两片 9% 应折成「其他」'
    )
  })
})
