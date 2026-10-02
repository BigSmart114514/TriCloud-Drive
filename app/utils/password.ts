// ~/utils/password.ts
//
// 密码强度规则 + 「弹窗问一个新密码」的交互。
//
// ## 为什么抽
//
// 规则在本项目里存在三份，且**强度不一致**：
//
//   manage/user.vue        至少8位 + 字母 + 数字
//   accounts.vue           至少8位 + 字母 + 数字   （与上面逐字相同）
//   change-password.vue    只有「至少8位」        ← 少了一半
//
// 服务端 `validatePassword`（server/utils/auth.ts）是权威版本，三条接口
// （注册 / 改密码 / 重置密码）都调它。
//
// ## 那个不一致是用户能撞上的
//
// change-password.vue 只检查长度，所以「自己改密码」可以填一个纯 8 位数字，
// 提交后被服务端 400 掉；反过来管理员「重置别人密码」却被前端拦着不让填纯
// 数字。同一个规则，同一个产品，三种待遇。统一到服务端那份之后三处一致，
// 也省掉一次「填了才报错」。
//
// 规则本身仍以服务端为准（前端只是提前说，避免白跑一趟）。
import { notify } from '~/utils/notify'

/** 与 server/utils/auth.ts 的 validatePassword 逐条对应 */
export function isStrongPassword(password: string): boolean {
  return password.length >= 8 && /[a-zA-Z]/.test(password) && /[0-9]/.test(password)
}

export const PASSWORD_RULE_TEXT = '至少8位，且需包含字母和数字'

/**
 * 弹窗问一个新密码，校验通过才返回。
 *
 * @param subjectLabel 这条提示里的主语，例如 `用户「张三」` / `子账户「kid」`
 * @returns 取消或不合格时返回 null（**不合格时已经弹过提示**）
 */
export function promptNewPassword(subjectLabel: string): string | null {
  const input = window.prompt(`为${subjectLabel}设置新密码（${PASSWORD_RULE_TEXT}）：`, '')
  // null = 用户点了取消。这与「填了但不合格」是两回事，后者已经提示过了。
  if (input === null) return null

  const password = input.trim()
  if (!isStrongPassword(password)) {
    notify(`密码不符合要求：${PASSWORD_RULE_TEXT}`, 'error')
    return null
  }
  return password
}
