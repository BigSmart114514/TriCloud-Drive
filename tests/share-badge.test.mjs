// types/share.ts 的单元测试。
//
// 这些是纯函数，没有 DB / h3 依赖，所以直接 import 源码测。
// 用 node 内置的 node:test，不引第三方框架（项目本来也没有）。
//
// 跑法：node --test tests/
// 或：  node --experimental-strip-types tests/share-badge.test.mjs
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveShareBadge,
  shouldShowPresetDot,
  PRESET_DOT_TITLE,
  SHARE_BADGE_LABELS,
  SHARE_NONE,
  SHARE_SHARED,
  SHARE_INHERIT,
  normalizeShareMode,
  normalizePermission,
  hasPermission,
  readOnly,
  isShareBoundary,
  SHARE_MODE_LABELS,
  PERM_READ,
  PERM_WRITE,
  PERM_DELETE,
  PERM_DOWNLOAD,
  PERM_ALL,
  PERM_BIT_LABELS,
  PERMISSION_LABELS,
  formatPermission
} from '../types/share.ts'

describe('resolveShareBadge —— 文件夹图标的分享角标', () => {
  test('不分享（0）：阻止优先，IsPublic 和名单都不看', () => {
    assert.equal(resolveShareBadge({ Shared: SHARE_NONE, IsPublic: false, grantCount: 0 }), 'lock')
    assert.equal(resolveShareBadge({ Shared: SHARE_NONE, IsPublic: true, grantCount: 3 }), 'lock')
    // 设为不分享时名单会被清掉，但仍断言一下：即便有残留也该显示「阻止」
    assert.equal(resolveShareBadge({ Shared: SHARE_NONE, IsPublic: false, grantCount: 99 }), 'lock')
  })

  test('分享（1）+ 公开：公开优先于名单', () => {
    assert.equal(resolveShareBadge({ Shared: SHARE_SHARED, IsPublic: true, grantCount: 0 }), 'users')
    assert.equal(resolveShareBadge({ Shared: SHARE_SHARED, IsPublic: true, grantCount: 5 }), 'users')
  })

  test('分享（1）+ 未公开：就是按名单', () => {
    assert.equal(resolveShareBadge({ Shared: SHARE_SHARED, IsPublic: false, grantCount: 0 }), 'share')
    assert.equal(resolveShareBadge({ Shared: SHARE_SHARED, IsPublic: false, grantCount: 2 }), 'share')
  })

  test('继承（2）+ 公开：特别条款，公开生效', () => {
    assert.equal(resolveShareBadge({ Shared: SHARE_INHERIT, IsPublic: true, grantCount: 0 }), 'users')
    assert.equal(resolveShareBadge({ Shared: SHARE_INHERIT, IsPublic: true, grantCount: 7 }), 'users')
  })

  test('继承（2）+ 有人：名单非空 = 共享中', () => {
    assert.equal(resolveShareBadge({ Shared: SHARE_INHERIT, IsPublic: false, grantCount: 1 }), 'share')
    assert.equal(resolveShareBadge({ Shared: SHARE_INHERIT, IsPublic: false, grantCount: 42 }), 'share')
  })

  test('继承（2）+ 没人：继承是默认值，不提示', () => {
    assert.equal(resolveShareBadge({ Shared: SHARE_INHERIT, IsPublic: false, grantCount: 0 }), null)
    assert.equal(resolveShareBadge({ Shared: SHARE_INHERIT, grantCount: 0 }), null)
  })

  // 这一组是回归测试。原来的实现是 Number(input.Shared) !== SHARE_INHERIT，
  // 而 Number(null) 和 Number('') 都得到 0 —— 0 正是 SHARE_NONE，
  // 于是「字段缺失」被误判成「不分享」，凭空亮出一个锁。
  test('Shared 缺失/脏值一律按继承处理，绝不亮锁', () => {
    // Number([]) 和 Number([0]) 都是 0，而 0 = SHARE_NONE。不挡的话空数组会
    // 凭空亮出一个锁；Number(true) = 1 会凭空亮出「已分享」。normalizeShareMode
    // 挡住了，这是回归测试。
    for (const Shared of [null, undefined, '', NaN, 99, -1, {}, [], [0], [2], true, false]) {
      assert.equal(
        resolveShareBadge({ Shared, IsPublic: false, grantCount: 0 }),
        null,
        `Shared=${JSON.stringify(Shared)} 不该亮角标`
      )
    }
  })

  test('字符串数字按数值判定', () => {
    assert.equal(resolveShareBadge({ Shared: '0', IsPublic: false }), 'lock')
    assert.equal(resolveShareBadge({ Shared: '1', IsPublic: false }), 'share')
    assert.equal(resolveShareBadge({ Shared: '2', IsPublic: false, grantCount: 0 }), null)
  })

  test('全缺对象（最坏输入）不崩', () => {
    assert.equal(resolveShareBadge({}), null)
    assert.equal(resolveShareBadge({ IsPublic: true }), 'users')
    assert.equal(resolveShareBadge({ grantCount: 3 }), 'share')
  })

  test('IsPublic 用严格 === true：数字/字符串不算真', () => {
    // 数据流上服务端已用 toBool 归一成真布尔（db.ts:352），前端拿到的只可能是
    // true/false。这里守住「不宽松」—— 万一哪天漏了归一，1 也不该被当成公开。
    assert.equal(resolveShareBadge({ Shared: SHARE_INHERIT, IsPublic: true }), 'users')
    assert.equal(resolveShareBadge({ Shared: SHARE_INHERIT, IsPublic: 'true' }), null)
    assert.equal(resolveShareBadge({ Shared: SHARE_INHERIT, IsPublic: 1 }), null)
    assert.equal(resolveShareBadge({ Shared: SHARE_INHERIT, IsPublic: 0 }), null)
  })

  test('角标都有对应的说明文案', () => {
    for (const badge of ['lock', 'users', 'share']) {
      assert.equal(typeof SHARE_BADGE_LABELS[badge], 'string')
      assert.ok(SHARE_BADGE_LABELS[badge].length > 0, `${badge} 缺文案`)
    }
  })
})

