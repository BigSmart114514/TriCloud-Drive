// 提问弹窗的接线：谁在问、有没有 await、密码有没有隐藏。
//
// ## 与 prompt-dialog.test.mjs 的分工
//
//   prompt-dialog.test.mjs          状态机的**行为**（调真函数：兑现什么、留不留弹窗）
//   本文件                          上面测不到的那部分：调用点有没有漏掉某项配置
//
// 为什么调用点只能这么测：改的是 .vue 与页面，组件挂载不了（项目没有
// @vue/test-utils / happy-dom），而「这里忘了传 secret」这种漏项恰恰最该抓 ——
// 它不会报错，只会让密码明文显示。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from '@vue/compiler-sfc'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*[*]/.test(l))
    .join('\n')
}

const scriptOf = (p) => {
  const { descriptor, errors } = parse(read(p), { filename: p })
  assert.equal(errors?.length ?? 0, 0, `${p} SFC 解析出错`)
  return codeOnly(descriptor.scriptSetup?.content ?? '')
}
const templateOf = (p) => {
  const { descriptor, errors } = parse(read(p), { filename: p })
  assert.equal(errors?.length ?? 0, 0, `${p} SFC 解析出错`)
  return codeOnly(descriptor.template?.content ?? '')
}

/** 找出 `openPrompt({...})` 那个对象字面量的正文（按括号配平，不用正则） */
function promptOptionsOf(src, marker) {
  const at = src.indexOf(marker)
  assert.ok(at > 0, `没找到 ${marker}`)
  const open = src.indexOf('{', src.indexOf('openPrompt(', at))
  assert.ok(open > 0, '没找到 openPrompt 的参数对象')
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  throw new Error('括号没配平 —— openPrompt 的参数对象被截断了')
}

describe('原生 window.prompt 已经清空', () => {
  // 判据是**全项目**扫，而不是逐个文件列 —— 那种清单每次新增调用点就会漏。
  // 注释里的提及不算，所以先剥注释。
  const APP_DIR = join(root, 'app')

  test('app/ 下没有任何 window.prompt 或裸 prompt(', () => {
    const hits = []
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        const st = statSync(full)
        if (st.isDirectory()) { walk(full); continue }
        if (!/\.(vue|ts)$/.test(name)) continue
        const src = codeOnly(readFileSync(full, 'utf8'))
        // 排除 openPrompt / askNewPassword 这些新名字：只找独立标识符
        const bad = src.match(/(^|[^.\w])prompt\s*\(|window\s*\.\s*prompt\s*\(/g)
        if (bad) hits.push(`${full.replace(root + '/', '')}: ${bad.join(', ')}`)
      }
    }
    walk(APP_DIR)
    assert.deepEqual(hits, [], `还有原生 prompt：\n${hits.join('\n')}`)
  })

  test('旧函数名 promptNewPassword 已无残留（签名变了，名字得跟着变）', () => {
    // 它现在是 async 的。名字留着 prompt 字样会让人以为还是同步的。
    for (const p of ['app/utils/password.ts', 'app/pages/accounts.vue', 'app/pages/manage/user.vue']) {
      assert.doesNotMatch(codeOnly(read(p)), /promptNewPassword/, `${p} 还有 promptNewPassword`)
    }
    assert.match(codeOnly(read('app/utils/password.ts')), /export async function askNewPassword/)
  })
})

