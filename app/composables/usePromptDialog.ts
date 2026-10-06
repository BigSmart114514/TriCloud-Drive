// 全局单例的「问一句」弹窗。取代 window.prompt / window.prompt 的密码问法。
//
// ## 为什么是单例而不是每个组件各挂一个
//
// 提问点散在三个不同的地方：
//   app/utils/password.ts        被 accounts.vue 与 manage/user.vue 调用（两个页面）
//   app/composables/useNameEditing.ts   被 FileBrowser.vue 调用
//   app/components/FilePreviewer.vue    压缩包密码
//
// 做成 props/ref 往上传，就得在 4 个宿主里各挂一次、各写一遍「打开/关闭/回填」
// 的接线，而其中三处只是转发一下。于是反过来：**状态在模块里，UI 只有一份**，
// app.vue 挂一次 `<PromptDialog />`，任何地方 `await openPrompt(...)` 就能用。
// 与 notify.ts 同一套路 —— 那也是单例（模块级 containerEl）。
//
// ## 层级：必须是 z-[70]，不能跟别的弹窗一样 z-[60]
//
// 提问会**叠在另一个弹窗之上**：AccountEditDialog 的「重置密码」与
// UserEditDialog 的「修改密码」都在弹窗开着的时候触发提问，而且那两个弹窗
// 不会因此关闭（关了会丢掉用户没保存的草稿）。
//
// 项目里五个弹窗都是 z-[60]，同层级时谁在上面取决于 Teleport 往 body 里
// 插节点的顺序 —— 那是挂载顺序决定的实现细节，不是能依赖的东西。所以这里
// 明确高一档：提问永远是栈顶那个。
//
// ## 为什么要换掉 window.prompt
//
// 1. **密码是明文回显的。** `window.prompt('请输入压缩包密码')` 把密码直接画在
//    屏幕上：肩窥、录屏、截图、还有一个留着全场历史记录的系统弹窗。
//    而这两处问的恰好都是密码。
// 2. **没法就地校验。** 原生弹窗一提交就关闭，不合格只能再弹一次 toast，
//    用户刚输入的内容没了、也没了修改的机会。
// 3. **样式与文案不受控。** 系统弹窗在深色模式/移动端上各有各的样子，
//    而项目里其余对话框都已经统一到 `ui-glass` + Transition 那一套了。
//
// ## 取消 vs 空值
//
// 原生语义必须逐字保住，因为调用方靠它区分：
//
//   resolve(null)  取消（Esc / 点遮罩 / 取消按钮）—— 调用方直接 return，什么都不做
//   resolve('')    确认了一个空值
//
// 现有代码正是这么用的：`prompt(...)?.trim()` 之后 `if (!name) return`，取消与
// 空值都归为「不做」；`getZipPassword` 则用 `value === null ? null : value`
// 把两者分开。把 null 与 '' 混为一谈会让「取消」变成「用空密码继续解密」。
//
// ## 重入
//
// 同一个问题还没答完又开一个时，上一个判成**取消**。不这么处理的话它的 Promise
// 永远悬着 —— 那个 await 在等它的 async 函数就静默卡死，表现为「点了没反应」。
// 这不是假想：连点两下「重命名」就会走到这里。
import { shallowRef } from 'vue'

