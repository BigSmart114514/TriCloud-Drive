// 有上限的并发执行，且**全部 settle 之后才返回**。
//
// ## 为什么单独一个文件
//
// 它原先是 copy/paste.post.ts 里的内部闭包。内部闭包导不出来，node --test
// 调不到，于是我第一版测试写了个「同构复刻」在测试文件里验证语义
// —— 结果只验证了复刻品：改 paste 里真的那一份，测试照样全绿。
// 变异扫描 13 条漏了 8 条，全部是这一个原因。
//
// 这正是本项目反复踩到的同一类错误（「只测引擎不测接线」的另一个方向）：
// **断言必须作用在被运行的代码上**，不是作用在它的副本上。
// 抽出来之后，测试 import 的就是 paste 用的同一个函数。
//
// ## 语义：任一失败不打断其余，但必须等全部结束
//
// 返回 { results, firstError }：
//   - results[i] 对应第 i 项，失败项位置是 undefined（数组按长度预分配）
//   - firstError 是**最靠前**那项的 { error, index }，全成功时为 null
//
// 与「首个错误就 reject」的区别：后者会让在飞的任务继续跑完并写入，
// 而调用方已经进入 catch 去结算 —— 于是「实际发生的」和「被记账的」对不上。
// 粘贴那个 bug 就是这样让 usedStorage 偏低的。
//
// **不**主动 abort 已在飞的 COS 调用：中途砍断只会让「对象复制到一半」这种
// 状态更难收拾。让它们自然结束、结果如实记录，反而是可推理的。
export interface SettledOutcome<R> {
  results: R[]
  firstError: { error: any; index: number } | null
}

export async function runSettled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<SettledOutcome<R>> {
  const results: R[] = new Array(items.length) as R[]
  let firstError: { error: any; index: number } | null = null

  // width 至少 1，否则 items.length === 0 时步长为 0 会死循环。
  const width = Math.max(1, limit)

  for (let start = 0; start < items.length; start += width) {
    /**
     * 每个 promise 都把 reject 转成了一个**值**，所以这里用 allSettled
     * 是多余的 —— 直接 all，也没有 unhandled rejection。
     *
     * 第一版写的 allSettled 是画蛇添足还引入了类型麻烦：它会把结果收窄成
     * PromiseSettledResult<R>，而我返回的 rejected 变体多带 index 字段，
     * TS 于是判「不是 R」也判「没有 error 属性」。转成值之后 all 就够了。
     */
    const settled = await Promise.all(
      items.slice(start, start + width).map((item, i) =>
        Promise.resolve()
          .then(() => worker(item, start + i))
          .then(
            (value) => ({ ok: true as const, value }),
            (error) => ({ ok: false as const, error, index: start + i })
          )
      )
    )
    settled.forEach((entry, i) => {
      if (entry.ok) {
        results[start + i] = entry.value
      } else if (!firstError) {
        firstError = { error: entry.error, index: entry.index }
      }
    })
  }

  return { results, firstError }
}