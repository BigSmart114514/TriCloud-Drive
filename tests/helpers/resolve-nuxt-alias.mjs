// 见 register-nuxt-alias.mjs 的说明。这个文件是那个 hook 的实现。
//
// 干两件事：
//   1. ~~/<x> → 仓库根下的 <x>（Nuxt4 约定：~~ = 项目根）
//   2. 补扩展名 —— Nuxt 允许 `from '~~/server/utils/time'` 这种无扩展名 import，
//      node 不允许。顺序固定 .ts → .mjs → .js：服务端代码全是 .ts，而 types/ 下
//      也是 .ts，但 helper 与少数脚本是 .mjs，两者都要能命中。
//
// 刻意**不做**的事：不解析 ~/ 与 @/（前端别名）。前端组件要 import .vue，
// 裸 node 处理不了，硬接进来只会让 hook 变成半吊子 —— 前端部分继续用源码断言测。
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

export function resolve(specifier, context, next) {
  if (!specifier.startsWith('~~/')) return next(specifier, context)
  const target = withExtension(join(ROOT, specifier.slice(3)))
  return { url: pathToFileURL(target).href, shortCircuit: true }
}