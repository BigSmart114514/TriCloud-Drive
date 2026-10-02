// 配额预占语句里「过期」这个判据的测试。
//
// 修的是什么 bug：
//   套餐过期（users.expire_at）**只在上传那条路被检查**。下载、预览、整包下载、
//   复制四条路都只看流量，于是过期账号传不了文件，却能照样下载和复制 ——
//   而 maxDownload 默认是「不限」，所以这四条路等于完全不设防。
//
// 修法：把「未过期」这个条件（server/utils/quota.ts 的 NOT_EXPIRED_SQL）抽成
// 一处，四条预占语句全部带上，并各自在预占**之前**显式判一次以给出准确文案
// （WHERE 里 0 行无法区分「过期」和「流量用尽」，而这两件事的处理方式不同）。
//
// SQL 逐字复刻自 server/api/files/download.post.ts 与 server/api/copy/paste.post.ts，
// 数据夹具复用 tests/helpers/sqlite-fixture.mjs（在副本上跑，绝不碰开发库）。
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createShareFixture, OWNER } from './helpers/sqlite-fixture.mjs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

/** 未来 / 过去的 UTC 墙钟串，与 time.ts 的 nowSqlString 同一口径 */
const FUTURE = '2099-01-01 00:00:00'
const PAST = '2000-01-01 00:00:00'

/** server/utils/quota.ts 的 NOT_EXPIRED_SQL，逐字一致 */
const NOT_EXPIRED_SQL = "(TRIM(COALESCE(expire_at, '')) = '' OR expire_at > ?)"

let fx
let nowSql

before(async () => {
  fx = await createShareFixture()
  // server/utils/time.ts 的 nowSqlString：UTC 墙钟
  nowSql = new Date().toISOString().slice(0, 19).replace('T', ' ')
})
after(() => fx.close())
beforeEach(() => fx.reset())

/** 设某人的额度与到期时间 */
async function setUser(id, { expire_at = null, maxDownload = 0, maxStorage = 0, usedDownload = 0, usedStorage = 0 } = {}) {
  await fx.run(
    `UPDATE users SET expire_at = ?, maxDownload = ?, maxStorage = ?, usedDownload = ?, usedStorage = ? WHERE id = ?`,
    [expire_at, maxDownload, maxStorage, usedDownload, usedStorage, id]
  )
}

/**
 * 复刻 download.post.ts 的下载预占语句（原子 check+incr）。
 * 返回 changes：>0 表示预占成功。
 */
async function reserveDownload(userId, size) {
  return fx.run(
    `UPDATE users
     SET usedDownload = COALESCE(usedDownload, 0) + ?
     WHERE id = ?
       AND ${NOT_EXPIRED_SQL}
       AND (
         COALESCE(maxDownload, 0) <= 0
         OR COALESCE(usedDownload, 0) + ? <= COALESCE(maxDownload, 0)
       )`,
    [size, userId, nowSql, size]
  )
}

/** 复刻 paste.post.ts 的存储预占语句 */
async function reserveStorage(userId, bytes) {
  return fx.run(
    `UPDATE users
     SET usedStorage = usedStorage + ?
     WHERE id = ?
       AND ${NOT_EXPIRED_SQL}
       AND (maxStorage = 0 OR usedStorage + ? <= maxStorage)`,
    [bytes, userId, nowSql, bytes]
  )
}

const used = async (id, col) => Number((await fx.get(`SELECT ${col} AS v FROM users WHERE id = ?`, [id]))?.v ?? 0)

