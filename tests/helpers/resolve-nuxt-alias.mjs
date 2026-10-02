// 见 register-nuxt-alias.mjs 的说明。这个文件是那个 hook 的实现。
//
// 干两件事：
//   1. ~~/<x> → 仓库根下的 <x>（Nuxt4 约定：~~ = 项目根）
//   2. 补扩展名 —— Nuxt 允许 `from '~~/server/utils/time'` 这种无扩展名 import，
//      node 不允许。顺序固定 .ts → .mjs → .js：服务端代码全是 .ts，而 types/ 下
//      也是 .ts，但 helper 与少数脚本是 .mjs，两者都要能命中。
//
// ## 拦哪些前缀
//
// ~~/ = 项目根（Nuxt4 约定）。另外也拦 ~/ —— 那是前端别名，同样指向 srcDir。
// 起初刻意只拦 ~~/，理由是「前端组件要 import .vue，裸 node 处理不了，接进来
// 只会变成半吊子」。这个理由对 **.vue** 仍然成立，但拦 ~/ 与能不能处理 .vue
// 无关：app/utils/ 与 app/composables/ 下全是纯 .ts（composable 只依赖 vue），
// 完全可以直接 import。把别名接上之后 useAsyncResource / useArchiveTree /
// withScope 这些才测得了真函数，而不用手抄。
//
// 仍然处理不了的：任何 import 到 .vue 的地方（组件本体）。前端组件继续用
// 源码断言测，那部分没有变。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Nuxt 允许无扩展名 import，这里补上。找不到就原样返回，让默认解析报错
 * —— 静默返回 base 会变成一条看不懂的 ERR_MODULE_NOT_FOUND。
 *
 * 顺序：先试「base + 扩展名」（覆盖 `~~/server/utils/time` 这种），
 * 再试原样（覆盖 .json / .css 之类带后缀的），最后试 base/index.ts。
 */
function withExtension(base) {
  for (const ext of ['.ts', '.mjs', '.js']) {
    if (existsSync(base + ext)) return base + ext
  }
  if (existsSync(base)) return base
  if (existsSync(join(base, 'index.ts'))) return join(base, 'index.ts')
  return base
}

// ~~/ → 仓库根；~/ → app/（Nuxt4 里 srcDir 是 app/，所以这两个别名指向不同目录，
// 不是同一个。第一版把 ~/ 也映射到根，于是 import '~/utils/notify' 去找
// <root>/utils/notify，报 ENOENT —— 那个文件实际在 app/utils/notify.ts。
const PREFIXES = [
  ['~~/', ''],
  ['@/', ''],
  ['~/', 'app/']
]

export function resolve(specifier, context, next) {
  const hit = PREFIXES.find(([p]) => specifier.startsWith(p))
  if (!hit) return next(specifier, context)
  const [prefix, dir] = hit
  const target = withExtension(join(ROOT, dir, specifier.slice(prefix.length)))
  return { url: pathToFileURL(target).href, shortCircuit: true }
}