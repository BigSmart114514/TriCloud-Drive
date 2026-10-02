// escapeLike 的行为 + 「哪些 LIKE 查询真的做了转义」（源码断言）。
//
// ## 为什么要单独测这个
//
// `escapeLike` 是个纯字符串函数，但它配错的后果是**静默的搜索结果错误**：
// `%` 和 `_` 是 LIKE 通配符，不转义的话搜 "50%" 会命中 "50abc"，搜 "_" 会
// 命中所有单字符名字。SQL 参数化挡住了注入，但**挡不住通配符语义** —— 两者是
// 独立的两件事，只做参数化不做转义，搜索依然是错的。
//
// 而这份转义在本项目里被漏掉过：users 表的三个搜索接口（accounts 列表、
// share 候选人、manage 用户列表）都拼 `%${q}%`，都没转义、也没声明 ESCAPE；
// 同项目另外三处（search.ts / file.ts / folders.ts）却是对的。所以光测函数不够，
// 还要测**调用点有没有接上** —— 后者只能靠源码断言。
//
// 数据绝不碰开发库：本文件全是纯函数 + 源码断言，不开 sqlite。
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { register } from 'node:module'

import { openRawDb } from './helpers/sqlite-fixture.mjs'

register(new URL('./helpers/resolve-nuxt-alias.mjs', import.meta.url), import.meta.url)

const { escapeLike, escapeRegExp } = await import('../server/utils/escape.ts')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

/** 去掉注释，避免注释里抄的写法把断言骗成恒真 */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/**
 * 找出「LIKE 的模式是裸拼出来的」那种写法：`` `%${x}%` ``。
 *
 * ## 不能靠正则判断
 *
 * 关键点：转义后的写法 `` `%${escapeLike(q)}%` `` **字面上也含有 `%${`**。
 * 所以「有没有 `%${`」这个信号对两种写法都成立，区分不开 —— 第一次写这个
 * helper 时就是这么错的：断言刚加上就红了，红的原因正是它把
 * `%${escapeLike(...)}%` 也报成裸拼接。
 *
 * 而且裸正则 `` /%\$\{/ `` 还会连**毫不相干的普通代码**一起命中（错误信息里
 * 冒出过 `catch (error: any)` 这种行），因为 `$` 后跟 `{` 在正则里是字面量，
 * 没有语法边界可言。
 *
 * ## 可靠办法
 *
 * 手工配对大括号，把每个 `%` 后面紧跟的那个插值**完整取出来**，再看它的内容
 * 是不是以 `escapeLike(` 开头。靠内容判断而不是靠字符形状。
 */
function bareLikeConcats(code) {
  const out = []
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '%' || code[i + 1] !== '$' || code[i + 2] !== '{') continue
    // 从 `{` 开始配对大括号（插值内部不会有字符串字面量，本项目够用）
    let depth = 0
    let j = i + 2
    for (; j < code.length; j++) {
      if (code[j] === '{') depth++
      else if (code[j] === '}') {
        depth--
        if (depth === 0) break
      }
    }
    if (depth !== 0) continue
    const expr = code.slice(i + 3, j).trim()
    if (!expr.startsWith('escapeLike(')) out.push('%${' + expr + '}%')
    i = j
  }
  return out
}

describe('escapeLike 行为', () => {
  test('转义 % 通配符', () => {
    assert.equal(escapeLike('50%'), '50\\%')
    assert.equal(escapeLike('%'), '\\%')
    assert.equal(escapeLike('a%b%c'), 'a\\%b\\%c')
  })

  test('转义 _ 通配符', () => {
    assert.equal(escapeLike('a_b'), 'a\\_b')
    assert.equal(escapeLike('_'), '\\_')
  })

  test('转义反斜杠自身', () => {
    assert.equal(escapeLike('a\\b'), 'a\\\\b')
    assert.equal(escapeLike('\\'), '\\\\')
  })

  test('普通字符原样返回', () => {
    assert.equal(escapeLike('hello'), 'hello')
    assert.equal(escapeLike('张三'), '张三')
    assert.equal(escapeLike(''), '')
    assert.equal(escapeLike('a-b_c%d'), 'a-b\\_c\\%d')
  })

  test('三类字符都被覆盖（防止将来正则被改漏一类）', () => {
    const out = escapeLike('%_\\')
    // 每个字符前面都多了一个反斜杠
    assert.equal(out.length, 6)
    assert.match(out, /^\\[%_\\]{1}\\[%_\\]{1}\\[%_\\]$/)
  })

  test('转义后拼进 %...% 得到的模式，不再有裸通配符', () => {
    // 用户搜 "a_b" 时，若不转义则模式里的 _ 会匹配任意单字符
    assert.equal(`%${escapeLike('a_b')}%`, '%a\\_b%')
    assert.equal(`%${escapeLike('50%')}%`, '%50\\%%')
  })
})

