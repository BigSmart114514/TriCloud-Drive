// 把夹具的裸 sqlite3 句柄包成服务端 `getDb()` 那种形状，
// 好让 server/utils/sub-account.ts 里的**真函数**能直接吃测试库。
//
// ## 为什么要这个
//
// 服务端代码拿到的 db 长这样：
//
//     db.prepare(sql).bind(...params).first() | .all() | .run()
//
// 而夹具只提供 all(q, p) / run(q, p) / get(q, p)。形状不对就只能手抄 SQL，
// 而手抄版测的是「抄对没有」不是「代码对没有」—— 实际踩过：
// 把 poolWithinSql 里主账号自己那项删掉，手抄版与源码各跑各的，40 例全过。
//
// 照抄的三处返回形状来自 server/utils/db-adapter.ts（SQLite 分支）：
//   first() → row | undefined
//   all()   → { results: rows }          ← chainExpired 依赖这个 .results
//   run()   → { success: true, meta: this }  ← sub-account 的 affected() 读 meta.changes
//
// `all()` 返回带 results 包装这点很容易漏：sub-account.ts 的 chainExpired 写的是
// `rows?.results ?? []`，直接返回数组的话会静默当成「没有行」——
// 于是所有过期判定都返回「没过期」，而测试看着全绿。
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = new URL('../..', import.meta.url).pathname
const sqlite3 = require(join(ROOT, 'node_modules/sqlite3'))

/**
 * @param target sqlite 文件路径，或**已有的裸 sqlite3.Database 句柄**。
 *   传路径时必须是副本 —— 本函数不做任何保护，传生产/开发库路径进去等于让
 *   真函数直接改线上数据。
 *   传句柄时适用于内存库（openRawDb 造的那种）：那种场景本来就没有文件，
 *   让调用方另外落一个临时文件再传进来纯属多余。
 */
export function openAdapterDb(target) {
  const raw = typeof target === 'string' ? new sqlite3.Database(target) : target
  if (!raw || typeof raw.all !== 'function') {
    throw new TypeError(
      'openAdapterDb 需要文件路径或裸 sqlite3.Database 句柄，收到的是 ' + typeof target
    )
  }

  const all = (sql, params = []) =>
    new Promise((res, rej) => raw.all(sql, params, (e, rows) => (e ? rej(e) : res(rows || []))))
  const run = (sql, params = []) =>
    new Promise((res, rej) =>
      raw.run(sql, params, function (e) {
        if (e) rej(e)
        else res(this.changes)
      })
    )
  const get = async (sql, params = []) => (await all(sql, params))[0] ?? null

  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            first: () => get(sql, params),
            all: async () => ({ results: await all(sql, params) }),
            // meta 就是 sqlite3 的 Statement（带 changes），sub-account 的
            // affected() 读 meta.changes —— 这里必须真的把 this 透出去，
            // 返回空 meta 会让 changes 恒为 0，于是所有预占都判「失败」。
            run: () =>
              new Promise((res, rej) =>
                raw.run(sql, params, function (e) {
                  if (e) rej(e)
                  else res({ success: true, meta: this })
                })
              )
          }
        }
      }
    },

    // 测试里顺手要用的裸查询
    all,
    run,
    get,

    async close() {
      // 传进来的句柄由调用方负责关（openRawDb 会连内存库一起收），
      // 所以这里只关自己开的那一个。
      if (typeof target === 'string') await new Promise((res) => raw.close(res))
    }
  }

  return db
}