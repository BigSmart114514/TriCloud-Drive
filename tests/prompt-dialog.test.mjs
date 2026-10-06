// 问一句弹窗：状态机的行为测试（调真函数，不抄一份）。
//
// ## 为什么核心是行为测试
//
// 要守住的是「取消 vs 空值」「校验不过不兑现」「重入把上一个判成取消」这几条。
// 用源码正则断言看不出它们 —— 正则看得见「有 openPrompt 调用」，看不见那个
// Promise 到底有没有被兑现、兑现的是 null 还是 ''。而这几条恰恰是调用方
// 唯一的判断依据：
//
//   prompt(...)?.trim() 之后 if (!name) return   ← 取消与空值都归为「不做」
//   value === null ? null : value                 ← 取消与空值必须分开
//
// 把 null 与 '' 混为一谈，「取消」就会变成「用空密码继续解密」。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register(new URL('./helpers/resolve-nuxt-alias.mjs', import.meta.url), import.meta.url)

const { openPrompt, cancelPrompt, submitPrompt, usePromptDialog } =
  await import('../app/composables/usePromptDialog.ts')

const { request } = usePromptDialog()

/** 清掉可能残留的问题，让每个用例从「没有弹窗」开始 */
function reset() {
  cancelPrompt()
}

describe('取消 vs 空值', () => {
  test('取消兑现 null', async () => {
    reset()
    const p = openPrompt({ title: 'x' })
    cancelPrompt()
    assert.equal(await p, null)
  })

  // 这是最容易搞错的一条：确认了一个空字符串 ≠ 取消。
  test('空值不会走到 null（确认空值是合法的返回值）', async () => {
    reset()
    const p = openPrompt({ title: 'x' })
    request.value.value = 'abc'
    request.value.value = ''
    submitPrompt()
    // openPrompt 内建「不能为空」，所以空值会被拦下而不是兑现成 ''
    // —— 这是有意的，见下一条测试。要拿到 '' 必须绕开内建校验。
    assert.equal(await Promise.race([p, Promise.resolve('PENDING')]), 'PENDING',
      '空值不该被当成取消兑现掉（它应该被拦下，弹窗留着）')
    reset()
  })

  test('「不能为空」是内建的：空值提交后弹窗仍开着且带错误', () => {
    reset()
    openPrompt({ title: '新建文件夹' })
    request.value.value = ''
    submitPrompt()
    assert.notEqual(request.value, null, '校验不过时弹窗必须留着 —— 用户要能就地改')
    assert.equal(request.value.error, '不能为空')
  })

  test('纯空格的 trim 结果为空时，同样被拦下', () => {
    reset()
    openPrompt({ title: '新建文件夹', trim: true })
    request.value.value = '   '
    submitPrompt()
    assert.notEqual(request.value, null)
    assert.equal(request.value.error, '不能为空')
  })

  test('trim: false 时空格是有内容，不能被拦下', async () => {
    // 密码：`  secret  ` 与 `secret` 是两个不同的密码。
    //
    // 第一版在这里挂了个 .then() 立刻断言 resolved —— 而 .then 的回调是微任务，
    // submitPrompt 同步 resolve 之后它还没跑，于是读到 null。直接 await 那个
    // Promise 本身才对。
    reset()
    const p = openPrompt({ title: '密码', secret: true, trim: false })
    request.value.value = '  x  '
    submitPrompt()
    assert.equal(await p, '  x  ', 'trim: false 必须原样兑现')
  })
})

describe('trim 的语义', () => {
  test('trim: true 去掉首尾空格', async () => {
    reset()
    const p = openPrompt({ title: 'x', trim: true })
    request.value.value = '  hello  '
    submitPrompt()
    assert.equal(await p, 'hello')
  })

  test('trim 默认是 false（不 trim）', async () => {
    // 名字要 trim，但默认值必须是安全的那个 —— 密码那两处显式传 trim: false。
    reset()
    const p = openPrompt({ title: 'x' })
    request.value.value = '  hello  '
    submitPrompt()
    assert.equal(await p, '  hello  ')
  })
})

