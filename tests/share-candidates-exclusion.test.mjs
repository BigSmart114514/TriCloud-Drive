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