describe('escapeRegExp 行为', () => {
  test('转义正则元字符', () => {
    assert.equal(escapeRegExp('a.b'), 'a\\.b')
    assert.equal(escapeRegExp('a*b'), 'a\\*b')
    assert.equal(escapeRegExp('a+b?'), 'a\\+b\\?')
    assert.equal(escapeRegExp('(x)'), '\\(x\\)')
    assert.equal(escapeRegExp('[y]'), '\\[y\\]')
    assert.equal(escapeRegExp('a^b$c'), 'a\\^b\\$c')
    assert.equal(escapeRegExp('a|b{2}'), 'a\\|b\\{2\\}')
    assert.equal(escapeRegExp('a\\b'), 'a\\\\b')
  })

  test('转义后作为正则只匹配字面量', () => {
    // 不转义的话 "a.b" 会匹配 "axb"
    const re = new RegExp(`^${escapeRegExp('a.b')}$`)
    assert.ok(re.test('a.b'))
    assert.ok(!re.test('axb'))
  })

  test('不转义正则分隔符造成的真实后果：文件名里的括号被当成分组', () => {
    // 这是 resolveUniqueFilename 的重名消解用的正则
    const re = new RegExp(`^${escapeRegExp('a(1)')} \\((\\d+)\\)$`)
    assert.ok(re.test('a(1) (2)'))
    assert.ok(!re.test('ax1x (2)'))
  })
})

// 前面那些是「函数输出对不对」，这里是「拿到真 sqlite 上跑，语义对不对」。
//
// ## 为什么要真库
//
// escapeLike 是纯字符串函数，它的正确性完全体现在「拼出来的模式被 sqlite
// 怎么解释」上。只测字符串输出的话，把 ESCAPE 声明漏掉这种错误一个都测不出来 ——
// 因为漏了 ESCAPE，escapeLike 的输出一个字都没变。
//
// ## 这组用例是实测出来的，不是推理出来的
//
// 用例是照着真 sqlite 的实际行为挑的。一开始用 "50%" 举例，跑完发现**看不出差别**
// —— 因为值本身以 % 结尾，`%50%%` 和 `%50%` 碰巧都只匹配到 "50%off"。
// 换成 "a%b" 这种通配符在中间、值里又有真字符的才暴露出多命中。
describe('真 sqlite 上的语义（内存库，不碰开发库）', () => {
  // 刻意包含「会被裸通配符误伤」的名字：a1b/axb 对上 a%b，preXpost 对上 pre_post
  const NAMES = ['a1b', 'axb', 'a%b', 'pre_post', 'preXpost', 'back\\slash', 'report']
  let db

  before(async () => {
    db = await openRawDb()
    await db.run('CREATE TABLE t (name TEXT)')
    for (const n of NAMES) await db.run('INSERT INTO t VALUES (?)', [n])
  })

  after(async () => {
    await db?.close()
  })

  const WITH_ESCAPE = "SELECT name FROM t WHERE name LIKE ? ESCAPE '\\'"
  const WITHOUT_ESCAPE = 'SELECT name FROM t WHERE name LIKE ?'

  const names = async (sql, pattern) => (await db.all(sql, [pattern])).map((r) => r.name).sort()

  test('% 在中间时，转义后只匹配字面量', async () => {
    assert.deepEqual(await names(WITH_ESCAPE, `%${escapeLike('a%b')}%`), ['a%b'])
  })

  test('_ 转义后只匹配字面量', async () => {
    assert.deepEqual(await names(WITH_ESCAPE, `%${escapeLike('pre_post')}%`), ['pre_post'])
  })

  test('反斜杠转义后可按字面搜到', async () => {
    assert.deepEqual(await names(WITH_ESCAPE, `%${escapeLike('back\\slash')}%`), ['back\\slash'])
  })

  test('无通配符的普通搜索不受影响', async () => {
    assert.deepEqual(await names(WITH_ESCAPE, `%${escapeLike('report')}%`), ['report'])
  })

  test('这三种查询在真库上确实有差别（证明前几条不是恒真）', async () => {
    // 每一种都存在「裸拼接会多命中」的名字，且转义后不多命中。
    // 如果哪天 sqlite 的 LIKE 语义变了，这几条会红 —— 那时该重新评估，
    // 而不是默默让它们通过。
    const cases = [
      ['a%b', ['a1b', 'axb']],
      ['pre_post', ['preXpost']],
    ]
    for (const [q, extra] of cases) {
      const escaped = await names(WITH_ESCAPE, `%${escapeLike(q)}%`)
      const bare = await names(WITHOUT_ESCAPE, `%${q}%`)
      for (const name of extra) {
        assert.ok(bare.includes(name), `${q} 裸拼接本该误伤 ${name}，却没有 —— 用例失效`)
        assert.ok(!escaped.includes(name), `${q} 转义后不该命中 ${name}`)
      }
    }
  })
})

