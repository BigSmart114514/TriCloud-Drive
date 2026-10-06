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
import { openPrompt } from '~/composables/usePromptDialog'

/** 与 server/utils/auth.ts 的 validatePassword 逐条对应 */
export function isStrongPassword(password: string): boolean {
  return password.length >= 8 && /[a-zA-Z]/.test(password) && /[0-9]/.test(password)
}

export const PASSWORD_RULE_TEXT = '至少8位，且需包含字母和数字'

/**
 * 弹窗问一个新密码，校验通过才返回。
 *
 * ## 为什么是 async
 *
 * 原来是 `window.prompt` —— **同步**的，所以调用方写的是
 * `const p = promptNewPassword(...)`。原生弹窗没法在原地校验：一提交就关闭，
 * 不合格只能弹个 toast，而用户刚输入的密码已经没了、也没了改的机会。
 *
 * 换成自绘弹窗之后就是异步的，校验不过时弹窗**留着**、错误显示在输入框下面，
 * 用户可以就地改。代价是调用方必须 await，所以名字从 prompt* 改成 ask* ——
 * 签名变了却留着 prompt 字样会骗人（看着像同步，实际返回 Promise）。
 *
 * ## secret: true
 *
 * 密码不回显。这是换掉 window.prompt 的主要理由：原生那种把密码直接画在屏幕上，
 * 肩窥、录屏、截图都看得见，系统还会留一条历史记录。
 *
 * @param subjectLabel 这条提示里的主语，例如 `用户「张三」` / `子账户「kid」`
 * @returns 取消或不合格时返回 null（**不合格时弹窗仍开着，用户可以继续改**）
 */
export async function askNewPassword(subjectLabel: string): Promise<string | null> {
  return await openPrompt({
    title: '设置新密码',
    label: `为${subjectLabel}设置新密码`,
    hint: PASSWORD_RULE_TEXT,
    // 密码不 trim：'  secret  ' 与 'secret' 是两个不同的密码，trim 掉首尾空格
    // 会让用户以为自己设的密码登不上。
    trim: false,
    secret: true,
    confirmText: '设置',
    validate: (value) =>
      isStrongPassword(value) ? '' : `密码不符合要求：${PASSWORD_RULE_TEXT}`
  })
}