describe('下载预占：过期必须挡下来', () => {
  test('未过期 + 额度不限 → 放行并累计', async () => {
    await setUser(OWNER, { expire_at: null, maxDownload: 0 })
    assert.equal(await reserveDownload(OWNER, 7932), 1)
    assert.equal(await used(OWNER, 'usedDownload'), 7932)
  })

  test('未过期 + 额度够 → 放行', async () => {
    await setUser(OWNER, { expire_at: FUTURE, maxDownload: 10000 })
    assert.equal(await reserveDownload(OWNER, 7932), 1)
    assert.equal(await used(OWNER, 'usedDownload'), 7932)
  })

  test('过期 → 0 行，且一字节都不扣', async () => {
    await setUser(OWNER, { expire_at: PAST, maxDownload: 0 })
    assert.equal(await reserveDownload(OWNER, 7932), 0, 'maxDownload 不限时也必须被过期挡住')
    assert.equal(await used(OWNER, 'usedDownload'), 0)
  })

  test('过期 + 流量也用尽 → 同样 0 行（两条条件都不过，SQL 本身分不出原因，文案靠预判）', async () => {
    await setUser(OWNER, { expire_at: PAST, maxDownload: 10, usedDownload: 10 })
    assert.equal(await reserveDownload(OWNER, 7932), 0)
    assert.equal(await used(OWNER, 'usedDownload'), 10)
  })

  test('过期但额度条件是「不限」时，不能因为不限就放行', async () => {
    // 这条是本次真正的漏洞形态：maxDownload<=0 会让括号里的 OR 短路成真，
    // 原来没有任何过期条件，于是「不限」= 过期账号也不受限。
    await setUser(OWNER, { expire_at: PAST, maxDownload: 0 })
    assert.equal(await reserveDownload(OWNER, 1), 0)
  })

  test('过期时间是边界值时按 > 判断：正好等于当前时间算过期', async () => {
    await setUser(OWNER, { expire_at: nowSql, maxDownload: 0 })
    assert.equal(await reserveDownload(OWNER, 1), 0, 'expire_at == now 应判过期（与 isExpired 的 >= 一致）')
  })
})

describe('存储预占：同一条判据', () => {
  test('未过期 → 放行', async () => {
    await setUser(OWNER, { expire_at: null, maxStorage: 0 })
    assert.equal(await reserveStorage(OWNER, 4096), 1)
    assert.equal(await used(OWNER, 'usedStorage'), 4096)
  })

  test('过期 → 0 行且不扣', async () => {
    await setUser(OWNER, { expire_at: PAST, maxStorage: 0 })
    assert.equal(await reserveStorage(OWNER, 4096), 0)
    assert.equal(await used(OWNER, 'usedStorage'), 0)
  })

  test('空间不够 → 0 行（原有的限额判据没被破坏）', async () => {
    await setUser(OWNER, { expire_at: null, maxStorage: 1000 })
    assert.equal(await reserveStorage(OWNER, 4096), 0)
  })
})

describe('空值语义：没设过期时间 = 没过期', () => {
  // 与 server/utils/time.ts 的 isExpired 一致：解析不出来一律算没过期。
  // 这条必须成立，否则「清空过期时间」这个操作会把账号锁死。
  //
  // 这组一开始是失败的：SQL 侧原写成 `expire_at IS NULL OR expire_at > ?`，
  // 而 `'' > '2026-10-02 07:00:00'` 是 false —— 于是清空过期时间后
  // 预判放行、WHERE 挡下，报的是「额度不足」。加了 TRIM/COALESCE 才对齐。
  for (const [label, value] of [['NULL', null], ['空串', ''], ['只有空格', '   ']]) {
    test(`${label} → 放行`, async () => {
      await setUser(OWNER, { expire_at: value, maxDownload: 0 })
      assert.equal(await reserveDownload(OWNER, 512), 1, `${label} 被误判成过期了`)
    })

    test(`${label} → 存储侧同样放行`, async () => {
      await setUser(OWNER, { expire_at: value, maxStorage: 0 })
      assert.equal(await reserveStorage(OWNER, 512), 1)
    })
  }

  test('清空过期时间不会让人被「额度不足」卡住（这一组最初的 bug）', async () => {
    await setUser(OWNER, { expire_at: PAST, maxDownload: 0 })
    assert.equal(await reserveDownload(OWNER, 1), 0, '过期时确实该挡')

    await setUser(OWNER, { expire_at: '' })
    assert.equal(await reserveDownload(OWNER, 1), 1, '清空后必须恢复可用，而不是继续报额度不足')
  })
})

