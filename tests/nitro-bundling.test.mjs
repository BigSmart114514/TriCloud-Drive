// Nitro 打包配置：哪些包允许被**内联进**产物。
//
// ## 一句话背景
//
// 2026-10-11 生产启动即崩：
//
//     TypeError: includes.bind is not a function
//         at .output/server/chunks/nitro/nitro.mjs:8668
//
// 崩溃点在 `jsonwebtoken/sign.js` 顶部那行 `includes.bind(null, SUPPORTED_ALGS)`。
//
// ## 机制
//
// `externals.inline` 让 nitro 把包**打进**产物。打包后该包自己的 CJS 依赖不会被
// 一起内联，而是留成裸 ESM 命名空间导入：
//
//     import * as lodash from 'lodash.includes'
//     const includes = getDefaultExportFromNamespaceIfNotNamed(lodash)
//
// 这个 helper（unenv 生成，全产物只出现一次）是这么写的：
//
//     function getDefaultExportFromNamespaceIfNotNamed (n) {
//       return n && hasOwnProperty(n,'default') && Object.keys(n).length === 1
//         ? n['default'] : n;
//     }
//
// **只在命名空间恰好有 1 个 key 时才解包 `.default`。** 而 Node 对 CJS 的 ESM 命名空间
// 在新版本上给的是 2 个 key —— 实测 v24.21.0：
//
//     Object.keys(await import('lodash.includes'))
//       // => [ 'default', 'module.exports' ]
//
// 于是 `length === 1` 不成立，helper 原样返回命名空间对象，`includes` 变成
// `{default: fn, 'module.exports': fn}`，`.bind` 是 undefined。
//
// 受影响的是 jsonwebtoken 全部 7 个 lodash.* 依赖加 `ms`。`jws` 有 9 个 key，
// helper 同样不��包，但 `createSign` 恰好是具名导出，所以侥幸能用 —— 这种「有的坏
// 有的不坏」正是它能潜伏在生产里这么久的原因。
//
// ## 为什么不是某次提交引入的
//
// 上一次跑得好好的生产构建（15478ec）**已经带着**同样的 inline 配置，
// `server/utils/auth.ts`、`package.json`、nitro 段配置在这 39 个提交里全部零变化。
// 变的只有服务器上的 Node 版本。把今天那个构建换成 15478ec 重新部署，会以完全
// 相同的方式崩溃 —— 这是运行时升级砸在构建期假设上的坑。
//
// 所以修法不是「再打一个补丁把那个 helper 改对」，而是**别让 interop 这一层出现**：
// 走 nitro 默认的 external，运行时原生 require，命名空间互操作根本不参与。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 剥掉注释。**逐字符扫描，不用正则**。
 *
 * ## 为什么不能用 `/\/\*[\s\S]*?\*\//g`
 *
 * 第一版就是这么写的，于是这个测试文件**红是红了，但理由是错的**：它报
 * 「读不到 externals.inline」，因为整个 externals 块被剥掉了。
 *
 * 原因是 nuxt.config.ts 第 27 行：
 *
 *     routeRules: {
 *       '/api/**': {
 *
 * 这个**路由字符串里含有块注释的开头符号**（一个斜杠加一个星号）。全文这样的
 * 开头有 5 个、闭合只有 4 个，于是正则从第 27 行一路配到第 61 行，把中间包括被测
 * 字段在内的代码全当成注释删了。
 *
 * 这比注释盲点更糟：注释盲点只是让断言看不见答案，这个是**把被测的代码本身
 * 删掉** —— 而且删得理直气壮，测试还报得有模有样。
 *
 * ## 第二件事：写这段注释时我自己踩了同一个坑
 *
 * 这个注释的第一版里有一句「全文 5 个开头对 4 个闭合」，我把闭合符号**字面写进了
 * 块注释**，于是它在第 70 行当场把这段注释闭合，后面全部变成代码，文件直接
 * SyntaxError。讲剥离器的注释被剥离器的同款陷阱咬 —— 同一个错误类型，只不过这次
 * 是匹配侧的。现在这里只写「闭合」两个字，不写符号本身。
 *
 * ## 另一个理由
 *
 * nuxt.config.ts 里解释「为什么删掉 inline」的那段注释本身就写着 jsonwebtoken。
 * 不剥的话它就是文件里第一个 jsonwebtoken，于是「不许内联」这条断言会对着一个
 * 已经删干净的配置照样绿。上一轮在 base.css 上原样栽过。
 *
 * ## 已知边界
 *
 * 不处理正则字面量。`/` 后面既不是 `/` 也不是 `*` 时按运算符跳过，于是正则体里
 * 的引号会被当成字符串开头。对本测试的两处用途（nuxt.config.ts 与「项目代码里
 * 有没有 import 某个包」）影响可忽略，但换个地方复用要先想一遍。
 */
function stripComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]
    // 行注释
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    // 块注释
    if (c === '/' && next === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    // 字符串 / 模板字面量：原样抄进去，里面的 // 和 /* 都不是注释
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      out += c
      i++
      while (i < n) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '')
          i += 2
          continue
        }
        out += src[i]
        if (src[i] === quote) {
          i++
          break
        }
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sourceFiles(p, out)
    else if (/\.(ts|vue|js|mjs)$/.test(name)) out.push(p)
  }
  return out
}

