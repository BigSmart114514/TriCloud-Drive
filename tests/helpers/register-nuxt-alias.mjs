// 让 node:test 能直接 import 服务端的 .ts 模块。
//
// ## 为什么需要
//
// 服务端源码里到处是 `import ... from '~~/server/utils/xxx'`（Nuxt 的根别名）。
// node 既不认 `~`/`@`/`~~` 这几个别名，package.json 的 `imports` 字段也**要求
// specifier 以 `#` 开头**，所以别名不了 —— 唯一的办法是挂一个 resolve hook。
//
// ## 为什么值得挂
//
// 没有它，测配额链只能**手抄** sub-account.ts 里的 SQL 再拿 sqlite 跑一遍。
// 那种测法有个致命弱点：它测的是「我抄对了没有」，不是「发布的代码对不对」。
// 实际踩过 —— 把 poolWithinSql 里 `COALESCE(p.${col}, 0)`（池里主账号自己那一份）
// 删掉，手抄版与源码各自独立跑，40 例**全过**。
//
// 挂上之后 reserveStorage / poolUsage / precheckDownload 这些都能**直接调真函数**，
// 变异测试就不必再靠源码字面量断言兜底。
//
// ## 只拦 ~~/ 前缀
//
// 别的 specifier 一律交回默认解析，所以挂它不影响任何现有测试。
import { register } from 'node:module'

register(new URL('./resolve-nuxt-alias.mjs', import.meta.url), import.meta.url)