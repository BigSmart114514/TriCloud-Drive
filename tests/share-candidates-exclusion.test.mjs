// 分享候选人搜索：谁能出现在结果里。
//
// ## 这个 bug 的形状
//
// 「谁能进授权名单」这条规则在仓库里有**两份拷贝**：
//
//   写时  assertGrantees（server/utils/share.ts）—— 属主本人会被 400 掉
//   读时  candidates.get.ts 的 excluded 集合 —— 决定搜出来能不能看到
//
// 两份不一致，于是有些操作**根本做不了**：管理员在替别人管分享时，没法把自己
// 加进名单（搜不到自己）。而 assertGrantees 那一侧其实**允许**这件事 ——
// 它只拒属主，不拒行动者。
//
// OWNER_GUARD_TRIGGER 也只拦 `file_access.user_id = files.user_id`，所以管理员
// 给自己开一份别人文件的访问是被允许的、且有实际用途（那个人账号一删，
// 这份数据不至于跟着没）。
//
// 一份规则两处拷贝，正是本项目已经吃过亏的形状（cos.ts 的文件头记着五份
// 手抄的删除路径，其中一份改了守卫而其余四份静默失配）。所以规则收在
// share.ts 里、写时与读时共用。
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

register(new URL('./helpers/resolve-nuxt-alias.mjs', import.meta.url), import.meta.url)

const { candidateExclusions, assertGrantees } =
  await import('../server/utils/share.ts')
const { adminScope, withScope } = await import('../app/utils/scope.ts')

/** 假 db：只够 assertGrantees 查「用户是否存在」 */
function fakeDb(ids) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() {
              if (/FROM users/.test(sql)) {
                return { results: ids.map((id) => ({ id })) }
              }
              return { results: [] }
            }
          }
        }
      }
    }
  }
}

describe('普通用户：搜不到自己', () => {
  // 这是对的 —— 你自己的文件你本来就有全权，把自己列进名单没有意义。
  test('排除 meId', () => {
    const ex = candidateExclusions({ meId: 7, targetUserId: 7, adminMode: false, exclude: '' })
    assert.ok(ex.includes(7), '自己的文件不能授权给自己')
  })

  test('排除别人是可以的', () => {
    const ex = candidateExclusions({ meId: 7, targetUserId: 7, adminMode: false, exclude: '' })
    assert.ok(!ex.includes(9), '别人必须能搜到，否则没法分享')
  })
})

describe('管理员替别人管分享：这就是那个 bug', () => {
  // adminMode=true 且 targetUserId ≠ meId。
  const admin = { meId: 1, targetUserId: 43, adminMode: true, exclude: '' }

  test('★ 自己必须能被搜到（管理员给自己开一份访问是合法且有用的）', () => {
    const ex = candidateExclusions(admin)
    assert.ok(!ex.includes(1),
      '管理员必须能搜到自己 —— 搜不到就等于这个操作做不了。' +
      '写时 assertGrantees 只拒属主，不拒行动者')
  })

  test('属主仍然被排除（否则保存时才撞 400）', () => {
    const ex = candidateExclusions(admin)
    assert.ok(ex.includes(43), '属主本人不能进名单 —— assertGrantees 会 400')
  })

  test('管理员替自己管时排除自己（target === me 就是自己的文件）', () => {
    const ex = candidateExclusions({ meId: 1, targetUserId: 1, adminMode: true, exclude: '' })
    assert.ok(ex.includes(1), '这时 target 就是属主，属主本人不能进名单')
  })
})

describe('exclude 参数仍然生效', () => {
  test('名单里的人被排除', () => {
    const ex = candidateExclusions({ meId: 1, targetUserId: 43, adminMode: true, exclude: '5,9' })
    assert.ok(ex.includes(5) && ex.includes(9))
  })

  test('非法值被忽略而不是变成 id', () => {
    const ex = candidateExclusions({ meId: 1, targetUserId: 43, adminMode: true, exclude: '0,-3,abc,' })
    // 0 / -3 / abc 都不该进集合（0 会让 NOT IN (0) 带上一个假排除项，
    // 虽然不致命但说明解析不严）
    assert.ok(!ex.includes(0), '0 不是合法 id')
    assert.ok(!ex.includes(-3))
    assert.ok(!ex.includes(NaN))
  })

  test('空串与 undefined 都能处理', () => {
    for (const v of ['', undefined, null]) {
      const ex = candidateExclusions({ meId: 1, targetUserId: 43, adminMode: true, exclude: v })
      assert.ok(Array.isArray(ex))
    }
  })

  test('重复的 id 只出现一次（NOT IN 里重复无害，但会让 SQL 变长）', () => {
    const ex = candidateExclusions({ meId: 1, targetUserId: 43, adminMode: true, exclude: '43,43,43' })
    assert.equal(ex.filter((x) => x === 43).length, 1)
  })
})

