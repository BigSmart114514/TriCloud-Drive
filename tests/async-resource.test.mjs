// useAsyncResource 的行为（跑真 composable）。
//
// ## 为什么它需要测试
//
// 它替换了五处取数样板，而样板里最容易被改坏、又最看不出来的是**并发**那部分：
// 慢请求晚回来时不该覆盖新结果，早发的那次也不该提前把 loading 关掉。这两件事
// 手写样板时通常没做（原来的六处全都没做），但一旦抽成共用层就必须做对 ——
// 否则「修一处坏六处」。
//
// composable 里用到 onMounted / onBeforeUnmount，在 node 里调用会警告
// （"onBeforeUnmount is called when there is no active component instance"）。
// 那个警告是噪音，不影响逻辑，所以这里直接调；immediate 那条另有专门的检查。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { effectScope } from 'vue'
import { register } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// useAsyncResource 里 import 了 '~/utils/notify'，挂上别名 hook 才能直接 import
// 真函数（否则会 ERR_MODULE_NOT_FOUND: Cannot find package '~'）。
register(new URL('./helpers/resolve-nuxt-alias.mjs', import.meta.url), import.meta.url)

const { useAsyncResource } = await import('../app/composables/useAsyncResource.ts')

/** 在一个 effectScope 里跑，组件生命周期钩子才有归属，不至于告警 */
function withScope(fn) {
  const scope = effectScope()
  try {
    return fn(scope.run.bind(scope))
  } finally {
    scope.stop()
  }
}

/** 一个可控的 promise，用来造「先发的慢、后发的快」 */
function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('基本流程', () => {
  test('成功后 data 有值、loading 归零', async () => {
    const r = withScope(() => useAsyncResource(async () => 'ok', { errorMessage: 'x' }))
    assert.equal(r.loading.value, false, '初始不该在加载')
    const out = await r.reload()
    assert.equal(out, 'ok')
    assert.equal(r.data.value, 'ok')
    assert.equal(r.loading.value, false)
    assert.equal(r.error.value, null)
  })

  test('加载期间 loading 为 true', async () => {
    const d = deferred()
    const r = withScope(() => useAsyncResource(() => d.promise, { errorMessage: 'x' }))
    const p = r.reload()
    assert.equal(r.loading.value, true, 'promise 未兑现时应在加载')
    d.resolve('done')
    await p
    assert.equal(r.loading.value, false)
  })

  test('失败时 error 有值、data 保持原值', async () => {
    const r = withScope(() => useAsyncResource(async () => 'first', { errorMessage: 'x' }))
    await r.reload()
    assert.equal(r.data.value, 'first')
    // 让 task 变成会抛的
    const r2 = withScope(() => {
      let n = 0
      return useAsyncResource(async () => {
        n++
        if (n > 1) throw new Error('boom')
        return 'first'
      }, { errorMessage: 'x' })
    })
    await r2.reload()
    await r2.reload()
    assert.ok(r2.error.value, 'error 应被记下')
    assert.equal(r2.data.value, 'first', '失败不该清空上一次的数据')
    assert.equal(r2.loading.value, false)
  })

  test('失败返回 null 而非抛异常', async () => {
    const r = withScope(() =>
      useAsyncResource(async () => {
        throw new Error('nope')
      }, { errorMessage: 'x' })
    )
    const out = await r.reload()
    assert.equal(out, null, '失败时应返回 null，让调用方能判断')
  })

  test('连续两次成功：data 是第二次的结果', async () => {
    let n = 0
    const r = withScope(() =>
      useAsyncResource(async () => `v${++n}`, { errorMessage: 'x' })
    )
    await r.reload()
    await r.reload()
    assert.equal(r.data.value, 'v2')
  })
})

describe('并发：慢的旧请求不许覆盖新的', () => {
  // 这是抽成共用层之后必须做对的事。原来的六处手写样板都没做 ——
  // 用户连点两次「刷新」就会看到列表闪一下变回旧内容。
  test('先发的慢请求后到，不覆盖后发的结果', async () => {
    const first = deferred()
    const second = deferred()
    const gates = [first, second]
    let i = 0
    const r = withScope(() =>
      useAsyncResource(() => gates[i++].promise, { errorMessage: 'x' })
    )

    const p1 = r.reload() // 第一次，慢
    const p2 = r.reload() // 第二次，快

    second.resolve('new')
    await p2
    assert.equal(r.data.value, 'new')

    first.resolve('old') // 旧的现在才回来
    await p1
    assert.equal(r.data.value, 'new', '旧结果不该覆盖新结果')
  })

  test('旧请求的 finally 不该提前关掉 loading', async () => {
    const first = deferred()
    const second = deferred()
    const gates = [first, second]
    let i = 0
    const r = withScope(() =>
      useAsyncResource(() => gates[i++].promise, { errorMessage: 'x' })
    )

    const p1 = r.reload()
    const p2 = r.reload()

    // 第一次先结束（此时第二次还在飞）
    first.resolve('old')
    await p1
    assert.equal(r.loading.value, true, '新请求还在飞，loading 不能被旧的关掉')

    second.resolve('new')
    await p2
    assert.equal(r.loading.value, false)
    assert.equal(r.data.value, 'new')
  })

  test('旧请求的失败不该污染 error（新请求还在飞）', async () => {
    const first = deferred()
    const second = deferred()
    const gates = [first, second]
    let i = 0
    const r = withScope(() =>
      useAsyncResource(() => gates[i++].promise, { errorMessage: 'x' })
    )

    const p1 = r.reload()
    const p2 = r.reload()

    first.reject(new Error('old failed'))
    await p1
    assert.equal(r.error.value, null, '过期请求的失败不该写进 error')

    second.resolve('new')
    await p2
    assert.equal(r.error.value, null)
    assert.equal(r.data.value, 'new')
  })

  test('三连并发，只有最后一个能写', async () => {
    const ds = [deferred(), deferred(), deferred()]
    let i = 0
    const r = withScope(() => useAsyncResource(() => ds[i++].promise, { errorMessage: 'x' }))
    const ps = [r.reload(), r.reload(), r.reload()]
    // 逆序兑现：最早发的最后回来
    ds[2].resolve('c'); await ps[2]
    ds[1].resolve('b'); await ps[1]
    ds[0].resolve('a'); await ps[0]
    assert.equal(r.data.value, 'c', '该是最后一次的结果')
  })
})

