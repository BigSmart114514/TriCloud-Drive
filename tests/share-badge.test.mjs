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
  PERM_ALL,
  PERMISSION_LABELS
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

describe('权限位掩码', () => {
  test('normalizePermission 归一化成包含关系 read ⊂ write ⊂ delete', () => {
    assert.equal(normalizePermission(PERM_READ), PERM_READ)
    assert.equal(normalizePermission(PERM_READ | PERM_WRITE), PERM_READ | PERM_WRITE)
    assert.equal(normalizePermission(PERM_ALL), PERM_ALL)
    // 勾了 delete 就是全权，不是 4
    assert.equal(normalizePermission(PERM_READ | 4), PERM_ALL)
    assert.equal(normalizePermission(0), 0)
    assert.equal(normalizePermission(null), 0)
    assert.equal(normalizePermission(NaN), 0)
  })

  test('hasPermission 用包含判断，不是相等判断', () => {
    assert.equal(hasPermission(PERM_ALL, PERM_READ), true)
    assert.equal(hasPermission(PERM_ALL, PERM_ALL), true)
    assert.equal(hasPermission(PERM_READ | PERM_WRITE, PERM_READ), true)
    // 有写但没删，不能满足 delete
    assert.equal(hasPermission(PERM_READ | PERM_WRITE, PERM_ALL), false)
    assert.equal(hasPermission(PERM_READ, PERM_READ | PERM_WRITE), false)
    assert.equal(hasPermission(0, PERM_READ), false)
  })

  test('readOnly：只读 = 有读且无写', () => {
    assert.equal(readOnly(PERM_READ), true)
    assert.equal(readOnly(PERM_READ | PERM_WRITE), false)
    assert.equal(readOnly(PERM_ALL), false)
    assert.equal(readOnly(0), false)
  })

  test('PERMISSION_LABELS 覆盖所有归一化后的掩码', () => {
    for (const mask of [PERM_READ, PERM_READ | PERM_WRITE, PERM_ALL]) {
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
