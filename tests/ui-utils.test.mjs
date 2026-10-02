// 三件小事的行为测试：密码规则、两段式确认、去抖 + 序号守卫。
//
// ## 为什么这三个够格测
//
// 1. **密码规则**：前端有三份，服务端一份权威版。原先 change-password.vue
//    只查长度，比另外两处少一半条件 —— 用户填了纯 8 位数字才被服务端 400。
//    「前端规则与服务端不一致」这件事本身就该被钉住。
//
// 2. **两段式确认**：第二下才真删。这个逻辑写错的后果是「一点就删」，
//    而组件层面没法测。
//
// 3. **去抖 + 序号守卫**：SearchDialog 有守卫、ShareDialog 没有。抽出共用实现
//    之后守卫是 API 的一部分（run 必须收 seq），所以「守卫在不在」可以测。
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { effectScope } from 'vue'
import { register } from 'node:module'

register(new URL('./helpers/resolve-nuxt-alias.mjs', import.meta.url), import.meta.url)

/** 等一会儿。定时器相关的测试用真等（delay 取毫秒级），不 mock —— 这里要验的就是「时间到了才跑」 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const { isStrongPassword, PASSWORD_RULE_TEXT } = await import('../app/utils/password.ts')
const { useTwoStepConfirm } = await import('../app/composables/useTwoStepConfirm.ts')
const { useDebounced } = await import('../app/composables/useDebounced.ts')

describe('isStrongPassword', () => {
  // 这四条与服务端 validatePassword 一一对应：
  //   length >= 8 && /[a-zA-Z]/ && /[0-9]/
  // 长度边界单列一组。第一版把 'abcd123'（7 位）标成「正好 8 位该过」，
  // 断言红了才发现是自己数错位数 —— 边界值必须逐个写出来，不能靠注释描述。
  test('长度边界：7 位不过、8 位过', () => {
    assert.ok(!isStrongPassword('abc1234'), '7 位不过')
    assert.ok(!isStrongPassword('a123456'), '7 位不过（数字开头）')
    assert.ok(isStrongPassword('abcd1234'), '8 位过')
    assert.ok(isStrongPassword('a1234567'), '8 位过（数字开头）')
    assert.ok(!isStrongPassword('abc123'), '7 位不过')
  })

  test('够长且有字母有数字', () => {
    assert.ok(isStrongPassword('abcd1234'))
    assert.ok(isStrongPassword('a1234567'))
    assert.ok(isStrongPassword('Passw0rdPassw0rd'))
  })

  test('不够 8 位', () => {
    assert.ok(!isStrongPassword('abc123'), '7 位')
    assert.ok(!isStrongPassword('a1'), '2 位')
    assert.ok(!isStrongPassword(''), '空串')
    // 'abcd1234' 才是 8 位 —— 第一版写成 'abcd123'（7 位）还标注「正好 8 位」，
    // 断言红了才发现自己数错了位数
    assert.ok(isStrongPassword('abcd1234'), '正好 8 位该过')
  })

  test('只有数字', () => {
    // change-password.vue 原先只查长度，于是这一类能填、能提交、被服务端 400
    assert.ok(!isStrongPassword('12345678'))
    assert.ok(!isStrongPassword('00000000'))
  })

  test('只有字母', () => {
    assert.ok(!isStrongPassword('abcdefgh'))
  })

  test('有字母数字但夹在中间', () => {
    assert.ok(isStrongPassword('!!!!!!!!a1'), '特殊字符不影响判定')
  })

  test('规则文案自洽', () => {
    // 提示文案与实际规则对不上是常见退化：规则改了文案没改
    assert.match(PASSWORD_RULE_TEXT, /8/)
    assert.match(PASSWORD_RULE_TEXT, /字母/)
    assert.match(PASSWORD_RULE_TEXT, /数字/)
  })
})

describe('useTwoStepConfirm', () => {
  let scope
  beforeEach(() => { scope = effectScope() })
  afterEach(() => { scope?.stop() })

  test('第一下不触发，只置位', () => {
    let fired = 0
    const t = scope.run(() => useTwoStepConfirm())
    const confirmed = t.click(() => fired++)
    assert.equal(confirmed, false, '第一下不该触发')
    assert.equal(fired, 0)
    assert.equal(t.confirming.value, true, '应进入确认态')
  })

  test('第二下才触发', () => {
    let fired = 0
    const t = scope.run(() => useTwoStepConfirm())
    t.click(() => fired++)
    const confirmed = t.click(() => fired++)
    assert.equal(confirmed, true, '第二下应触发')
    assert.equal(fired, 1)
    assert.equal(t.confirming.value, false, '触发后应复位')
  })

  test('触发后复位，可以重新走一轮', () => {
    // 删除失败时按钮回到「删除」，用户能重试
    let fired = 0
    const t = scope.run(() => useTwoStepConfirm())
    t.click(() => fired++)
    t.click(() => fired++)
    t.click(() => fired++)
    assert.equal(fired, 1, '第三下只是又进入确认态')
    t.click(() => fired++)
    assert.equal(fired, 2, '第四下是真动作')
  })

  test('reset 清掉确认态', () => {
    const t = scope.run(() => useTwoStepConfirm())
    t.click(() => {})
    assert.equal(t.confirming.value, true)
    t.reset()
    assert.equal(t.confirming.value, false)
    // reset 之后第一下又只是置位
    let fired = 0
    t.click(() => fired++)
    assert.equal(fired, 0)
  })

  test('reset 也清掉待触发的自动复位定时器', async () => {
    // 这条测的是「reset 之后不会再被旧定时器打一下」。
    // 若 reset 只置 confirming=false 而不清 timer，旧定时器照样会到点，
    // 把**新一次**点击刚建立的确认态复位掉 —— 用户就永远等不到第二次确认。
    //
    // 关键在时序：reset 之后要隔一会儿再 click，让两个定时器的到点时刻错开。
    // 紧接着 click 的话新旧同时到点，测不出差别（第一版就这么写的，
    // 结果 reset 没清定时器也照样过）。
    const t = scope.run(() => useTwoStepConfirm(50))
    t.click(() => {})      // A：约 50ms 后触发
    await wait(5)
    t.reset()              // 正确实现应清掉 A
    await wait(25)         // 到 30ms，此时还没到 A 的 50ms
    t.click(() => {})      // B：约 80ms 后触发
    await wait(30)         // 到 60ms —— 已过 A 的时点，还没到 B 的
    assert.equal(t.confirming.value, true, '旧定时器不该把新的确认态打掉')
    t.reset()
  })
})

describe('useDebounced', () => {
  // 定时器是真等（delay 取 1~5ms），避免测试变慢。

  test('默认间隔是 250ms（不传 delay 时）', async () => {
    // 钉住默认值：四处调用点原先都写死 250，抽成共用后由默认值决定。
    // 若默认值被改成 0，用户每敲一个字符就发一次请求。
    const scope = effectScope()
    const seen = []
    const d = scope.run(() => useDebounced({ delay: undefined, run: (v) => seen.push(v) }))
    d.schedule('a')
    await wait(80)
    assert.deepEqual(seen, [], '80ms 内不该跑（默认 250ms）')
    await wait(300)
    assert.deepEqual(seen, ['a'], '250ms 之后才跑')
    scope.stop()
  })

  test('连续 schedule 只跑最后一次', async () => {
    const scope = effectScope()
    const seen = []
    const d = scope.run(() =>
      useDebounced({ delay: 20, run: (v) => seen.push(v) })
    )
    d.schedule('a')
    d.schedule('b')
    d.schedule('c')
    assert.deepEqual(seen, [], '还不该跑')
    await wait(60)
    assert.deepEqual(seen, ['c'], '只有最后一次')
    scope.stop()
  })

  test('pending 反映有没有待执行的调用', async () => {
    const scope = effectScope()
    const d = scope.run(() => useDebounced({ delay: 20, run: () => {} }))
    assert.equal(d.pending, false)
    d.schedule('a')
    assert.equal(d.pending, true)
    await wait(60)
    assert.equal(d.pending, false, '跑完就该没有待执行的了')
    scope.stop()
  })

  test('cancel 取消待执行', async () => {
    const scope = effectScope()
    const seen = []
    const d = scope.run(() =>
      useDebounced({ delay: 20, run: (v) => seen.push(v) })
    )
    d.schedule('a')
    d.cancel()
    await wait(60)
    assert.deepEqual(seen, [], 'cancel 后不该再跑')
    scope.stop()
  })

  test('latest 单调递增，cancel 也推进', () => {
    const scope = effectScope()
    const d = scope.run(() => useDebounced({ delay: 1000, run: () => {} }))
    const a = d.latest()
    d.schedule('x')
    const b = d.latest()
    assert.ok(b > a, 'schedule 应推进序号')
    d.cancel()
    assert.ok(d.latest() > b, 'cancel 也应推进，让在飞的请求作废')
    scope.stop()
  })

  // 这条是 ShareDialog 那个 bug 的正面测试：
  // 两次请求都在飞，先发的后到 —— 它的 seq 已经过期，回调必须能识别出来。
  // run 必须收到**它自己那次**的序号，而不是回调执行时的最新序号。后者会让
  // 每个回调都以为自己是最新的，守卫彻底失效 —— 而这正是 ShareDialog 原本
  // 的状态（压根没有守卫）。
  test('run 拿到的是自己那次的序号，不是回调执行时的最新值', async () => {
    const scope = effectScope()
    const seenSeqs = []
    const d = scope.run(() =>
      useDebounced({
        delay: 5,
        run: (v, seq) => {
          seenSeqs.push([v, seq])
        }
      })
    )
    d.schedule('a')
    // 立刻读 latest()：此刻它就等于这次 schedule 分配到的序号（还没涨）
    const seqA = d.latest()
    await wait(20)
    d.schedule('b')
    const seqB = d.latest()
    await wait(20)
    assert.equal(seenSeqs.length, 2)
    // 两次的序号必须不同，且第一次的必须小于第二次
    assert.notEqual(seenSeqs[0][1], seenSeqs[1][1], '两次序号不该相同')
    assert.ok(seenSeqs[0][1] < seenSeqs[1][1], '序号应递增')
    assert.deepEqual(seenSeqs.map((s) => s[0]), ['a', 'b'])
    // 关键：run 拿到的必须**就是** schedule 时分配的那个序号。
    // 只断言「递增且不同」是不够的 —— 若实现写成回调执行时再取
    // （`run(value, ++seq)`），序号依然递增，断言照样全过，但守卫已失效。
    assert.deepEqual(seenSeqs, [['a', seqA], ['b', seqB]])
    scope.stop()
  })

  test('序号守卫：过期请求能识别自己', async () => {
    const scope = effectScope()
    const gates = []
    const d = scope.run(() =>
      useDebounced({
        delay: 5,
        run: async (v, seq) => {
          await new Promise((r) => gates.push({ v, seq, r }))
        }
      })
    )
    d.schedule('张')
    await wait(20) // 第一个跑起来了，悬着
    d.schedule('张三')
    await wait(20) // 第二个也跑起来了

    assert.equal(gates.length, 2, '两个请求都该在飞')
    const [first, second] = gates
    // 关键：第一个跑完后拿到的 latest 已经不是它的 seq 了
    assert.notEqual(first.seq, d.latest(), '第一个请求应已过期')

    // 逆序兑现：慢的先发、后到的先回
    second.r()
    await wait(5)
    assert.equal(d.latest(), second.seq, '最新的那次就是第二个')
    first.r()
    await wait(5)
    assert.notEqual(first.seq, d.latest(), '第一个回来时仍应判定为过期')
    scope.stop()
  })

  test('取消后所有在飞请求都作废', async () => {
    const scope = effectScope()
    let resolveIt
    const d = scope.run(() =>
      useDebounced({
        delay: 5,
        run: async (v, seq) => {
          await new Promise((r) => { resolveIt = () => r(seq) })
        }
      })
    )
    d.schedule('a')
    await wait(20)
    d.cancel()
    const seqAtResolve = await resolveIt()
    assert.notEqual(seqAtResolve, d.latest(), 'cancel 之后在飞的都该作废')
    scope.stop()
  })

  test('autoReset：到点自动退回初始态', async () => {
    const scope = effectScope()
    const d = scope.run(() => useDebounced({ delay: 5, run: () => {} }))
    void d
    const t = scope.run(() => useTwoStepConfirm(20))
    t.click(() => {})
    assert.equal(t.confirming.value, true)
    await wait(60)
    assert.equal(t.confirming.value, false, '超时后应自动复位')
    scope.stop()
  })
})