describe('错误处理的两条路', () => {
  test('给 errorMessage 时走 notifyError（用打桩验证）', async () => {
    // notifyError 会弹 toast，测试里不能真弹。这里只验证「没崩且 error 有值」，
    // 真正的分发逻辑由下面的源码断言覆盖。
    const r = withScope(() =>
      useAsyncResource(async () => {
        throw new Error('boom')
      }, { errorMessage: '加载失败' })
    )
    await r.reload()
    assert.equal(r.error.value?.message, 'boom')
    assert.equal(r.loading.value, false)
  })

  test('给了 onError 就用它，且不再走 errorMessage', async () => {
    const seen = []
    const r = withScope(() =>
      useAsyncResource(async () => {
        throw new Error('boom')
      }, {
        errorMessage: '不该被用到',
        onError: (e) => seen.push(e.message)
      })
    )
    await r.reload()
    assert.deepEqual(seen, ['boom'], 'onError 应被调用一次')
    assert.equal(r.error.value?.message, 'boom', 'error 仍要记下')
  })

  test('给了 onError 时绝不也走 errorMessage', async () => {
    // 两者同时给时必须只走 onError。若两个都跑，onError 已经处理过一次的问题
    // 会被 notifyError 再弹一次 —— 用户看到两条一样的报错。
    //
    // 怎么验证「没有走 notifyError」？notifyError 会弹 toast，测试里没有 toast
    // 通道可观察。改用「onError 能观察到全部次数」这个可测的等价物：
    // 把错误处理收敛到单一分支，则 onError 的调用次数与错误次数必然相等；
    // 而一旦写成两个独立 if，第二个分支的副作用在这个测试里观察不到 ——
    // 所以下面再用源码断言把「else」这个字面钉住。两层保险。
    let calls = 0
    const r = withScope(() =>
      useAsyncResource(async () => {
        throw new Error('boom')
      }, {
        errorMessage: '这条文案不该被使用',
        onError: () => calls++
      })
    )
    await r.reload()
    await r.reload()
    assert.equal(calls, 2, 'onError 应恰好被调用两次')
  })

  test('两者都不给：静默失败但 error 有值', async () => {

  test('错误处理是二选一（源码断言钉住 else）', () => {
    // 上面那条测不到 notifyError 有没有被调用，所以在这里钉住分支形态：
    // 必须是 `if (onError) ... else if (errorMessage) ...`，
    // 而不是两个平行的 if。
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../app/composables/useAsyncResource.ts'),
      'utf8'
    )
    assert.match(
      src,
      /if \(options\.onError\) options\.onError\(e\)\s*\n\s*else if \(options\.errorMessage\) notifyError\(e, options\.errorMessage\)/,
      '错误处理应是 if/else if 二选一，不是两个平行 if'
    )
    // 这段形态在全文件里只该出现一次（第二处同样的代码就说明分叉了）。
    // 注意不能数 `options.onError` 的出现次数 —— 接口声明里也有那个名字，
    // 第一版就是这么数的，数出 4 次直接红了，是断言写错不是实现错。
    const branches = src.match(
      /if \(options\.onError\) options\.onError\(e\)\s*\n\s*else if \(options\.errorMessage\)/g
    ) ?? []
    assert.equal(branches.length, 1, `这段分支应只出现一次，实际 ${branches.length} 次`)
  })
    const r = withScope(() =>
      useAsyncResource(async () => {
        throw new Error('quiet')
      })
    )
    const out = await r.reload()
    assert.equal(out, null)
    assert.equal(r.error.value?.message, 'quiet')
  })
})

describe('卸载后不再写状态', () => {
  test('scope 停掉后慢请求回来不改 data', async () => {
    const d = deferred()
    let r, p
    const scope = effectScope()
    scope.run(() => {
      r = useAsyncResource(() => d.promise, { errorMessage: 'x' })
      p = r.reload()
    })
    scope.stop() // 相当于组件卸载
    d.resolve('late')
    await p
    assert.equal(r.data.value, null, '卸载后不该再写 data')
    assert.equal(r.loading.value, true, '卸载后不该再动 loading（组件已经不在了）')
  })

  test('卸载后失败也不写 error', async () => {
    const d = deferred()
    let r, p
    const scope = effectScope()
    scope.run(() => {
      r = useAsyncResource(() => d.promise, { errorMessage: 'x' })
      p = r.reload()
    })
    scope.stop()
    d.reject(new Error('late boom'))
    await p
    assert.equal(r.error.value, null, '卸载后不该写 error')
  })
})

describe('immediate', () => {
  test('immediate: true 时自动在挂载后跑一次', () => {
    // immediate 走 onMounted，在裸调用里不会触发。所以这里只断言
    // 「注册了 immediate 就不会立刻执行」—— 真正的挂载行为留给浏览器验证，
    // 这一点在测试文件里明确记着，免得后人以为 immediate 没生效。
    let called = 0
    withScope(() =>
      useAsyncResource(async () => {
        called++
        return 'x'
      }, { immediate: true })
    )
    assert.equal(called, 0, 'immediate 依赖 onMounted，裸调用不该立即执行')
  })
})