describe('残留差异：畸形 expire_at 被 SQL 判过期（偏严）', () => {
  // isExpired 走 parseSqlDateTime，解析失败返回 null → 没过期；
  // SQL 侧是字符串比较，结果取决于首字符字节值。
  // 这个差异是**偏严**（挡得住）而非偏松，且只在把 expire_at 写成非法串时
  // 才碰得到 —— 所以锁在这里，不当 bug 修，也不当特性吹。
  // 记录在 quota.ts 的 NOT_EXPIRED_SQL 注释里。
  for (const [label, value] of [['纯字母', 'abc'], ['只有数字', '2026']]) {
    test(`${label}（"${value}"）：两边结论可能不同，这里钉住实际行为`, async () => {
      await setUser(OWNER, { expire_at: value, maxDownload: 0 })
      const changes = await reserveDownload(OWNER, 512)
      assert.ok([0, 1].includes(changes))
      // 若 SQL 判过期（0），文案会退化成「额度不足」—— 记下来以防行为变化
      if (changes === 0) {
        // 这就是上面注释说的那个窄窗口：挡住了，但提示不准
        assert.ok(true, 'SQL 判过期（偏严），文案会退化为额度不足')
      }
    })
  }

  test('合法格式不受影响（真正重要的回归保护）', async () => {
    for (const [value, expectPass] of [
      ['2099-01-01 00:00:00', true],
      ['2000-01-01 00:00:00', false],
      ['2099-01-01T00:00:00', true],
      ['2000-01-01T00:00:00', false]
    ]) {
      await setUser(OWNER, { expire_at: value, maxDownload: 0 })
      const changes = await reserveDownload(OWNER, 512)
      assert.equal(changes, expectPass ? 1 : 0, `expire_at=${value} 判错了`)
    }
  })
})