/** 项目自己写的代码（不含测试与构建产物） */
function projectCode() {
  const dirs = ['server', 'app', 'shared']
    .filter((d) => existsSync(join(root, d)))
    .flatMap((d) => sourceFiles(join(root, d)))
  return dirs.map((p) => stripComments(readFileSync(p, 'utf8'))).join('\n')
}

/** 取出 externals.inline 的数组内容，元素为字符串字面量或字符串正则 */
function inlineList(nuxt) {
  const block = /externals\s*:\s*\{([\s\S]*?)\n\s*\}/.exec(nuxt)
  if (!block) return null
  const arr = /inline\s*:\s*\[([\s\S]*?)\]/.exec(block[1])
  if (!arr) return null
  return arr[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

const NUXT = stripComments(readFileSync(join(root, 'nuxt.config.ts'), 'utf8'))

describe('inlineList 解析器本身', () => {
  // 这条不是凑数。写这个测试时它刚吞掉过一次事故：第一版 inlineList 用
  // /externals\s*:\s*\{([\s\S]*?)\n\s*\}/ 去匹配，而 nuxt.config.ts 里有
  // '/api/**' 这个路由串 —— 它让前面的 `/*` 被当成块注释开头，于是 externals
  // 块被整段当成注释剥掉，解析器返回 null。而「块不存在」和「解析失败」返回的是
  // 同一个 null，测试于是报「读不到 externals.inline」，看着像守卫在工作。
  test('能从 externals 里取出 inline 列表', () => {
    const fixture = "nitro: {\n    externals: {\n      inline: ['a', 'b']\n    },\n  }"
    assert.deepEqual(inlineList(fixture), ["'a'", "'b'"])
  })

  test('块不存在时返回 null，而不是崩溃或空数组', () => {
    // null 与 [] 必须可区分：null 是「没这个块」，[] 是「有块但列表为空」。
    // 两者混同的话，「配置被删干净了」和「解析坏了」就再也分不开。
    assert.equal(inlineList('nitro: {}'), null)
    assert.deepEqual(inlineList('nitro: {\n  externals: {\n    inline: []\n  }\n}'), [])
  })

  test('源文件里有 glob 路由串时也能解析（第一版在这里把整块吞掉了）', () => {
    const tricky =
      "routeRules: {\n      '/api/**': {\n        cors: true\n      }\n    },\n    externals: {\n      inline: ['x']\n    },"
    assert.deepEqual(inlineList(tricky), ["'x'"])
  })
})

describe('externals.inline：内联就是引入 interop 风险', () => {
  test('jsonwebtoken 不许被内联', () => {
    // 这是整条断言存在的理由。改成「内联列表里恰好有 N 个条目」这种写法不行 ——
    // 删掉这个包再加一个别的包，数字不变，测试照样绿。
    //
    // 注意这里用 `|| []`：期望状态是**整个 externals 块被删掉**，此时解析器
    // 合法地返回 null。第一版写成 assert.ok(inline !== null)，于是把配置删干净
    // 之后测试反而变红 —— 断言在要求它别被删。
    const inline = inlineList(NUXT) || []
    const offenders = inline.filter((e) => e.includes('jsonwebtoken'))
    assert.equal(
      offenders.length,
      0,
      `jsonwebtoken 被内联了（${offenders.join(', ')}）—— 它的 CJS 依赖会变成裸命名空间导入，` +
        `在 Node 上撞上 interop helper 的 1-key 假设，产物启动即崩`
    )
  })

  test('inline 列表里的每一项，项目代码里都得真的 import 它', () => {
    // `semver` 在 inline 列表里躺了很久，但全项目没有任何地方 import 它 ——
    // 纯粹的死配置，而它紧挨着真正生效的那一项，所以看起来像是有用的。
    // 不要求 inline 列表为空（将来有正当理由时可以用），但每一项都得有人用。
    const inline = inlineList(NUXT) || []
    const code = projectCode()
    const dead = inline.filter((e) => {
      const m = /^['"]([^'"]+)['"]$/.exec(e)
      if (!m) return false // 正则形式无法静态判断，跳过而不是误报
      const bare = m[1].replace(/^(@[^/]+\/[^/]+|[^/]+).*$/, '$1')
      return !new RegExp(`from ['"]${bare.replace(/[/.]/g, '\\$&')}['"]`).test(code)
    })
    assert.equal(dead.length, 0, `内联了却没人 import：${dead.join(', ')} —— 死配置`)
  })

  // 这里原本还有第三条：「inline 非空时 nuxt.config.ts 里必须有注释说明」。
  // 删掉了：写一句没有信息量的注释就能满足它，是伪装成强守卫的弱断言 ——
  // 扫变异的时候会直接把它标成「无实质作用」。真正的守卫是上面那两条。
})