describe('端点必须用共享的那份规则', () => {
  // 行为测试只覆盖 candidateExclusions 本身。如果有人把逻辑重新内联回
  // candidates.get.ts、或者干脆不再调用它，上面那 18 条照样全绿 ——
  // 而 bug 原样回来。所以这里钉住「接线」。
  const SRC = 'server/api/share/candidates.get.ts'
  let code
  before(() => {
    code = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', SRC), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
      .join('\n')
  })

  test('调的是 share.ts 的 candidateExclusions', () => {
    assert.match(code, /import \{ candidateExclusions \} from '~~\/server\/utils\/share'/,
      '必须从共享模块取规则')
    assert.match(code, /candidateExclusions\(\{/, '必须真的调用')
  })

  // 只断言「调了这个函数」不够 —— 变异扫描立刻传了个 `adminMode: false` 出去，
  // 上面 18 条行为测试照样全绿（它们直接调函数，不经过端点），bug 原样回来。
  // 所以三个实参必须逐一钉住。
  test('三个实参都传对了（adminMode / meId / targetUserId）', () => {
    const at = code.indexOf('candidateExclusions({')
    assert.ok(at > 0, '找不到调用')
    const call = code.slice(at, code.indexOf('})', at) + 2)

    // adminMode 必须是那个变量本身，不能是常量或反过来
    assert.match(call, /\badminMode\b/,
      '★ 必须传 adminMode 变量 —— 传常量 false 会退化成「永远排 meId」，也就是原始 bug')
    assert.doesNotMatch(call, /adminMode:\s*(false|true|!)/,
      'adminMode 不能被写死 —— 那等于把视角判断短路了')
    assert.match(call, /meId/, '必须传 meId')
    // 只断言「出现了 meId」不够：`meId: Number(targetUserId)` 同样满足，
    // 而那等于把自己排掉 —— 在管理视角下正是本 bug。
    // 所以要求它是**简写**（后面是逗号或换行，不���冒号）。
    assert.match(call, /\bmeId\s*(,|\n)/,
      '★ meId 必须是简写传值 —— 写成 meId: <别的>（哪怕值相等）就绕过了这条断言')
    assert.match(call, /targetUserId:\s*Number\(targetUserId\)/,
      '★ 必须传属主 —— 传成 meId 就等于「自己排自己」，在管理视角下正是本 bug')
  })

  // 「exclude 参数在函数里被正确处理」已经由行为测试覆盖；这里只确认它接上了，
  // 否则端点会静默地不排除已在名单里的人。
  test('exclude 参数接上了', () => {
    const at = code.indexOf('candidateExclusions({')
    const call = code.slice(at, code.indexOf('})', at) + 2)
    assert.match(call, /exclude:\s*q\?\.exclude/, '必须把查询串里的 exclude 传进去')
  })

  // 原来那份内联逻辑的形状。留着这两条是因为它们就是 bug 的原文 ——
  // 逐字钉住，比写「不要自己算排除集合」有用（后者可以有一百种等价写法）。
  test('不再有自己算排除集合的内联版本', () => {
    assert.doesNotMatch(code, /new Set<number>\(\[meId\]\)/,
      '内联那份把「我」和「属主」两个都排掉 —— 正是这个 bug')
    assert.doesNotMatch(code, /excluded\.add/, '排除集合现在只有一处定义')
  })

  // 前端早就只排属主了（ShareDialog.vue 的 exclude 里塞的是 targetUserId），
  // 所以两侧曾经不一致。
  //
  // 判据用「push 了几次」而不是「有没有出现某个标识符」：第一版写成
  // doesNotMatch(/exclude\.push\([^)]*me\b/)，而变异加进去的是字面量
  // exclude.push(1) —— 语法合法、效果一样（把自己排掉），却完全躲过了那条断言。
  // 数 push 的次数能抓住任何形式的追加。
  test('前端只往 exclude 里加属主，不加别的', () => {
    const dialog = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'app/components/ShareDialog.vue'),
      'utf8'
    )
    const at = dialog.indexOf('async function runCandidateSearch')
    assert.ok(at > 0, '找不到 runCandidateSearch')
    const body = dialog.slice(at, dialog.indexOf('await ShareService.candidates', at))

    const pushes = [...body.matchAll(/exclude\.push\(/g)].length
    assert.equal(pushes, 1,
      `exclude 只应被 push 一次（属主），实际 ${pushes} 次 —— 多出来的那次会让` +
        '前端与服务端对「谁能被搜到」产生分叉')
    assert.match(body, /exclude\.push\(props\.targetUserId\)/, '那一次必须是属主')
  })

  // 同样：断言「出现了 exclude.push(...)」挡不住把条件改成 if (false) ——
  // 文本还在，但管理视角下不再排属主，属主会被选中然后保存时 400。
  test('排属主的那个 if 条件是真的（不是 if (false)）', () => {
    const dialog = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'app/components/ShareDialog.vue'),
      'utf8'
    )
    const at = dialog.indexOf('async function runCandidateSearch')
    const body = dialog.slice(at, dialog.indexOf('await ShareService.candidates', at))
    assert.match(
      body,
      /if \(props\.useAdmin && props\.targetUserId != null\) exclude\.push\(props\.targetUserId\)/,
      '必须真的在管理视角下排属主 —— 条件被改成 if (false) 时属主能选中，保存时才 400'
    )
  })
})

