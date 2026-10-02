// 「数据库连接失败」这个错误的收口（源码断言）。
//
// ## 背景
//
// `types/error.ts` 里早就有 `dbConnectionError = createError({ statusCode: 500,
// message: '数据库连接失败' })`，绝大多数 handler 都用它。但有 10 处是**手写
// 的等价物** —— 字面量一样、语义一样，却各写各的：
//
//     if (!db) throw createError({ statusCode: 500, message: '数据库连接失败' })
//
// 散在 accounts（5 处）、manage/updateUser、upload/credentials，以及 auth 下三处
// 多行展开的写法。收口之后 31 个文件统一用 dbConnectionError。
//
// ## 为什么这值得测
//
// 它是纯机械替换，风险低；但风险低不等于没风险 —— 一旦哪个文件改成了别的
// 状态码（比如手滑写成 503），前端拿到的行为就变了，而这种改动没有任何编译
// 错误。所以钉住「每个 handler 的 db-null 分支抛的就是 dbConnectionError」。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

/** 去掉注释，避免注释里抄的写法把断言骗成恒真 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
    .join('\n')
}

/**
 * 取出 `if (!db)` 分支里抛的那个错误标识符。
 *
 * ## 这里踩过一个坑
 *
 * 最初的写法是 `/if \(!db\)\s*(?:\{[^}]*\})?\s*throw\s+(\w+)/` —— 想着
 * 「可选的花括号块，然后 throw」。结果多行写法全判失败，明明代码是对的。
 *
 * 原因是 `[^}]*` 会连 `throw dbConnectionError` 一起吃掉：这个分支是
 *
 *     if (!db) {
 *       throw dbConnectionError
 *     }
 *
 * 括号块把 throw 整个包进去了，等 `\{[^}]*\}` 匹配完，下一个 token 已经是
 * `}`，那个可选组又是非贪婪的、可以不吃，于是 `\s*throw` 无从匹配 —— 断言
 * 报的是「不是直接 throw」，读起来像源码有问题，其实是断言自己写错了。
 *
 * 改成「先吃掉花括号里的所有内容，再从**整段块**里找最后一个 throw」，
 * 两种形态（单行 / 多行）都能取到同一个标识符。
 */
function dbNullThrow(src) {
  const idx = src.search(/if \(!db\)/)
  if (idx < 0) return null
  const after = idx + 'if (!db)'.length
  // 先看紧跟其后是不是花括号块。注意必须判断「下一个非空白字符是不是 {」，
  // 不能直接 indexOf('{') —— 后面几十行里的模板字面量、对象字面量都带花括号，
  // 会把单行写法误判成多行块，然后从错的地方开始截断（第一版就栽在这）。
  const rest = src.slice(after)
  const braceBlock = /^\s*\{/.test(rest)
  let body
  if (braceBlock) {
    const end = src.indexOf('}', after)
    if (end < 0) return null
    body = src.slice(after, end)
  } else {
    // 单行写法 `if (!db) throw x` 后面**不一定有分号**（这项目多数没写），
    // 所以边界取「行尾」与「分号」中较早的那个；都没有就用换行。
    const semi = src.indexOf(';', after)
    const nl = src.indexOf('\n', after)
    const end = semi >= 0 && (nl < 0 || semi < nl) ? semi : nl
    if (end < 0) return null
    body = src.slice(after, end)
  }
  const throws = [...body.matchAll(/throw\s+([A-Za-z_$][\w$]*)/g)]
  return throws.length ? throws[throws.length - 1][1] : null
}

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (p.endsWith('.ts')) yield p
  }
}

const API_FILES = [...walk(join(root, 'server/api'))].map((p) => relative(root, p))
const UTIL_FILES = [...walk(join(root, 'server/utils'))].map((p) => relative(root, p))

describe('数据库连接失败：不再有手写的等价物', () => {
  test('全服务端没有任何一处内联写这个错误', () => {
    // 这是本次收口的直接目标。命中即失败，并报出文件与行号。
    const offenders = []
    for (const f of [...API_FILES, ...UTIL_FILES]) {
      const src = read(f)
      src.split('\n').forEach((line, i) => {
        if (/createError\(\s*\{[^}]*数据库连接失败/.test(line)) {
          offenders.push(`${f}:${i + 1}: ${line.trim()}`)
        }
        // 多行展开的形态单独抓一次
        if (/^\s*message:\s*['"]数据库连接失败['"]/.test(line)) {
          offenders.push(`${f}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    assert.deepEqual(offenders, [], '还有内联写法：\n' + offenders.join('\n'))
  })

  test('dbConnectionError 的定义没被改坏', () => {
    const src = read('types/error.ts')
    assert.match(
      src,
      /export const dbConnectionError = createError\(\{\s*statusCode:\s*500,\s*message:\s*'数据库连接失败'\s*\}\)/,
      'dbConnectionError 的定义变了（状态码或文案被改动）'
    )
  })
})

describe('每个 handler 的 db-null 分支', () => {
  // 这些是收口时**逐个改过**的文件。列出来是为了让「漏改一处」立刻可见。
  const converted = [
    'server/api/accounts/index.get.ts',
    'server/api/accounts/index.post.ts',
    'server/api/accounts/quota.post.ts',
    'server/api/accounts/delete.post.ts',
    'server/api/accounts/reset-password.post.ts',
    'server/api/manage/updateUser.post.ts',
    'server/api/upload/credentials.post.ts',
    'server/api/auth/me.get.ts',
    'server/api/auth/login.post.ts',
    'server/api/auth/change-password.post.ts',
    'server/utils/auth-middleware.ts',
  ]

  for (const file of converted) {
    test(`${file} 抛的是 dbConnectionError`, () => {
      const src = codeOnly(read(file))
      assert.match(src, /if \(!db\)/, `${file} 里找不到 db 的空值分支`)
      const thrown = dbNullThrow(src)
      assert.ok(thrown, `${file} 的 if (!db) 分支不是直接 throw`)
      assert.equal(
        thrown,
        'dbConnectionError',
        `${file} 的 db-null 分支抛的是 ${thrown}，不是 dbConnectionError`
      )
      assert.match(
        src,
        /import \{[^}]*\bdbConnectionError\b[^}]*\} from ['"]~~\/types\/error['"]/,
        `${file} 没从 types/error import dbConnectionError`
      )
    })
  }

  test('全服务端：db-null 分支抛的一律是 dbConnectionError', () => {
    // 不只查改过的那些 —— 任何 handler 都不该在这条分支上抛别的东西。
    // （若将来确有个别 handler 需要不同的错误，那时在这里显式豁免并写明理由。）
    const bad = []
    for (const f of [...API_FILES, ...UTIL_FILES]) {
      const thrown = dbNullThrow(codeOnly(read(f)))
      if (thrown && thrown !== 'dbConnectionError') bad.push(`${f}: 抛的是 ${thrown}`)
    }
    assert.deepEqual(bad, [], 'db-null 分支抛错了东西：\n' + bad.join('\n'))
  })
})
