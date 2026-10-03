// 粘贴（copy/paste.post.ts）的事务与并发语义 —— 回归测试。
//
// ## 这次修的是什么
//
// 原来整个 544 行的粘贴**没有任何事务**（全项目只有 files/save.post.ts 与
// files/move.post.ts 有）。三个后果：
//
//   a) ensurePaths 会**提交**它建的目录 → 复制全失败时，空目录留在用户树里
//   b) 每个 worker 的「COS 复制 → INSERT → 删旧记录」三步无原子性
//   c) 并发池**首个错误就 reject**，在飞的 worker 照旧 INSERT，
//      而调用方立刻用那一刻的 successCopyBytes 退款并重算
//      → 落跑的行不在快照里 → usedStorage 偏低 → 配额被低估
//
// ## 关键：并发池的行为测试跑的是**真实现**
//
// 第一版把 runWithConcurrency 留在 paste.post.ts 的内部闭包里，测试文件里写了
// 一个「同构复刻」来验证语义。结果：改 paste 里真的那一份，测试全绿 ——
// 变异扫描 13 条漏了 8 条。
//
// 这是本项目反复踩到的同一类错误的另一个方向：「只测引擎不测接线」。
// 断言必须作用在被运行的代码上，不是作用在它的副本上。
// 所以并发池抽成了 server/utils/concurrency.ts，下面直接 import 它 ——
// paste 用的和这里测的是同一个函数。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { register } from 'node:module'

register(new URL('./helpers/resolve-nuxt-alias.mjs', import.meta.url), import.meta.url)

const { runSettled } = await import('../server/utils/concurrency.ts')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PASTE = 'server/api/copy/paste.post.ts'

const read = () => readFileSync(join(root, PASTE), 'utf8')
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
    .join('\n')
}