describe('adminScope：两个参数必须一起发（行为级，不是源码形状）', () => {
  // 这里**不用源码正则**。第一版写了三条形状断言（合取、一个 if、两个赋值），
  // 变异扫描立刻找到三条绕过路径：只删掉 out.targetUserId、只删掉 out.useAdmin、
  // 把合取拆成两个 if。三条都语法合法、效果都是「静默退化成原 bug」，而形状
  // 断言一条都抓不住。
  //
  // 所以直接 import 真函数测返回值。那三条变异在行为层无处藏。
  // （import 放在文件顶部 —— describe 回调不是 async，里面不能 await。）
  test('管理视角：两个都发', () => {
    assert.deepEqual(
      adminScope({ useAdmin: true, targetUserId: 43 }),
      { useAdmin: true, targetUserId: 43 }
    )
  })

  // ★ 这条是「看起来修了其实没修」的判据。服务端只认 useAdmin：
  //   只发 useAdmin → targetUserId 缺省成 me，adminMode 为真而 target===me
  //                → 排除集仍是 { me } → 管理员依然搜不到自己
  test('只发 useAdmin 而没有 targetUserId → 两个都不发（不能发半个）', () => {
    assert.deepEqual(
      adminScope({ useAdmin: true, targetUserId: null }),
      {},
      '★ 半个视角会静默退化成原来的 bug —— 必须一个都不发'
    )
    assert.deepEqual(adminScope({ useAdmin: true, targetUserId: undefined }), {})
    assert.deepEqual(adminScope({ useAdmin: true }), {})
  })

  test('只有 targetUserId 没有 useAdmin → 不发（服务端会当成非管理视角）', () => {
    assert.deepEqual(adminScope({ targetUserId: 43 }), {},
      '只发 targetUserId 时服务端 useAdmin 为假 → adminMode 假 → 排除集 { me }')
  })

  test('非管理视角：一律不发', () => {
    assert.deepEqual(adminScope({ useAdmin: false, targetUserId: 43 }), {})
    assert.deepEqual(adminScope({}), {})
  })

  // targetUserId = 0 不是合法 id（「根」用 null 或 'root'），所以真值判断是对的。
  // 与 withScope 保持同一口径。
  test('targetUserId = 0 视为没有（与 withScope 同口径）', () => {
    assert.deepEqual(adminScope({ useAdmin: true, targetUserId: 0 }), {})
  })

  test('判据与 withScope 不同是刻意的：那边允许独立判，这边不允许', () => {
    // withScope 两个条件独立判（files/folders 那些接口需要那个灵活性）；
    // adminScope 必须合取。这条把差别钉住，免得有人「统一风格」把两边改成一样。
    const p = {}
    withScope(p, { useAdmin: true, targetUserId: null })
    assert.equal(p.useAdmin, 1, 'withScope 允许只发 useAdmin')
    assert.equal(p.targetUserId, undefined)

    assert.deepEqual(adminScope({ useAdmin: true, targetUserId: null }), {},
      'adminScope 不允许 —— 半个视角对搜索接口没有意义')
  })
})

