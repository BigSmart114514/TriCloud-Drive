// ~/composables/useDebounced.ts
//
// 去抖 + 「后到的旧请求丢弃」的序号守卫，合在一起。
//
// ## 为什么把这两件事绑在一起
//
// 它们是同一个问题的两面：去抖让你**同时**有多个请求在飞（一个 250ms 后触发，
// 用户又改了关键词，于是第二个也飞了）。这时必须有人决定「谁的结果算数」。
//
// 而本项目里这两个是分开写的两份：
//
//   SearchDialog  有 requestId 守卫（`if (id !== requestId) return`）
//   ShareDialog   **没有** —— 只有 setTimeout + clearTimeout
//
// 于是 ShareDialog 里慢的旧请求会覆盖新结果：搜「张」慢、搜「张三」快，
// 「张」的结果后到，候选列表被刷成「张」的匹配。SearchDialog 早修好了这个
// bug，ShareDialog 上没跟上 —— 正是「同一个模式抄两遍、只修了一处」的典型。
//
// 绑在一起之后，守卫不可能被忘掉：不传 requestId 就等于放弃这一层保护，
// 而 API 不给你那个机会。
import { onBeforeUnmount } from 'vue'

export interface Debounced<T> {
  /** 触发一次去抖调用。连续调用只有最后一次会真的跑 */
  schedule: (value: T) => void
  /** 取消待执行的调用，并作废所有在飞请求的结果 */
  cancel: () => void
  /** 当前是否有待执行的调用 */
  readonly pending: boolean
  /**
   * 最近一次 schedule 拿到的序号。
   *
   * run 回调里拿自己手里的 seq 与它比较：不相等就说明自己是过期的那次，直接
   * return、不写任何状态。**这是必须的**，不是可选的加固 —— 去抖之后允许多个
   * 请求同时在飞，慢的那个后到就会覆盖新的结果。
   *
   * 用返回的 latest() 而不是直接给 seq 变量，是为了让「最新」只有一个来源；
   * cancel() 也会把它推进，所以取消之后在飞的请求同样自动作废。
   */
  latest: () => number
}

export interface DebouncedOptions<T> {
  /** 触发函数。第二个参数是这个值的序号，用来判断自己是不是最新的 */
  run: (value: T, seq: number) => void | Promise<void>
  /** 去抖间隔，默认 250（与三处调用点原先一致） */
  delay?: number
}

export function useDebounced<T>(options: DebouncedOptions<T>): Debounced<T> {
  const { run, delay = 250 } = options
  let timer: ReturnType<typeof setTimeout> | null = null
  let seq = 0

  const cancel = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    // 作废在飞请求的写权限：序号一涨，之前那些回调回来时 id !== seq，直接返回
    seq += 1
  }

  const schedule = (value: T) => {
    if (timer) clearTimeout(timer)
    const mySeq = ++seq
    timer = setTimeout(() => {
      timer = null
      void run(value, mySeq)
    }, delay)
  }

  onBeforeUnmount(cancel)

  return {
    schedule,
    cancel,
    latest: () => seq,
    get pending() {
      return timer !== null
    }
  }
}