describe('shouldShowPresetDot —— 「设了但没生效」的红点', () => {
  // 三个条件：继承态 + 设过东西（人员或公开） + presetActive === false
  test('继承 + 有人 + 没生效 → 点', () => {
    assert.equal(shouldShowPresetDot({
      Shared: SHARE_INHERIT, grantCount: 1, presetActive: false
    }), true)
  })

  test('继承 + 公开 + 没生效 → 点', () => {
    assert.equal(shouldShowPresetDot({
      Shared: SHARE_INHERIT, IsPublic: true, presetActive: false
    }), true)
  })

  test('继承 + 有人 + 公开 + 没生效 → 点（一条就够）', () => {
    assert.equal(shouldShowPresetDot({
      Shared: SHARE_INHERIT, IsPublic: true, grantCount: 3, presetActive: false
    }), true)
  })

  // 条件 3 的两个反面
  test('继承 + 设了但生效 → 不点', () => {
    assert.equal(shouldShowPresetDot({
      Shared: SHARE_INHERIT, grantCount: 1, presetActive: true
    }), false)
    assert.equal(shouldShowPresetDot({
      Shared: SHARE_INHERIT, IsPublic: true, presetActive: true
    }), false)
  })

  // presetActive 缺失 → 不点。宁可漏提示也不要给一份正常的分享挂「没生效」。
  test('presetActive 缺失时不点（数据没经过判定）', () => {
    assert.equal(shouldShowPresetDot({
      Shared: SHARE_INHERIT, grantCount: 1
    }), false)
    assert.equal(shouldShowPresetDot({
      Shared: SHARE_INHERIT, grantCount: 1, presetActive: null
    }), false)
  })

  // 条件 2 的反面：什么都没设，就没有「没生效」这回事
  test('继承 + 什么都没设 → 不点', () => {
    assert.equal(shouldShowPresetDot({
      Shared: SHARE_INHERIT, IsPublic: false, grantCount: 0, presetActive: false
    }), false)
  })

  // 条件 1 的反面：非继承态不存在「预设」
  test('不分享 / 分享 + 没生效 → 不点（没有预设这回事）', () => {
    assert.equal(shouldShowPresetDot({
      Shared: SHARE_NONE, grantCount: 1, presetActive: false
    }), false)
    assert.equal(shouldShowPresetDot({
      Shared: SHARE_SHARED, IsPublic: true, presetActive: false
    }), false)
  })

  test('Shared 脏值按继承处理，此时照样参与判定', () => {
    assert.equal(shouldShowPresetDot({
      Shared: null, grantCount: 1, presetActive: false
    }), true)
    assert.equal(shouldShowPresetDot({
      Shared: [], grantCount: 1, presetActive: false
    }), true, '空数组曾被误判成不分享，现在不会了')
  })

  test('红点有说明文案', () => {
    assert.equal(typeof PRESET_DOT_TITLE, 'string')
    assert.ok(PRESET_DOT_TITLE.length > 0)
  })
})