describe('校验', () => {
  test('校验不过：不兑现、弹窗留着、错误落在 error 上', () => {
    reset()
    openPrompt({ title: 'x', validate: (v) => (v.length < 8 ? '太短' : '') })
    request.value.value = 'abc'
    submitPrompt()
    assert.notEqual(request.value, null, '弹窗必须留着')
    assert.equal(request.value.error, '太短')
  })

  test('校验通过才兑现', async () => {
    reset()
    const p = openPrompt({ title: 'x', validate: (v) => (v.length < 8 ? '太短' : '') })
    request.value.value = 'abcdefgh'
    submitPrompt()
    assert.equal(await p, 'abcdefgh')
    assert.equal(request.value, null, '兑现后必须清掉，否则弹窗不消失')
  })

  // 「不能为空」在 validate 之前跑，所以 validate 不必重复检查。
  test('「不能为空」先于自定义校验', () => {
    reset()
    let called = false
    openPrompt({
      title: 'x',
      validate: () => { called = true; return '不该走到这里' }
    })
    request.value.value = ''
    submitPrompt()
    assert.equal(called, false, '空值时不该调用自定义校验')
    assert.equal(request.value.error, '不能为空')
  })

  // secret 下自定义校验的文案可能被用户输入污染（校验函数把输入原样回显）。
  // 那等于把密码写进界面上的红字，所以拦一道。
  test('secret 下校验错误文案被替换（不把用户输入回显出去）', () => {
    reset()
    openPrompt({
      title: 'x',
      secret: true,
      validate: (v) => `不合法：${v}`   // 危险的写法：把输入回显进文案
    })
    request.value.value = 'hunter2'
    submitPrompt()
    assert.equal(request.value.error, '输入不符合要求',
      'secret 下必须用固定文案，否则校验函数一旦回显输入就等于把密码画在屏幕上')
  })

  test('非 secret 时校验文案原样透出（那条提示是有用的）', () => {
    reset()
    openPrompt({ title: 'x', validate: (v) => `名称过长：${v.length} 字符` })
    request.value.value = 'a'.repeat(300)
    submitPrompt()
    assert.equal(request.value.error, '名称过长：300 字符')
  })
})

describe('重入', () => {
  // 连点两下「重命名」就会走到这里。不处理的话第一个 Promise 永远悬着，
  // 那个 await 在等它的 async 函数静默卡死，表现为「点了没反应」。
  test('开第二个问题时第一个被判为取消', async () => {
    reset()
    const first = openPrompt({ title: '第一个' })
    const second = openPrompt({ title: '第二个' })
    assert.equal(await first, null, '第一个必须被兑现为取消，不能悬着')
    assert.notEqual(request.value, null, '第二个应当接管')
    assert.equal(request.value.title, '第二个')
    cancelPrompt()
    assert.equal(await second, null)
  })

  test('提交之后旧问题的 resolver 不会复活', async () => {
    reset()
    const first = openPrompt({ title: 'a' })
    request.value.value = 'x'
    submitPrompt()
    assert.equal(await first, 'x')
    // 提交后 resolver 为 null；再取消一次不该影响到别的 Promise
    cancelPrompt()
    assert.equal(request.value, null)
  })
})

describe('打开时的初值', () => {
  test('defaultValue 落到 value 上', () => {
    reset()
    openPrompt({ title: '重命名', defaultValue: '旧名字.txt' })
    assert.equal(request.value.value, '旧名字.txt')
  })

  test('没有 defaultValue 时初值是空串（不是 undefined）', () => {
    // undefined 进 v-model 会让输入框显示 "undefined" 之类 —— 而且
    // `String(undefined)` 变成字符串 'undefined'，能被真的提交出去。
    reset()
    openPrompt({ title: '新建' })
    assert.equal(request.value.value, '')
    assert.equal(typeof request.value.value, 'string')
  })

  test('defaultValue 为空串时也是空串（不会被 undefined 顶掉）', () => {
    reset()
    openPrompt({ title: '密码', defaultValue: '' })
    assert.equal(request.value.value, '')
  })

  test('初值的 error 是空的（不该带着上一次的问题来）', () => {
    reset()
    openPrompt({ title: 'a', validate: () => '错' })
    request.value.value = 'x'
    submitPrompt()          // 留下 error='错'，弹窗还开着
    assert.equal(request.value.error, '错')
    openPrompt({ title: 'b' })  // 重入，新问题
    assert.equal(request.value.error, '', '新问题不该继承上一次的错误')
    cancelPrompt()
  })
})

describe('没有弹窗时的行为', () => {
  test('cancelPrompt 在没有问题时是安全的空操作', () => {
    reset()
    assert.doesNotThrow(() => cancelPrompt())
    assert.equal(request.value, null)
  })

  test('submitPrompt 在没有问题时是安全的空操作', () => {
    reset()
    assert.doesNotThrow(() => submitPrompt())
  })

  // 连点两下「确定」：第二次 resolver 已是 null，Promise 的 resolve 幂等，
  // 所以不会出错，但也不能崩。
  test('重复提交两次不出错', async () => {
    reset()
    const p = openPrompt({ title: 'x' })
    request.value.value = 'v'
    submitPrompt()
    assert.doesNotThrow(() => submitPrompt())
    assert.equal(await p, 'v')
  })
})