describe('调用点：所有 LIKE 都配了 escape + ESCAPE', () => {
  // 这组接口曾经漏掉转义（拼 `%${q}%` 且无 ESCAPE），统一补上了。
  // 它们必须与 escapeLike 成对：只转义不声明 ESCAPE 的话反斜杠会被当普通字符。
  const userSearchSites = [
    ['server/api/accounts/index.get.ts', '子账户列表按用户名筛'],
    ['server/api/share/candidates.get.ts', '分享候选人搜索（username + email 两处）'],
    ['server/api/manage/listUsers.get.ts', '管理员用户列表按用户名筛'],
  ]

  for (const [file, what] of userSearchSites) {
    describe(what, () => {
      let code
      before(() => {
        code = codeOnly(read(file))
      })

      test('每一处 LIKE 都声明了 ESCAPE', () => {
        // 注意是**逐处**核对，不能只断言「文件里有 ESCAPE」出现过一次。
        // 变异扫描实测：candidates 的 email 分支去掉 ESCAPE、
        // listUsers 的 countSql 去掉 ESCAPE，这两种都能让
        // 「文件里有 ESCAPE」照样成立，所以只做存在性断言必然漏。
        // 做法是数出 LIKE 的总数与 ESCAPE 的总数，要求一一对应。
        const likeCount = (code.match(/LIKE \?/g) ?? []).length
        const escapeCount = (code.match(/LIKE \? ESCAPE/g) ?? []).length
        assert.ok(likeCount > 0, file + ' 里没找到 LIKE ?，源文件结构可能变了')
        assert.equal(
          escapeCount,
          likeCount,
          file + ': ' + likeCount + ' 处 LIKE 只有 ' + escapeCount + ' 处声明了 ESCAPE'
        )
      })

      test('模式经过 escapeLike', () => {
        assert.match(code, /escapeLike\(/, `${file} 的搜索没有过 escapeLike`)
      })

      test('import 了 escapeLike', () => {
        assert.match(code, /import \{[^}]*escapeLike[^}]*\} from/, `${file} 没 import escapeLike`)
      })

      test('没有裸的百分号加模板插值拼接（那是不转义的直接证据）', () => {
        const bare = bareLikeConcats(code)
        assert.deepEqual(bare, [], file + ' 里还有裸的百分号模板拼接: ' + bare.join(' | '))
      })
    })
  }

  test('原本就正确的几处仍然正确（防止整理时改坏）', () => {
    for (const file of [
      'server/utils/search.ts',
      // file.ts 的那两处 LIKE 搬到了 naming.ts（重名消解三份实现合并到一处），
      // folders.ts 的两处也一起搬了。断言跟着搬 —— 这条测试在合并提交里立刻
      // 就红了，报「file.ts 里没找到 LIKE ?」，正是它该做的事。
      'server/utils/naming.ts',
    ]) {
      const code = codeOnly(read(file))
      const likeCount = (code.match(/LIKE \?/g) ?? []).length
      const escapeCount = (code.match(/LIKE \? ESCAPE/g) ?? []).length
      assert.ok(likeCount > 0, file + ' 里没找到 LIKE ?')
      assert.equal(
        escapeCount,
        likeCount,
        file + ': ' + likeCount + ' 处 LIKE 只有 ' + escapeCount + ' 处声明了 ESCAPE'
      )
      assert.match(code, /escapeLike\(/, file + ' 的 escapeLike 没了')
    }
  })

  test('全项目没有裸的 `%${...}%` 拼进 LIKE', () => {
    // 扫所有服务端文件：任一处出现裸拼接即失败。
    // escapeLike(自身)、escapeRegExp(自身) 之外的地方都不该有。
    const files = [
      'server/utils/search.ts',
      'server/utils/naming.ts',
      'server/utils/escape.ts',
      'server/api/accounts/index.get.ts',
      'server/api/share/candidates.get.ts',
      'server/api/manage/listUsers.get.ts',
    ]
    for (const file of files) {
      const code = codeOnly(read(file))
      const bare = bareLikeConcats(code)
      assert.deepEqual(bare, [], file + ' 里有裸的百分号模板拼接: ' + bare.join(' | '))
    }
  })
})
