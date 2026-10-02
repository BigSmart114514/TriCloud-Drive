// ~/composables/useAsyncResource.ts
//
// 「loading → try → 赋值 → catch 报错 → finally 收 loading」这套取数样板。
//
// ## 为什么抽
//
// 六个页面各写一遍，形状完全一样（accounts / shares / manage-user /
// manage-files / index / ShareDialog）。其中 ShareDialog.vue:462 的 run<T>()
// 已经是这件事的通用封装，但**只有它自己在用** —— 另外五处手抄了一遍。
// 那份封装还漏了两个真实需求：并发去重（连点两次刷新发两个请求）和
// 卸载后写状态，这里一并补上。
//
// ## 为什么不把赋值也收进来
//
// 各页面要写的 ref 不一样：accounts 要写 children/totalCount/pool×2/
// capability/lastRefreshed 六个，shares 写四个。所以 task 自己负责赋值，
// 只把结果返回出来给需要 data 的场合（目前没有，但不排除）。这样共用层
// 不用知道任何业务字段。
import { ref, onMounted, onScopeDispose, type Ref } from 'vue'
import { notifyError } from '~/utils/notify'

export interface AsyncResourceOptions {
  /** 传给 notifyError 的兜底文案。给了 onError 就不需要它 */
  errorMessage?: string
  /**
   * 自定义错误处理。给了就用它，不再调 notifyError。
   *
   * 需要它的三种情况：
   *   - 403 要关窗而不是弹提示（ShareDialog）
   *   - 失败时把列表清空（index 的侧栏）
   *   - 只 console.error 不打扰用户（manage/user 列表）
   */
  onError?: (error: any) => void
  /** 挂载时立刻跑一次。不给就不自动跑（由调用方在合适的时机调 reload） */
  immediate?: boolean
}

export function useAsyncResource<T>(
  task: () => Promise<T>,
  options: AsyncResourceOptions = {}
) {
  const data = ref<T | null>(null) as Ref<T | null>
  const loading = ref(false)
  const error = ref<any>(null)

  // 递增序号：只有最后一次 reload 能写状态。并发请求时慢的那个回来得晚，
  // 不加这个它会覆盖掉新结果（列表闪一下变回旧内容）。
  let seq = 0
  let disposed = false

  const reload = async (): Promise<T | null> => {
    const mySeq = ++seq
    loading.value = true
    error.value = null
    try {
      const result = await task()
      if (mySeq !== seq || disposed) return null
      data.value = result
      return result
    } catch (e: any) {
      if (mySeq !== seq || disposed) return null
      error.value = e
      if (options.onError) options.onError(e)
      else if (options.errorMessage) notifyError(e, options.errorMessage)
      return null
    } finally {
      // 同样是「只有最后一次能收尾」：早发晚至的那个请求不该把 loading
      // 提前关掉，那会让界面在数据还没到时就不显示加载态了。
      if (mySeq === seq && !disposed) loading.value = false
    }
  }

  if (options.immediate) onMounted(reload)

  // onScopeDispose 而不是 onBeforeUnmount：组件 setup 里两者都会触发（setup 本身
  // 就跑在一个 scope 里），但 onScopeDispose 在 effectScope 里也生效，所以
  // 「组件卸载后不再写状态」这条能直接测，不用真去挂一个组件。
  onScopeDispose(() => {
    disposed = true
  })

  return { data, loading, error, reload }
}