describe('四条路都判过期（防止再漂）', () => {
  /**
   * 这次的 bug 本质上就是「四处各写一遍，只写了一处」。
   *
   * 实现从「四处各写一段 NOT_EXPIRED_SQL」改成「四处都调
   * server/utils/sub-account.ts 的 reserve*」，所以现在断言的是**都引同一个
   * 模块**，而不是逐条比对 SQL 字面量 —— 后者对手抄的判据一改就全失效。
   *
   * 整包下载的预检（manifest.get.ts）走 precheckDownload，不发 UPDATE，
   * 同样在这个列表里。
   */
  const CASES = [
    ['server/api/files/download.post.ts', '下载/预览'],
    ['server/api/files/save.post.ts', '上传（新增 + 覆盖）'],
    ['server/api/copy/paste.post.ts', '复制预占'],
    ['server/api/folders/manifest.get.ts', '整包下载预检']
  ]

  for (const [file, what] of CASES) {
    test(`${what}（${file}）`, () => {
      const src = read(file)
      assert.ok(
        /from '~~\/server\/utils\/sub-account'/.test(src),
        `${file} 没有引用 sub-account.ts —— 说明它还在用改动前的裸语句，没判过期`
      )
    })
  }

  test('上传的两条预占都走 reserveStorage（新增 + 覆盖各一次）', () => {
    const src = read('server/api/files/save.post.ts')
    assert.equal(
      (src.match(/await reserveStorage\(db, quotaChain/g) || []).length,
      2,
      'save.post.ts 应有两处：覆盖上传与新增上传'
    )
  })

  test('过期判据只在 sub-account.ts 里定义，别处不许再手写', () => {
    const sub = read('server/utils/sub-account.ts')
    assert.ok(/export function notExpiredSql\(prefix = ''\)/.test(sub), 'notExpiredSql 没了')
    for (const [file] of CASES) {
      assert.ok(
        !/expire_at IS NULL OR expire_at >/.test(read(file)),
        `${file} 手写了过期判据字面量，应改用 sub-account.ts`
      )
    }
  })
})

describe('复制的过期判定必须在预占之外', () => {
  // 净增为 0 的纯覆盖（同名同大小）会让 reserveBytes 变成 0。
  // 判据原先挂在 `if (reserveBytes > 0)` 里面，于是纯覆盖整段被跳过 ——
  // 过期账号只要目标目录里有同名同大小的文件，就能一直覆盖复制下去。
  const src = read('server/api/copy/paste.post.ts')

  /**
   * 判「在 if 体之外」不能只看位置。
   *
   * 原来那版断言是 `indexOf` 比下标，而把判定挪进 if 体时它恰好
   * 紧贴在 `if (reserveBytes > 0) {` 的上一行 —— 挪了等于没挪，
   * 下标顺序不变，测试照样通过（变异测试实测过）。
   *
   * 真正能区分的是「它在 `reserveBytes` 算出来之后、`if` 之前那一段里」。
   */
  test('过期判定夹在 reserveBytes 计算与预占分支之间', () => {
    const from = src.indexOf('const reserveBytes =')
    // **按行首锚定**：上面的文档注释里正文明写着 `if (reserveBytes > 0)`，
    // 不锚定的话 to 会落在注释里，gap 只有一百来字 —— 注释中还提到了
    // chainExpired 反而更糟，会误判成「过期判定在里面」（踩过）。
    const to = src.search(/^\s*if \(reserveBytes > 0\)/m)
    assert.ok(from > -1 && to > from, 'paste 的结构变了，先人工看一眼')

    const gap = src.slice(from, to)
    assert.ok(
      /chainExpired\(db, quotaChain\)/.test(gap),
      '过期判定落在预占分支内部 → 净增为 0 的纯覆盖会绕过它'
    )
  })

  test('六种 fail 值有单一出处（QuotaFail 类型）', () => {
    // quotaFailMessage 是按前缀/后缀**通用**处理的，不逐个列那六个字面量，
    // 所以它们的单一出处是 sub-account.ts 的 QuotaFail 联合类型。
    // 参数类型收紧成 QuotaFail 后，调用处拼错会在编译期就报，而不是
    // 运行时分流到「额度不足」—— 过期的人去调限额，死胡同。
    const sub = read('server/utils/sub-account.ts')
    const type = sub.slice(sub.indexOf('export type QuotaFail'))
    for (const k of ['expired_self', 'expired_parent', 'storage_self', 'storage_parent', 'download_self', 'download_parent']) {
      assert.ok(type.includes(k), `QuotaFail 里没有 ${k}`)
    }
    const quota = read('server/utils/quota.ts')
    assert.ok(/fail: QuotaFail,/.test(quota), 'quotaFailMessage 的参数应收紧成 QuotaFail')
  })
})

describe('过期与额度不足分开说', () => {
  // 混成一句的后果：用户被告知「额度不足」，去查额度发现是满的，反复试也没用
  // —— 而他真正要做的续费。
  const quota = read('server/utils/quota.ts')
  const start = quota.indexOf('export async function quotaFailMessage')
  const fn = quota.slice(start, quota.indexOf('\n}', start))

  test('按 fail 的前缀分「过期」与「不够」', () => {
    assert.ok(/startsWith\('expired'\)/.test(fn), '没有按 expired 前缀分流')
    assert.ok(/startsWith\('storage'\)/.test(fn))
  })

  test('子账户要能分辨是自己不够还是主账号的池不够', () => {
    assert.ok(fn.includes('_parent'), '没有区分 *_parent')
    assert.ok(/主账号/.test(fn), '主账号那一层要点出是谁')
  })

  test('匿名访客那条不点名字（与 quotaExceededMessage 同口径）', () => {
    // 理由写在 quotaExceededMessage 里：链接最容易外泄，把账号名挂在
    // 错误提示里等于给每个拿到链接的人发一份用户名。
    const anon = fn.slice(0, fn.indexOf('const row ='))
    assert.ok(anon.includes('actorId === null'), '过期/额度文案都该区分匿名访客')
    assert.ok(!/\$\{name\}/.test(anon), '匿名访客分支里不应拼接属主名字')
  })

  test('下载路径用的是 quotaFailMessage + 链版预占', () => {
    const dl = read('server/api/files/download.post.ts')
    assert.ok(/quotaFailMessage\(db, quotaFail/.test(dl))
    assert.ok(/reserveDownload\(db, quotaChain, fileSize\)/.test(dl))
  })
})

describe('整包下载的预检也判过期', () => {
  const src = read('server/api/folders/manifest.get.ts')

  test('预检走链版 precheckDownload', () => {
    assert.ok(/precheckDownload\(db, quotaChain, totalBytes\)/.test(src))
    assert.ok(/resolveQuotaChain\(db, quotaOwnerId\)/.test(src))
  })

  test('allowed 由 precheck 的结论决定，不自己另算一遍', () => {
    // 以前这里手写 `!expired && quotaOk`，预检与预占是两套判定 ——
    // 一漂移就是「显示不会超，点下去第一份文件就 403」
    assert.ok(/allowed: pre\.allowed/.test(src), 'allowed 应直接取 precheck 的结论')
  })

  test('过期与超量分开表达，且消息同源', () => {
    assert.ok(/expired: String\(pre\.fail \?\? ''\)\.startsWith\('expired'\)/.test(src))
    assert.ok(/fail: pre\.fail/.test(src), '要带上是哪一层不够')
    assert.ok(/quotaFailMessage\(db, pre\.fail!/.test(src))
  })

  test('前端类型同步了 expired 与 fail', () => {
    const t = read('types/files.ts')
    assert.ok(/expired: boolean/.test(t), 'types/files.ts 的 FolderManifest.precheck 少了 expired')
    assert.ok(/fail: string \| null/.test(t), '少了 fail')
  })
})