describe('normalizeShareMode —— 三态归一化', () => {
  test('0/1/2 映射到自身', () => {
    assert.equal(normalizeShareMode(0), SHARE_NONE)
    assert.equal(normalizeShareMode(1), SHARE_SHARED)
    assert.equal(normalizeShareMode(2), SHARE_INHERIT)
  })

  // fail-closed：取不到值时退回继承（失效开放），而不是退回不分享（失效封闭）。
  // 继承会继续向上找，最终无人可越权；不分享则会凭空立一道墙砍掉权限。
  test('null/undefined/空串/脏值一律退回继承', () => {
    for (const v of [null, undefined, '', NaN, 3, 99, -1, 'abc']) {
      assert.equal(normalizeShareMode(v), SHARE_INHERIT, `${String(v)} 应退回继承`)
    }
  })

  // 回归：这几个曾被误判成 0 或 1。
  //   Number([]) = 0      → SHARE_NONE，凭空立一道墙把权限砍光
  //   Number([0]) = 0      → 同上
  //   Number(true) = 1     → SHARE_SHARED，凭空把权限放开
  // 不挡 typeof 就中招了。这是权限计算的公共入口，误判方向都很危险。
  test('数组/对象/布尔不能被 Number() 误判成三态', () => {
    for (const v of [[], [0], [1], [2], {}, { valueOf: () => 1 }, true, false]) {
      assert.equal(
        normalizeShareMode(v),
        SHARE_INHERIT,
        `${JSON.stringify(v)} 应退回继承`
      )
    }
  })
})

describe('isShareBoundary —— 只有继承不是边界', () => {
  test('不分享与分享都是边界', () => {
    assert.equal(isShareBoundary(SHARE_NONE), true)
    assert.equal(isShareBoundary(SHARE_SHARED), true)
  })

  test('继承不是边界', () => {
    assert.equal(isShareBoundary(SHARE_INHERIT), false)
  })
})