export interface PromptOptions {
  /** 标题。动词短语（「新建文件夹」「重命名」），主语放 label 或 hint。 */
  title: string
  /** 输入框上方的字段名。没有就用 title。 */
  label?: string
  /** 提示文字。密码规则、加密压缩包的说明这类。 */
  hint?: string
  defaultValue?: string
  /**
   * true = 密码框（type=password，不回显、不预填、不进错误文案）。
   *
   * 两处必须传 true：设置新密码、加密压缩包的密码。
   */
  secret?: boolean
  placeholder?: string
  confirmText?: string
  cancelText?: string
  /**
   * 提交前的额外校验。返回错误文案 = 不许提交；返回 '' = 通过。
   *
   * **「不能为空」是内建的**，不需要在这里重复 —— 省掉它就不会有人漏掉，
   * 而漏掉的后果是「提交一个空名字给服务端」。
   */
  validate?: (value: string) => string
  /**
   * 提交前是否 trim。默认 **false**。
   *
   * 密码不能 trim：`  secret  ` 是两个不同的密码，trim 掉空格会让用户
   * 以为自己设的密码登不上。名字要 trim —— 首尾空格在文件系统与界面上
   * 都是噪声，而且「 a」与「a」在面包屑里看着一样。
   */
  trim?: boolean
}

export interface PromptRequest extends PromptOptions {
  /** 输入框当前内容（含未 trim 的原始输入） */
  value: string
  /** 行内错误。空串 = 没有错误 */
  error: string
}

/**
 * 当前待答的那一个问题。null = 没有弹窗。
 *
 * 用 shallowRef：这个对象整体替换（每次 openPrompt 都是新对象），内部字段
 * value / error 则靠组件直接改 —— 不需要深层响应式，省掉一层 Proxy。
 */
const request = shallowRef<PromptRequest | null>(null)

/** 未完成的 Promise 的兑现函数。null = 当前没有待答的问题。 */
let resolver: ((value: string | null) => void) | null = null

export function usePromptDialog() {
  return { request }
}

/** 把当前问题判成取消并关掉。内部与组件用。 */
export function cancelPrompt() {
  const done = resolver
  resolver = null
  request.value = null
  done?.(null)
}

/**
 * 提交。校验不过就**不兑现**，弹窗留着、错误显示在输入框下面。
 *
 * 「不兑现」是这个组件相对 window.prompt 唯一真正的行为增强：原生弹窗一提交
 * 就消失，用户填的内容连同修改机会一起没了。
 */
export function submitPrompt() {
  const r = request.value
  if (!r || !resolver) return

  const raw = r.trim ? r.value.trim() : r.value

  if (!raw) {
    // 内建校验，调用方不必重复
    r.error = r.secret ? '不能为空' : '不能为空'
    return
  }
  if (r.validate) {
    const err = r.validate(raw)
    if (err) {
      // 校验函数可能把用户输入原样回显进文案里（少见，但完全可能）。
      // secret 情况下那等于把密码写进界面上的红字，所以拦一道。
      //
      // 不像非 secret 那样直接透出 err，代价是丢掉错误里的细节 —— 但那部分
      // 信息没丢：提问方的 hint 里已经写着规则（askNewPassword 传的就是
      // PASSWORD_RULE_TEXT），红字只负责「这次没过」这一件事。
      r.error = r.secret ? '输入不符合要求' : err
      return
    }
  }

  const done = resolver
  resolver = null
  request.value = null
  done?.(raw)
}

/**
 * 问一句。返回用户输入，或 null = 取消。
 *
 * 注意这是**异步**的 —— 原来的 `window.prompt` 是同步的，所以所有调用点都要
 * 加 await。原来的名字带 prompt 字样（看着像同步），改名成 ask* 是为了不让
 * 签名骗人。
 */
export function openPrompt(options: PromptOptions): Promise<string | null> {
  // 重入：上一个还没答完就再开一个 —— 判它取消，否则它的 await 永远不返回。
  if (resolver) cancelPrompt()

  return new Promise<string | null>((resolve) => {
    resolver = resolve
    request.value = {
      ...options,
      value: options.defaultValue ?? '',
      error: ''
    }
  })
}

/**
 * 模块级状态在 SSR 下会跨请求共享。
 *
 * 这里安全，因为提问只发生在用户点击（浏览器端）：模块在服务端被 import 的
 * 那一刻没有任何问题被打开。真要加一道保险就是在 onRequest 里 cancelPrompt()，
 * 但那会给一个已经不会发生的场景加代码。
 */