describe('密码必须隐藏', () => {
  const secretSites = [
    ['app/utils/password.ts', 'askNewPassword 的设置新密码'],
    ['app/components/FilePreviewer.vue', 'FilePreviewer 的压缩包密码']
  ]

  for (const [p, label] of secretSites) {
    test(`${label}：传 secret: true`, () => {
      const opts = promptOptionsOf(codeOnly(read(p)), p.includes('password') ? 'openPrompt({' : 'return await openPrompt({')
      assert.match(
        opts,
        /secret:\s*true/,
        `${label} 必须传 secret: true —— 否则密码明文显示在屏幕上（肩窥/录屏/截图）`
      )
    })

    test(`${label}：传 trim: false`, () => {
      const opts = promptOptionsOf(codeOnly(read(p)), p.includes('password') ? 'openPrompt({' : 'return await openPrompt({')
      assert.match(
        opts,
        /trim:\s*false/,
        `${label} 必须传 trim: false —— '  pw  ' 与 'pw' 是两个不同的密码，` +
          'trim 掉首尾空格会让用户输对了却解不开'
      )
    })
  }

  test('密码框默认就是隐藏的（revealed 初始为 false）', () => {
    const src = scriptOf('app/components/PromptDialog.vue')
    assert.match(
      src,
      /const revealed = ref\(false\)/,
      'revealed 必须初始为 false —— secret 的全部意义就在默认隐藏'
    )
    // 而 :type 由它决定，所以「默认隐藏」这件事真的落在渲染上
    assert.match(
      src,
      /request\.value\?\.secret && !revealed\.value \? 'password' : 'text'/,
      'type 必须由 secret && !revealed 决定 —— 只判 secret 的话「显示」按钮是摆设'
    )
  })

  test('每次开新问题都复位 revealed（上一题露着，下一题不该接着露）', () => {
    const src = scriptOf('app/components/PromptDialog.vue')
    const at = src.indexOf('watch(request')
    assert.ok(at > 0, '没找到 watch(request)')
    const body = src.slice(at, at + 300)
    assert.match(
      body,
      /revealed\.value = false/,
      '开新问题时必须复位 revealed —— 否则上一题按了「显示」，下一题一打开就是明文'
    )
  })

  test('校验错误文案在 secret 下不会回显用户输入', () => {
    const src = codeOnly(read('app/composables/usePromptDialog.ts'))
    assert.match(
      src,
      /r\.error = r\.secret \? '输入不符合要求' : err/,
      'secret 下必须用固定文案 —— 校验函数一旦把输入回显进文案，等于把密码画在红字上'
    )
  })
})

describe('名字类提示：trim 与校验口径', () => {
  const dnd = 'app/composables/useNameEditing.ts'

  test('三处都传 trim: true（名字要 trim）', () => {
    const src = codeOnly(read(dnd))
    const trims = [...src.matchAll(/trim:\s*true/g)]
    assert.equal(trims.length, 3, `新建文件夹 / 重命名文件夹 / 重命名文件 三处都该 trim，实际 ${trims.length} 处`)
  })

  test('三处都传 confirmText（文案要说清这一步做什么）', () => {
    const src = codeOnly(read(dnd))
    assert.match(src, /confirmText:\s*'创建'/)
    assert.equal([...src.matchAll(/confirmText:\s*'保存'/g)].length, 2)
  })

  // 重命名文件时用户可能删掉扩展名，服务端收到的是「补完扩展名之后」的名字。
  // 校验也必须作用在那个最终名字上，否则 255 的判定与实际提交的值对不上。
  test('重命名文件：校验作用在「补完扩展名之后」的名字上', () => {
    const src = codeOnly(read(dnd))
    assert.match(
      src,
      /validate:\s*nameValidator\(false, \(raw\) => keepExtIfNone\(file\.filename, raw\)\)/,
      '校验必须走 keepExtIfNone —— 否则用户填一个 250 字符的名字、补上 .tar.gz 后超长，' +
        '前端放行而服务端 400'
    )
    // 而且提交时用的也是同一个变换（规则只有一处定义）
    assert.match(src, /const finalName = keepExtIfNone\(file\.filename, entered\)/)
  })

  test('文件夹名走 isFolder=true（要挡 . 与 ..）', () => {
    const src = codeOnly(read(dnd))
    assert.match(src, /validate:\s*nameValidator\(true\)/)
    assert.equal([...src.matchAll(/validate:\s*nameValidator\(true\)/g)].length, 2,
      '新建文件夹与重命名文件夹两处')
    // isFolder 的判定本身还在
    assert.match(src, /isFolder && \(name === '\.' \|\| name === '\.\.'\)/)
  })

  test('取消仍然等于「什么都不做」', () => {
    const src = codeOnly(read(dnd))
    // 两处 `== null` 与一处 `!name`：与原来的 prompt(...)?.trim() 语义一致
    assert.equal([...src.matchAll(/if \(entered == null\) return/g)].length, 2)
    assert.match(src, /if \(!name\) return/)
  })
})