describe('权限位掩码 —— 四个相互独立的位', () => {
  test('位的值不冲突', () => {
    assert.equal(PERM_READ, 1)
    assert.equal(PERM_WRITE, 2)
    assert.equal(PERM_DELETE, 4)
    assert.equal(PERM_DOWNLOAD, 8)
    assert.equal(PERM_ALL, 15)
  })

  // normalizePermission 从「单轴压档」改成「按位独立」。
  // 旧实现是 if (m & DELETE) return PERM_ALL 那种，会把
  // 「可读+可下载但不能写」压成只读，download 位直接丢掉 ——
  // 这正是加独立第四位必须一起改的原因。
  test('normalizePermission 按位独立，不再压成三档', () => {
    assert.equal(normalizePermission(PERM_READ), PERM_READ)
    assert.equal(normalizePermission(PERM_READ | PERM_WRITE), PERM_READ | PERM_WRITE)
    assert.equal(normalizePermission(PERM_ALL), PERM_ALL)
    assert.equal(normalizePermission(0), 0)
    assert.equal(normalizePermission(null), 0)
    assert.equal(normalizePermission(NaN), 0)
  })

  test('「能看+能下载但不能写删」这种组合不再被压掉', () => {
    const combo = PERM_READ | PERM_DOWNLOAD   // 9
    assert.equal(normalizePermission(combo), combo, 'download 位必须保住')
    assert.equal(hasPermission(combo, PERM_READ), true)
    assert.equal(hasPermission(combo, PERM_DOWNLOAD), true)
    assert.equal(hasPermission(combo, PERM_WRITE), false)
    assert.equal(hasPermission(combo, PERM_DELETE), false)
  })

  test('「能改能删但不给看」也能表达（位独立才做得到）', () => {
    const combo = PERM_WRITE | PERM_DELETE    // 6
    assert.equal(normalizePermission(combo), combo)
    assert.equal(hasPermission(combo, PERM_READ), false)
    assert.equal(hasPermission(combo, PERM_WRITE), true)
  })

  // 存量兼容：DB 里现存的名单是 1/3/7，不含 download 位。
  // 7 在旧模型里是「全权」，语义上等价于新模型的全权 15，读端补位。
  // 不迁数据 —— schema 的 CHECK 是 permission >= 0，加位无需重建表。
  test('存量 7 被读成全权 15（不迁数据）', () => {
    assert.equal(normalizePermission(7), 15)
  })

  test('存量的 1 和 3 不补位（明确不含下载意图）', () => {
    assert.equal(normalizePermission(1), 1, '只读 → 仍不能下载')
    assert.equal(normalizePermission(3), 3, '读写 → 仍不能下载')
    assert.equal(hasPermission(3, PERM_DOWNLOAD), false)
  })

  test('已含 download 位的 15 不受影响', () => {
    assert.equal(normalizePermission(15), 15)
  })

  test('未定义的位被剔除', () => {
    assert.equal(normalizePermission(PERM_READ | 16), PERM_READ)
    assert.equal(normalizePermission(16), 0)
    assert.equal(normalizePermission(PERM_ALL | 256), PERM_ALL)
  })

  test('hasPermission 用包含判断，不是相等判断', () => {
    assert.equal(hasPermission(PERM_ALL, PERM_READ), true)
    assert.equal(hasPermission(PERM_ALL, PERM_ALL), true)
    assert.equal(hasPermission(PERM_READ | PERM_WRITE, PERM_READ), true)
    assert.equal(hasPermission(PERM_READ | PERM_WRITE, PERM_ALL), false)
    assert.equal(hasPermission(PERM_READ, PERM_READ | PERM_WRITE), false)
    assert.equal(hasPermission(0, PERM_READ), false)
    // 下载与其它位互不蕴含
    assert.equal(hasPermission(PERM_READ, PERM_DOWNLOAD), false)
    assert.equal(hasPermission(PERM_READ | PERM_WRITE, PERM_DOWNLOAD), false)
  })

  // 「全权但不许下载」= 15 去掉 8 = 7，而这个 7 会被当成存量全权补回 download。
  // 也就是说这个组合在当前编码下**无法表达** —— ShareDialog 因此禁止从全权
  // 里单独取消「下载」（要取消得同时去掉 read/write/delete 中的任意一项）。
  // 这条测试把这个已知限制钉住，避免以后有人误以为它能用。
  test('已知限制：7 被读成全权，「全权但不许下载」表达不了', () => {
    assert.equal(PERM_ALL ^ PERM_DOWNLOAD, 7)
    assert.equal(normalizePermission(7), PERM_ALL)
    assert.equal(hasPermission(PERM_ALL ^ PERM_DOWNLOAD, PERM_DOWNLOAD), true, '7 会补回 download')
  })

  test('readOnly：只读 = 有读且无写', () => {
    assert.equal(readOnly(PERM_READ), true)
    assert.equal(readOnly(PERM_READ | PERM_WRITE), false)
    assert.equal(readOnly(PERM_ALL), false)
    assert.equal(readOnly(0), false)
    // 可读+可下载但不能写，仍然算「只读」范畴
    assert.equal(readOnly(PERM_READ | PERM_DOWNLOAD), true)
  })

  test('formatPermission 渲染四种位', () => {
    assert.equal(formatPermission(0), '无权限')
    assert.equal(formatPermission(PERM_ALL), '全部权限')
    assert.equal(formatPermission(PERM_READ), '查看')
    assert.equal(formatPermission(PERM_READ | PERM_WRITE), '查看 / 编辑')
    assert.equal(formatPermission(PERM_DOWNLOAD), '下载')
    assert.equal(formatPermission(PERM_READ | PERM_DOWNLOAD), '查看 / 下载')
  })

  test('formatPermission 按固定顺序渲染（位顺序在 UI 上是约定）', () => {
    // 掩码里的位序不影响显示顺序
    assert.equal(
      formatPermission(PERM_DOWNLOAD | PERM_DELETE | PERM_WRITE | PERM_READ),
      formatPermission(PERM_READ | PERM_WRITE | PERM_DELETE | PERM_DOWNLOAD)
    )
  })

  test('PERM_BIT_LABELS 四个位都有名字', () => {
    for (const bit of [PERM_READ, PERM_WRITE, PERM_DELETE, PERM_DOWNLOAD]) {
      assert.equal(typeof PERM_BIT_LABELS[bit], 'string')
      assert.ok(PERM_BIT_LABELS[bit].length > 0)
    }
  })

  test('PERMISSION_LABELS 至少覆盖旧的三档（share/list.get.ts 还在用）', () => {
    for (const mask of [PERM_READ, PERM_READ | PERM_WRITE, PERM_READ | PERM_WRITE | PERM_DELETE, PERM_ALL]) {
      assert.ok(PERMISSION_LABELS[mask], `掩码 ${mask} 缺标签`)
    }
  })
})

describe('SHARE_MODE_LABELS', () => {
  test('三个状态都有中文标签', () => {
    assert.equal(SHARE_MODE_LABELS[SHARE_NONE], '不分享')
    assert.equal(SHARE_MODE_LABELS[SHARE_SHARED], '分享')
    assert.equal(SHARE_MODE_LABELS[SHARE_INHERIT], '继承')
  })
})
