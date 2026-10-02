// withScope / withScopeRef 的行为（跑真函数）。
//
// ## 为什么这也需要测
//
// 它替换了 18 处样板，而样板里藏着三条约定，全凭肉眼很容易改错：
//
//   1. useAdmin 传 **1** 不是 true
//   2. 判断用真值，所以 targetUserId = 0 与 undefined 都不传
//   3. 空值不设键，而不是设成 undefined
//
// 第 1 条尤其容易踩：ofetch 序列化时 undefined 会被丢掉，于是「传 undefined」
// 与「不传」在网络上不可区分，但 true 与 1 在服务端的 readBool 里都成立 ——
// 一旦哪天有人图省事改成 true，只要服务端还认 true 就没事，**可一旦服务端某
// 天只认 1**（或者反过来），就是整页 403，而且没有任何类型错误。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ref } from 'vue'

const { withScope, withScopeRef } = await import('../app/utils/scope.ts')

describe('withScope', () => {
  test('两个都传时都写进去', () => {
    const p = withScope({}, { targetUserId: 42, useAdmin: true })
    assert.equal(p.targetUserId, 42)
    assert.ok('useAdmin' in p)
  })

  test('useAdmin 传的是数字 1，不是 true', () => {
    // 约定：这些接口一直收 1。改成 true 没有任何编译错误，只有线上行为差异。
    const p = withScope({}, { targetUserId: 1, useAdmin: true })
    assert.equal(p.useAdmin, 1)
    assert.strictEqual(p.useAdmin, 1)
    assert.notStrictEqual(p.useAdmin, true, 'useAdmin 绝不能是布尔 true')
  })

  test('只传 targetUserId', () => {
    const p = withScope({}, { targetUserId: 7 })
    assert.equal(p.targetUserId, 7)
    assert.ok(!('useAdmin' in p), '没传就不该有这个键')
  })

  test('只传 useAdmin', () => {
    const p = withScope({}, { useAdmin: true })
    assert.equal(p.useAdmin, 1)
    assert.ok(!('targetUserId' in p))
  })

  test('两个都不传：对象保持为空', () => {
    const p = withScope({}, {})
    assert.deepEqual(p, {})
    assert.equal(Object.keys(p).length, 0)
  })

  test('传 undefined / null 都不写键', () => {
    const p = withScope({}, { targetUserId: undefined, useAdmin: undefined })
    assert.deepEqual(p, {}, 'undefined 不该变成键')
    const q = withScope({}, { targetUserId: null, useAdmin: null })
    assert.deepEqual(q, {}, 'null 同样不写')
  })

  test('targetUserId = 0 不传（0 不是合法 id）', () => {
    // 真值判断的既定行为：根用 null 或 'root'，0 是无效输入，
    // 与 undefined 一样当作「没指定」。别改成 !== null。
    const p = withScope({}, { targetUserId: 0 })
    assert.ok(!('targetUserId' in p), '0 应被真值判断挡掉')
  })

  test('useAdmin = false 不传', () => {
    const p = withScope({}, { useAdmin: false })
    assert.ok(!('useAdmin' in p))
  })

  test('不改动已有的其他字段', () => {
    const p = withScope({ fileKey: 'k/1', filename: 'a.txt' }, { targetUserId: 3, useAdmin: true })
    assert.equal(p.fileKey, 'k/1')
    assert.equal(p.filename, 'a.txt')
    assert.equal(p.targetUserId, 3)
    assert.equal(p.useAdmin, 1)
  })

  test('原对象被就地修改并返回同一引用', () => {
    // 原地改是刻意的：调用方写 `withScope(body, ...)` 不接返回值
    const body = { fileId: 1 }
    const out = withScope(body, { targetUserId: 5 })
    assert.equal(out, body, '应返回同一对象，调用方才不用接收返回值')
  })

  test('重复调用不会累积出多余键', () => {
    const body = { a: 1 }
    withScope(body, { targetUserId: 1, useAdmin: true })
    withScope(body, { targetUserId: 2 })
    assert.equal(body.targetUserId, 2, '后一次应覆盖')
    assert.equal(Object.keys(body).sort().join(','), 'a,targetUserId,useAdmin')
  })
})

describe('withScopeRef', () => {
  test('ref 有值时写入', () => {
    const p = withScopeRef({}, ref(9), ref(true))
    assert.equal(p.targetUserId, 9)
    assert.equal(p.useAdmin, 1)
  })

  test('ref 为 null / undefined / 0 / false 时不写', () => {
    assert.deepEqual(withScopeRef({}, ref(null), ref(false)), {})
    assert.deepEqual(withScopeRef({}, ref(undefined), ref(undefined)), {})
    assert.deepEqual(withScopeRef({}, ref(0), ref(false)), {})
  })

  test('ref 本身可以是 undefined（组件没传这个 prop）', () => {
    // useFileUpload 里 options?.targetUserId 就是这种情形
    assert.deepEqual(withScopeRef({}, undefined, undefined), {})
    assert.deepEqual(withScopeRef({}, null, null), {})
  })

  test('读的是 ref 的当前值，改 ref 后再调会跟着变', () => {
    // 注意别写 ref<number | null>(1)：这是 .mjs，不是 .ts，泛型语法不被接受，
    // 报出来是 'number is not defined' —— 一个和被测代码毫无关系的错。
    const target = ref(1)
    const p1 = {}
    withScopeRef(p1, target, ref(false))
    assert.equal(p1.targetUserId, 1)
    target.value = 5
    const p2 = {}
    withScopeRef(p2, target, ref(false))
    assert.equal(p2.targetUserId, 5, '应读当前值而不是初始值')
  })

  test('两个函数语义一致（value 形态 vs ref 形态）', () => {
    // 两个实现长得几乎一样，钉住它们对同一组输入给同一结果 ——
    // 免得将来改了一个忘了另一个
    const cases = [
      { targetUserId: 3, useAdmin: true },
      { targetUserId: 3, useAdmin: false },
      { targetUserId: 0, useAdmin: true },
      { targetUserId: null, useAdmin: true },
      {}
    ]
    for (const scope of cases) {
      const plain = withScope({}, scope)
      const viaRef = withScopeRef({}, ref(scope.targetUserId ?? null), ref(!!scope.useAdmin))
      assert.deepEqual(
        viaRef,
        plain,
        `两个函数对 ${JSON.stringify(scope)} 的结果不一致`
      )
    }
  })
})
