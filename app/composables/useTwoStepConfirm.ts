// ~/composables/useTwoStepConfirm.ts
//
// 破坏性操作的「点两下」确认。
//
// ## 为什么不是 window.confirm
//
// 这套交互是「第一次点把按钮变成『确认删除？』，再点才真删」。用
// window.confirm 也能达到同样效果，但本项目里有些地方**故意不用它**：提示文案
// 承载的是具体的业务后果（「其所有子文件夹与文件，操作不可恢复」「已经发出去
// 的地址会立刻失效」），写在按钮上比塞进系统弹窗更容易被读完。
//
// ## 两处一模一样
//
// UserEditDialog 与 AccountEditDialog 各写了一遍，连注释都互相承认
// 「与 UserEditDialog 同一套」。
//
// ## 自动复位
//
// 第二次点击后立刻把 confirming 复位：删除失败时按钮回到「删除」，用户可以
// 重试而不是卡在「确认删除？」上等一个永远不会来的第二次点击。
import { ref, onBeforeUnmount, type Ref } from 'vue'

export interface TwoStepConfirm {
  /** 当前是否处于「已点第一下」状态 */
  confirming: Ref<boolean>
  /** 复位。关闭弹窗 / 切换被编辑的对象时都要调 */
  reset: () => void
  /**
   * 挂在删除按钮上。第一下只置位，第二下才调 onConfirm。
   * @returns 这次点击是否真的触发了 onConfirm
   */
  click: (onConfirm: () => void) => boolean
}

export function useTwoStepConfirm(autoResetMs?: number): TwoStepConfirm {
  const confirming = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null

  const reset = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    confirming.value = false
  }

  const click = (onConfirm: () => void): boolean => {
    if (!confirming.value) {
      confirming.value = true
      // 可选：过一会儿自动退回「删除」，免得用户点了第一下就忘了自己在干嘛
      if (autoResetMs && autoResetMs > 0) {
        timer = setTimeout(reset, autoResetMs)
      }
      return false
    }
    reset()
    onConfirm()
    return true
  }

  onBeforeUnmount(reset)

  return { confirming, reset, click }
}