describe('客户端必须把视角发过去（这条才是真正的 bug）', () => {
  // 服务端那一半（candidateExclusions 的 adminMode 分支）是对的，但从来没被走到 ——
  // 因为客户端压根没告诉服务端现在是管理视角。而 manage/files 里别的操作全都正常，
  // 所以表现很随机：开关能改、能加别人、能删链接，就是搜不到人。
  const SVC = 'app/services/share.service.ts'
  const DIALOG = 'app/components/ShareDialog.vue'
  let svc, dialog
  before(() => {
    const base = join(dirname(fileURLToPath(import.meta.url)), '..')
    const strip = (s) =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
        .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l)).join('\n')
    svc = strip(readFileSync(join(base, SVC), 'utf8'))
    dialog = readFileSync(join(base, DIALOG), 'utf8')
  })

  test('candidates 吃 target 参数（原来签名里根本没有它）', () => {
    assert.match(svc, /async candidates\(\s*keyword: string,\s*opts: \{ excludeIds\?: number\[\]; target\?: ShareTargetType \}/,
      '签名里必须有 target —— 没有它就没有 scopeOnly 可用')
  })

  test('candidates 把 adminScope 的结果放进 params', () => {
    const at = svc.indexOf('async candidates(')
    assert.ok(at > 0)
    const body = svc.slice(at, svc.indexOf('\n  },', at))
    assert.match(body, /adminScope\(opts\.target\)/,
      '★ 必须把视角发出去 —— 这正是本次修的那个 bug')
    assert.match(body, /opts\.target \? adminScope/, 'target 缺失时不能发空的视角参数')
  })

  // scopeParams 会带上 targetType/targetId。搜索接口不看这两个，发过去是噪音，
  // 而且将来有人拿它当筛选条件就麻烦了。
  test('candidates 不发 targetType / targetId', () => {
    const at = svc.indexOf('async candidates(')
    const body = svc.slice(at, svc.indexOf('\n  },', at))
    assert.doesNotMatch(body, /scopeParams\(/,
      '搜索接口不该用 scopeParams —— 那会带上与搜索无关的 targetType/targetId')
    assert.doesNotMatch(body, /targetType|targetId/, 'params 里不该出现目标本身')
  })

  test('scopeParams 展开 adminScope，而不是再抄一遍 if', () => {
    const at = svc.indexOf('function scopeParams(')
    const body = svc.slice(at, svc.indexOf('\n}', at) + 2)
    assert.match(body, /\.\.\.adminScope\(target\)/, '必须展开，否则又是一份拷贝')
    assert.doesNotMatch(body, /if \(target\.useAdmin/, '条件不该在这里再写一遍')
  })

  test('ShareDialog 把 scope.value 传给 candidates', () => {
    const at = dialog.indexOf('async function runCandidateSearch')
    assert.ok(at > 0)
    const body = dialog.slice(at, dialog.indexOf('await ShareService.candidates', at) + 200)
    assert.match(
      body,
      /ShareService\.candidates\(q, \{ excludeIds: exclude, target: scope\.value \}\)/,
      '★ 不传 scope.value 就是本次的 bug —— 服务端拿不到 adminMode'
    )
  })
})

describe('泛化：ShareDialog 里每个 ShareService 调用都必须带 scope', () => {
  // 这一条是本次真正的价值所在。它抓的不是「candidates 忘了」，而是
  // 「ShareDialog 里任何一个 ShareService 调用没带 scope」——
  // 而 ShareDialog 是**唯一**持有 props.useAdmin 的组件，所以它是正确的边界。
  // 下次有人加一个新方法忘了传，这条会红，而不是等用户在管理页里撞上。
  const DIALOG = 'app/components/ShareDialog.vue'
  let dialog
  before(() => {
    dialog = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', DIALOG), 'utf8')
  })

  test('每个调用都带上了 scope（没有白名单：这里 6 个调用全都该带）', () => {
    // 抓出每个 ShareService.xxx( 的实参列表（括号配平，不用正则硬切）
    const calls = []
    const re = /ShareService\.(\w+)\(/g
    let m
    while ((m = re.exec(dialog))) {
      let depth = 0
      let i = m.index + m[0].length - 1
      for (; i < dialog.length; i++) {
        if (dialog[i] === '(') depth++
        else if (dialog[i] === ')') { depth--; if (depth === 0) break }
      }
      calls.push({ name: m[1], args: dialog.slice(m.index + m[0].length, i) })
    }

    assert.ok(calls.length >= 6, `期望至少 6 个 ShareService 调用，实际扫到 ${calls.length} 个`)

    // 判据是「这次调用带上了视角」，与**怎么表达**无关。本文件里同一个概念
    // 有三种写法：
    //   scope.value                       （list / setState / addLink / removeLink / candidates）
    //   { useAdmin, targetUserId } 内联字面量（bulkApply）
    //   什么都不给                          ← 就是 candidates 原来的样子
    //
    // 第一版只认 `\bscope\b`，于是 bulkApply 被误判成「没带 scope」——
    // 而它带了。断言若把表达方式当规范，就会在无害的重构上报红，
    // 于是人开始加白名单，白名单又变成什么都往里塞的垃圾桶。
    const carriesScope = (args) =>
      /\bscope\b/.test(args) || (/\buseAdmin\b/.test(args) && /\btargetUserId\b/.test(args))

    const unscoped = calls
      .filter((c) => !carriesScope(c.args))
      .map((c) => `${c.name}(${c.args.replace(/\s+/g, ' ').slice(0, 70)})`)
    assert.deepEqual(unscoped, [],
      `这些调用没有带上管理视角，会退化成「按自己身份操作」：\n  ${unscoped.join('\n  ')}`)
  })

  test('扫到的不止 candidates（防止解析器扫了 0 个而全绿）', () => {
    const names = [...dialog.matchAll(/ShareService\.(\w+)\(/g)].map((m) => m[1])
    for (const expected of ['list', 'setState', 'addLink', 'removeLink', 'candidates', 'bulkApply']) {
      assert.ok(names.includes(expected), `没扫到 ShareService.${expected} —— 解析器可能坏了`)
    }
  })
})

describe('读时与写时必须一致（这才是这个 bug 的根）', () => {
  // 最强的一条：搜索给出来的每一个人，保存时都必须被 assertGrantees 接受。
  // 两条规则一旦分叉，这条立刻红 —— 而它不需要知道分叉在哪。
  const db = fakeDb([1, 2, 5, 9, 43, 77])

  const cases = [
    { label: '普通用户分享自己的文件', meId: 2, targetUserId: 2, adminMode: false },
    { label: '管理员替别人管分享', meId: 1, targetUserId: 43, adminMode: true },
    { label: '管理员替自己管', meId: 1, targetUserId: 1, adminMode: true },
    { label: '子账户分享自己的文件', meId: 77, targetUserId: 77, adminMode: false }
  ]

  for (const c of cases) {
    test(`${c.label}：搜得到的每一个都能存得进去`, async () => {
      const ex = candidateExclusions({ ...c, exclude: '' })
      for (const id of [1, 2, 5, 9, 43, 77]) {
        if (ex.includes(id)) continue
        await assert.doesNotReject(
          () => assertGrantees(db, [id], c.targetUserId),
          `id=${id} 搜索里出现了，但 assertGrantees 会拒它 —— 两套规则分叉了`
        )
      }
    })
  }

  // 反向：属主一定会被隐藏，因为他一定会被 assertGrantees 拒。
  for (const c of cases) {
    test(`${c.label}：属主不会被搜到（他一定会被 400）`, () => {
      const ex = candidateExclusions({ ...c, exclude: '' })
      assert.ok(ex.includes(c.targetUserId),
        `属主 ${c.targetUserId} 必须在排除集合里 —— 否则用户能选到他，保存时才报 400`)
    })
  }

  // 具体到那个 bug：管理员替别人管时，自己既搜得到也存得进去。
  test('管理员替别人管时：自己搜得到，且 assertGrantees 接受', async () => {
    const ex = candidateExclusions({ meId: 1, targetUserId: 43, adminMode: true, exclude: '' })
    assert.ok(!ex.includes(1), '★ 本条是这次修的那个 bug')
    await assert.doesNotReject(() => assertGrantees(db, [1], 43))
  })
})