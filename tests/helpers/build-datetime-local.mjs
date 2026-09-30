// 把 app/utils/datetimeLocal.ts 编译成 node 能直接 import 的形式。
//
// 三个障碍：
//   1. `~/utils/time` 是 Nuxt 别名，node 的解析器不认 → esbuild alias
//   2. useRuntimeConfig() 是 Nuxt 注入的全局，app/utils/time.ts 里的
//      configuredTimeZone 要读它 → 用 esbuild 的 inject 把 shim 注入到**每个模块**
//      （只改入口文件没用：utils/time.ts 是被 bundle 进来的依赖，那里的
//       useRuntimeConfig 仍然未定义，会走进 catch 回落成默认 +8）
//   3. app/utils/time.ts 也有 `~/` 引用时同样靠 alias
//
// 产物写到 .build-test/ 下，跑完即弃，已加进 .gitignore。
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// 本文件在 tests/helpers/ 下，所以仓库根是上两级（../..）
const ROOT = new URL('../..', import.meta.url).pathname
const OUT_DIR = join(ROOT, '.build-test')

export function buildDatetimeLocal() {
  mkdirSync(OUT_DIR, { recursive: true })

  // inject 用的 shim：define 到 globalThis，任何模块里裸调用 useRuntimeConfig 都能拿到
  const shimPath = join(OUT_DIR, 'runtime-config-shim.js')
  writeFileSync(
    shimPath,
    `globalThis.useRuntimeConfig = () => ({
       public: { TimeZone: ${JSON.stringify(process.env.TIMEZONE || '+8')} }
     });\n`
  )

  return build({
    entryPoints: [join(ROOT, 'app/utils/datetimeLocal.ts')],
    outfile: join(OUT_DIR, 'datetimeLocal.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    // 注入到每个模块，utils/time.ts 里的 useRuntimeConfig 才会被替换
    inject: [shimPath],
    alias: { '~/utils/time': join(ROOT, 'app/utils/time.ts') },
    logLevel: 'error'
  }).then(() => join(OUT_DIR, 'datetimeLocal.mjs'))
}