describe('调用点全部 await（签名从同步变成异步）', () => {
  // window.prompt 是同步的，改成弹窗后 openPrompt 返回 Promise。
  // 漏一个 await 的后果很隐蔽：拿到的是 Promise 对象而不是字符串，
  // 而 `!promise` 恒为 false，于是「校验」全部通过、真正提交上去的是 "[object Promise]"。
  const sites = [
    'app/composables/useNameEditing.ts',
    'app/utils/password.ts',
    'app/components/FilePreviewer.vue',
    'app/pages/accounts.vue',
    'app/pages/manage/user.vue'
  ]

  test('openPrompt / askNewPassword 每次调用都有 await', () => {
    for (const p of sites) {
      const src = codeOnly(read(p))
      const calls = [...src.matchAll(/(await\s+)?(openPrompt|askNewPassword)\s*\(/g)]
      for (const m of calls) {
        // `export async function askNewPassword(` 是声明，不是调用
        const before = src.slice(Math.max(0, m.index - 40), m.index)
        if (/function\s*$/.test(before)) continue
        assert.ok(
          m[1] !== undefined,
          `${p} 有一处 ${m[2]}() 没有 await —— 会拿到 Promise 对象而不是值`
        )
      }
    }
  })

  test('await 之后的判空仍然是 null 语义', () => {
    const src = codeOnly(read('app/pages/manage/user.vue'))
    assert.match(src, /const newPassword = await askNewPassword\(/)
    assert.match(src, /if \(newPassword === null\) return/)
  })
})

describe('UI 与挂载', () => {
  test('app.vue 挂载一次 PromptDialog', () => {
    const tpl = templateOf('app/app.vue')
    const n = [...tpl.matchAll(/<PromptDialog/g)].length
    assert.equal(n, 1, `app.vue 里应恰好挂一个 PromptDialog，实际 ${n} 个`)
  })

  test('层级高于其它弹窗（提问要叠在编辑弹窗之上）', () => {
    // AccountEditDialog 的「重置密码」与 UserEditDialog 的「修改密码」都在
    // 弹窗开着时提问，且那两个弹窗不会关闭 —— 所以提问必须严格在上层。
    // 项目里五个弹窗都是 z-[60]，同层级靠 Teleport 插入顺序决定，是实现细节。
    const src = templateOf('app/components/PromptDialog.vue')
    const m = src.match(/z-\[(\d+)\]/)
    assert.ok(m, '没找到 z-index')
    assert.ok(
      Number(m[1]) > 60,
      `z-index 应大于 60（其它弹窗都是 60），实际 ${m[1]}`
    )
  })

  test('遮罩与取消按钮都走 cancelPrompt（取消语义统一）', () => {
    const src = templateOf('app/components/PromptDialog.vue')
    const cancels = [...src.matchAll(/cancelPrompt\(\)/g)].length
    // 遮罩点击 + 右上角关闭 + 底部取消 + Esc
    assert.ok(cancels >= 4, `取消出口应至少 4 个（遮罩/关闭/取消按钮/Esc），实际 ${cancels}`)
    assert.match(src, /@keydown\.esc="cancelPrompt\(\)"/, 'Esc 必须能取消')
    assert.match(src, /@submit\.prevent="submitPrompt\(\)"/, '表单回车要能提交')
  })

  test('错误信息有 role=alert（读屏要能立刻读到）', () => {
    const src = templateOf('app/components/PromptDialog.vue')
    assert.match(src, /role="alert"/)
  })

  test('输入框有 id + label 绑定（可点标签聚焦）', () => {
    const tpl = templateOf('app/components/PromptDialog.vue')
    const id = tpl.match(/const inputId = '([^']+)'/)?.[1] ?? scriptOf('app/components/PromptDialog.vue').match(/const inputId = '([^']+)'/)?.[1]
    assert.ok(id, '没找到 inputId')
    assert.match(tpl, /:for="inputId"/, 'label 的 for 要指向输入框')
    assert.match(tpl, /:id="inputId"/, '输入框要有那个 id')
  })

  test('打开时聚焦并全选（改名场景的刚需）', () => {
    const src = scriptOf('app/components/PromptDialog.vue')
    const at = src.indexOf('watch(request')
    const body = src.slice(at, src.indexOf('\n})', at) + 4)
    assert.match(body, /nextTick\(\)/, '必须等 Teleport 的内容进 DOM 再聚焦')
    assert.match(body, /\.focus\(\)/)
    assert.match(body, /\.select\(\)/, '全选 —— window.prompt 就是这个行为，改名时几乎总是整段替换')
  })
})