/** 确认 paste 引用的就是被测的同一个模块，而不是自己另写一份 */
describe('并发池：paste 用的就是被测的这份', () => {
  test('paste 从 server/utils/concurrency 导入，没有本地重写', () => {
    const code = codeOnly(read())
    assert.match(
      code,
      /import \{ runSettled \} from '~~\/server\/utils\/concurrency'/,
      'paste 必须从共享模块导入 runSettled'
    )
    assert.match(code, /await runSettled\(tasks, MAX_CONCURRENCY/, '实际调用点也要在')
    assert.doesNotMatch(
      code,
      /function runWithConcurrency|function runSettled/,
      'paste 里不该再有本地实现 —— 那会让测试验证不到真代码'
    )
  })
})

describe('runSettled：全部 settle 之后才返回', () => {
  // 直接跑 paste 用的那个函数。
  test('一个失败不影响其余项完成（这是修复的核心）', async () => {
    // 旧实现：首个 reject 之后在飞的任务照跑，但调用方已经 catch 走了，
    // 于是「跑完了」和「记账了」对不上。这里断言新语义下**全部都跑完了**。
    const done = []
    const r = await runSettled([0, 1, 2, 3, 4], 3, async (n) => {
      await new Promise((res) => setTimeout(res, 5 - n))
      done.push(n)
      if (n === 1) throw new Error('boom-1')
      if (n === 3) throw new Error('boom-3')
      return n * 10
    })
    assert.deepEqual([...done].sort((a, b) => a - b), [0, 1, 2, 3, 4], '五项必须全部被执行过')
    assert.ok(r.firstError, 'firstError 必须被记录')
    assert.equal(r.firstError.index, 1, 'firstError 应指向第一项失败')
    assert.equal(r.firstError.error.message, 'boom-1')
    assert.equal(r.results[0], 0)
    assert.equal(r.results[2], 20)
    assert.equal(r.results[4], 40, '失败项之后的成功项仍要有结果')
  })

  test('计数在返回时已是终值（旧实现在这里会是中间值）', async () => {
    // 直接模拟那个真实 bug：最后一个任务最慢，且它会成功 INSERT。
    // 旧实现里 catch 在第一个错误时就跑了，抄到的 copiedFiles 偏小。
    let inserted = 0
    const r = await runSettled([0, 1, 2], 3, async (n) => {
      await new Promise((res) => setTimeout(res, n === 2 ? 40 : 1))
      if (n === 0) throw new Error('fast-fail')
      inserted++
      return inserted
    })
    assert.equal(inserted, 2, '慢的两个任务必须都跑完')
    assert.ok(r.firstError)
    assert.equal(r.results.filter(Boolean).length, 2)
  })

  test('限流被尊重：任一时刻在飞的不超过 limit', async () => {
    // 修的时候我一度写成 Promise.all(items.map(...))，把 limit 整个丢了 ——
    // 500 个文件会一次全放。这条断言就是为了钉住那个坑。
    let active = 0
    let peak = 0
    await runSettled(Array.from({ length: 25 }, (_, i) => i), 3, async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
    })
    assert.ok(peak <= 3, `峰值并发 ${peak} 超过了 limit=3 —— 限流失效`)
    assert.ok(peak > 1, `峰值并发 ${peak}，说明根本没并发，退化成串行了`)
  })

  test('limit=1 时退化成严格串行', async () => {
    let active = 0
    let peak = 0
    await runSettled([1, 2, 3, 4], 1, async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 2))
      active--
    })
    assert.equal(peak, 1)
  })

  test('空数组不炸，且 firstError 为 null', async () => {
    const r = await runSettled([], 3, async () => 1)
    assert.deepEqual(r.results, [])
    assert.equal(r.firstError, null)
  })

  test('limit=0 或负数不会死循环（步长为 0 是经典事故）', async () => {
    // width = max(1, limit) 那个 1 就是防这个的。
    const r = await runSettled([1, 2], 0, async (n) => n)
    assert.equal(r.results[1], 2, 'limit=0 时仍应逐项跑完，而不是死循环')
    const r2 = await runSettled([1, 2], -5, async (n) => n)
    assert.equal(r2.results[0], 1, 'limit 为负数同样要能跑')
  })

  test('全部失败时 firstError 指向最靠前的一项', async () => {
    const r = await runSettled([0, 1, 2], 2, async (n) => {
      await new Promise((res) => setTimeout(res, 2))
      throw new Error(`e${n}`)
    })
    assert.ok(r.firstError)
    assert.equal(r.firstError.index, 0)
  })

  test('结算靠 ok 标志，错误对象不会被误当成结果', async () => {
    // 结算逻辑依赖 `entry.ok` 这个判别式，而不是 entry 长得像什么。
    // 丢掉 as const 后 TS 不再收窄，运行时 entry.ok 仍是 true/false，
    // 所以纯行为测试抓不到 —— 但它会让**类型**检查形同虚设，
    // 于是「结算写错了但类型仍然报错」的情况可能被误当成类型问题而绕过。
    // 这条断言钉住那个 as const。
    const src = readFileSync(join(root, 'server/utils/concurrency.ts'), 'utf8')
    assert.match(
      src,
      /\(value\) => \(\{ ok: true as const, value \}\)/,
      'fulfilled 分支的 ok 必须带 as const —— 结算靠它收窄'
    )
    assert.match(
      src,
      /\(error\) => \(\{ ok: false as const, error, index: start \+ i \}\)/,
      'rejected 分支的 ok 必须带 as const'
    )
    // 结算处必须读 ok，不能靠 truthy 判断整个对象
    assert.match(src, /if \(entry\.ok\)/, '结算必须按 entry.ok 分支，不能靠对象 truthy')
  })

  test('worker 同步抛异常也被收进 firstError（不是 unhandled rejection）', async () => {
    let unhandled = false
    const onUnhandled = () => { unhandled = true }
    process.on('unhandledRejection', onUnhandled)
    try {
      const r = await runSettled([0, 1], 2, async (n) => {
        if (n === 0) throw new Error('sync-throw')
        return n
      })
      assert.ok(r.firstError, '同步抛也要被捕获')
      assert.equal(r.results[1], 1)
      await new Promise((res) => setTimeout(res, 20))
      assert.equal(unhandled, false, '不该有 unhandledRejection')
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test('失败项在 results 里留空洞，但数组长度不变', async () => {
    // 调用方按下标对应 task，所以长度不能变（否则 destKey 映射会错位）。
    const r = await runSettled([0, 1, 2], 3, async (n) => {
      if (n === 1) throw new Error('x')
      return n
    })
    assert.equal(r.results.length, 3, '长度必须保持，调用方按下标取 destKey')
    assert.equal(r.results[1], undefined, '失败项是空洞')
  })
})

describe('paste 的事务边界（源码断言）', () => {
  test('SAVEPOINT 覆盖 ensurePaths 与复制循环', () => {
    const code = codeOnly(read())
    const savepointAt = code.indexOf("SAVEPOINT paste_tx")
    const ensureAt = code.indexOf('ensurePaths(db')
    const reserveAt = code.indexOf('reserveStorage(db')
    const workerAt = code.indexOf('cosCopyObject(')
    const releaseAt = code.lastIndexOf("RELEASE paste_tx")

    assert.ok(savepointAt > 0, '没找到 SAVEPOINT paste_tx')
    // 开点必须在 ensurePaths 之前 —— 否则它建的目录落在事务外，
    // 回滚撤不掉，而回滚撤销目录正是这次修复的目的之一
    assert.ok(savepointAt < ensureAt, `SAVEPOINT(${savepointAt}) 必须在 ensurePaths(${ensureAt}) 之前`)
    assert.ok(savepointAt < reserveAt, 'SAVEPOINT 必须包住 reserveStorage，否则预占撤不回')
    assert.ok(savepointAt < workerAt, 'SAVEPOINT 必须包住复制循环')
    assert.ok(releaseAt > workerAt, 'RELEASE 必须在所有写入之后')

    /**
     * 「顺序对」还不够 —— 还要保证这中间**没有 RELEASE**。
     *
     * 纯顺序断言有个盲区：有人在 SAVEPOINT 之后紧跟一个 RELEASE、再开一个
     * SAVEPOINT，位置仍然「在 ensurePaths 之前」，但外层事务已经被关掉了，
     * 目录重新落到事务外。而这恰好是个很自然会犯的改法：有人看到
     * ensurePaths 自带 savepoint，以为该先把外层的关掉。
     *
     * 变异扫描就是被这条抓到后补上的。
     */
    const between = code.slice(savepointAt, ensureAt)
    assert.doesNotMatch(
      between,
      /RELEASE\s+\w+/,
      'SAVEPOINT 与 ensurePaths 之间出现了 RELEASE —— 外层事务被提前关闭，' +
        'ensurePaths 建的目录就落在事务外，回滚撤不掉了'
    )
  })

  test('全败时回滚 + 补偿删除 COS 对象', () => {
    const code = codeOnly(read())
    // 一个都没成功 → 回滚。少了这条，ensurePaths 建的空目录会留在用户树里。
    assert.match(
      code,
      /if \(copiedFiles === 0 && tasks\.length > 0\) \{[\s\S]{0,400}?ROLLBACK TO paste_tx/,
      '「一个都没成功」必须整段回滚'
    )
    // 事务撤销不了 COS，所以要按已复制的 key 补偿删除
    assert.match(code, /copiedKeys\.push\(destKey\)/, '必须记录已复制成功的 key')
    assert.match(
      code,
      /ROLLBACK TO paste_tx[\s\S]{0,300}?deleteCosObject\(key\)/,
      '回滚之后必须补偿删除 COS 对象 —— 事务管不到桶里'
    )
  })

  test('补偿删除在 INSERT 之前登记（顺序反了就漏一个孤儿）', () => {
    const code = codeOnly(read())
    const push = code.indexOf('copiedKeys.push(destKey)')
    const insert = code.indexOf('INSERT INTO files')
    assert.ok(push > 0, '没找到 copiedKeys.push')
    assert.ok(insert > 0, '没找到 INSERT')
    assert.ok(
      push < insert,
      `登记必须在 INSERT 之前（push=${push}, insert=${insert}）：` +
        'COS 复制已经成功，对象在桶里了；INSERT 抛错回滚时若还没登记，就成了没人认领的孤儿'
    )
  })

  test('两条回滚路径各自都带补偿删除（不能只有一条）', () => {
    // 上一条只查了 catch 分支，于是「全败分支的补偿删除被删掉」这条变异
    // 溜过去了 —— 两条路径写法几乎一样，肉眼很难看出少了一处。
    // 所以改成**逐条**检查：所有出现 ROLLBACK TO paste_tx 的地方，
    // 其后 400 字符内都必须出现 deleteCosObject。
    const code = codeOnly(read())
    const rollbacks = [...code.matchAll(/ROLLBACK TO paste_tx/g)].map((m) => m.index)
    assert.ok(rollbacks.length >= 2, `应至少有两条回滚路径（全败 + catch），实际 ${rollbacks.length} 条`)

    rollbacks.forEach((at, i) => {
      const after = code.slice(at, at + 400)
      assert.match(
        after,
        /deleteCosObject/,
        `第 ${i + 1} 条回滚路径（偏移 ${at}）之后没有 deleteCosObject —— ` +
          '事务撤销不了桶里的对象，这里不回滚就会留下孤儿'
      )
    })
  })

  test('补偿删除在 catch 分支里也有（bookkeeping 抛错时同样要清）', () => {
    const code = codeOnly(read())
    // 取**最后一个** worker 循环之后的 catch（粘贴里有多处 catch，
    // 前面那些是权限校验的，只回传 statusMessage 不碰事务）。
    // 第一版用 indexOf 取到第一个（'部分内容不存在'那个），于是断言恒假。
    const workerAt = code.indexOf('await runSettled(')
    assert.ok(workerAt > 0, '没找到 runSettled 调用')
    const catchAt = code.indexOf('} catch (e: any) {', workerAt)
    assert.ok(catchAt > workerAt, '没找到复制循环之后的 catch 分支')
    const after = code.slice(catchAt, catchAt + 400)
    assert.match(after, /ROLLBACK TO paste_tx/, 'catch 分支也要回滚')
    assert.match(after, /deleteCosObject/, 'catch 分支也要补偿删除 COS')
  })

  test('回滚路径不额外套 catch（已在错误路径上，不能盖掉真正的失败原因）', () => {
    const code = codeOnly(read())
    assert.match(code, /import \{ deleteCosObject \} from '~~\/server\/utils\/cos'/)
    assert.doesNotMatch(
      code,
      /deleteCosObject\([^)]*\)\.catch\(/,
      'deleteCosObject 本身永不抛（见 server/utils/cos.ts），不需要 .catch —— 套上反而掩盖失败'
    )
  })

  test('本地那份无防护的 cosDeleteObject 已经删掉', () => {
    const code = codeOnly(read())
    assert.doesNotMatch(
      code,
      /function cosDeleteObject/,
      '本地那份是第 5 份 COS 删除样板（无守卫、无日志），应统一走 server/utils/cos.ts'
    )
    assert.doesNotMatch(code, /\brejectAll\b/, '并发池不再是「首错即 reject」')
  })

  test('提交路径是 RELEASE 而不是 SAVEPOINT', () => {
    const code = codeOnly(read())
    // 换掉的话事务永不结束，后续写入全在这个 savepoint 里。
    assert.match(
      code,
      /RELEASE paste_tx[\s\S]{0,120}?const actualNet = Math\.max/,
      '成功路径必须 RELEASE 之后再结算配额'
    )
  })

  test('部分成功仍走原有的退款路径（没有被新回滚分支吞掉）', () => {
    const code = codeOnly(read())
    // copiedFiles === 0 才回滚。部分成功时目录/记录是真的建出来了，
    // 必须保留「按实际净增退款」的既有语义。
    assert.match(
      code,
      /const actualNet = Math\.max\(0, successCopyBytes - successFreedBytes\)/,
      '部分成功时仍要按实际净增退款'
    )
    assert.match(code, /recalculateUsedStorage\(userId\)/, '保留兜底重算')
    assert.match(code, /const outcome = await runSettled\(/)

    /**
     * failed 必须由 outcome.firstError 推导。
     *
     * 原来写的是 `failed = tasks.length - copiedFiles`（「余下未成功的任务数」）。
     * 那在并发下不成立：某个 worker 失败不代表其余没跑完的算失败，
     * 而 runSettled 的契约是**全部跑完**，所以「未完成」这个数根本不存在。
     * 用它会让「1 个失败 + 4 个成功」报成 failed=4。
     *
     * 断言写成「必须出现 firstError，且不能再有 tasks.length - copiedFiles」：
     * 前半句挡住新写法被改回，后半句挡住旧写法复活。
     */
    assert.match(
      code,
      /outcome\.firstError/,
      'failed 必须由 outcome.firstError 推导，而不是「余下未完成」—— ' +
        'runSettled 的契约是全部跑完，「未完成」这个数不存在'
    )
    // 注意：`tasks.length - copiedFiles` 本身**是对的**（任务总数 - 成功数），
    // 只允许它出现在 outcome.firstError 的三元里。裸写（把 0 那支去掉）
    // 才是错的 —— 那是「余下未完成的任务数」，而并发下没有「未完成」这回事。
    //
    // 只看**赋值语句**：`let failed = 0` 是声明，`failed === 0` 是读取，
    // 两者都不算（第一版没排除声明，扫出 3 处就判红了）。
    const assignments = code
      .split('\n')
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => /^\s*failed\s*=[^=]/.test(l))
      .map(([n, l]) => `${n}: ${l.trim()}`)
    assert.equal(
      assignments.length,
      1,
      `failed 只该赋值一次，实际 ${assignments.length} 处：\n` + assignments.join('\n')
    )
    assert.match(
      assignments[0],
      /outcome\.firstError \? tasks\.length - copiedFiles : 0/,
      'failed 必须由 outcome.firstError 守卫（去掉 0 那支就变成「余下未完成」，并发下不成立）'
    )
  })
})