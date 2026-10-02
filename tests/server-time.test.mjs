// server/utils/time.ts 的单元测试。
// 核心不变量：expire_at 一律按 UTC 解释和生成 —— 解析端和生成端必须同源。
//
// 跑法：TZ=<任意> node --test tests/server-time.test.mjs
// TZ 故意设成非 UTC：如果实现里混进了 getFullYear() 这类本地方法，
// 下面的断言会挂。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseSqlDateTime, dateToSqlString, nowSqlString, isExpired, isSqlDateTimeString } from '../server/utils/time.ts'

describe('parseSqlDateTime —— SQL 时间按 UTC 解释', () => {
  test('空格分隔与 T 分隔等价', () => {
    const a = parseSqlDateTime('2026-01-01 12:00:00')
    const b = parseSqlDateTime('2026-01-01T12:00:00')
    assert.equal(a.getTime(), b.getTime())
    assert.equal(a.toISOString(), '2026-01-01T12:00:00.000Z')
  })

  // 关键：无时区后缀的按 UTC 解释。DB 里存的就是 UTC 墙钟。
  test('无时区后缀 = UTC（不按服务器本地时区）', () => {
    const d = parseSqlDateTime('2026-01-01 12:00:00')
    assert.equal(d.getUTCHours(), 12, '小时数原样保留，不能被本地时区搬走')
    assert.equal(d.getUTCMinutes(), 0)
    assert.equal(d.getUTCSeconds(), 0)
  })

  test('带 Z 或 ±HH:MM 的按后缀解析', () => {
    assert.equal(parseSqlDateTime('2026-01-01T12:00:00Z').toISOString(), '2026-01-01T12:00:00.000Z')
    assert.equal(parseSqlDateTime('2026-01-01T12:00:00+08:00').toISOString(), '2026-01-01T04:00:00.000Z')
  })

  test('Date / null / 非法值', () => {
    assert.equal(parseSqlDateTime(new Date('2026-01-01T00:00:00Z')).getTime(), Date.UTC(2026, 0, 1))
    assert.equal(parseSqlDateTime(null), null)
    assert.equal(parseSqlDateTime(undefined), null)
    assert.equal(parseSqlDateTime(''), null)
    assert.equal(parseSqlDateTime('   '), null)
    assert.equal(parseSqlDateTime('abc'), null)
  })
})

describe('dateToSqlString / nowSqlString —— 生成 UTC 墙钟', () => {
  test('dateToSqlString 用 UTC 字段', () => {
    const d = new Date(Date.UTC(2026, 8, 30, 10, 19, 37))
    assert.equal(dateToSqlString(d), '2026-09-30 10:19:37')
  })

  test('补零正确', () => {
    assert.equal(dateToSqlString(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), '2026-01-02 03:04:05')
  })

  // 回归：以前 save.post.ts / credentials.post.ts 里 nowSqlString 用的是
  // getFullYear()/getHours()（本地时区），服务器在 CST 时产出的值比真实 UTC
  // 快 8 小时，而 isExpired 按 UTC 解析它 —— 两端不同源。
  test('nowSqlString 与真实 UTC 一致（不受服务器 TZ 影响）', () => {
    const now = new Date()
    const expected =
      `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-` +
      `${String(now.getUTCDate()).padStart(2, '0')} ` +
      `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}:` +
      `${String(now.getUTCSeconds()).padStart(2, '0')}`
    assert.equal(nowSqlString(), expected)
  })

  test('生成 → 解析 能往返回同一个时刻', () => {
    const original = new Date('2026-09-30T10:19:37Z')
    const sql = dateToSqlString(original)
    assert.equal(parseSqlDateTime(sql).getTime(), original.getTime())
  })
})

describe('isExpired —— 过期判断', () => {
  const now = new Date('2026-06-15T12:00:00Z')

  test('过去的时间 = 过期', () => {
    assert.equal(isExpired('2026-06-15 11:59:59', now), true)
    assert.equal(isExpired('2020-01-01 00:00:00', now), true)
  })

  test('将来的时间 = 未过期', () => {
    assert.equal(isExpired('2026-06-15 12:00:01', now), false)
    assert.equal(isExpired('2099-01-01 00:00:00', now), false)
  })

  test('恰好等于当前时间 = 已过期（>= 而非 >）', () => {
    assert.equal(isExpired('2026-06-15 12:00:00', now), true)
  })

  // 关键：边界对齐。用服务器本地时间构造 expire_at 会让过期时间偏一个时区，
  // 这里用明确的 UTC 值验证。
  test('UTC 边界精确对齐', () => {
    assert.equal(isExpired('2026-06-15 11:59:59', now), true)
    assert.equal(isExpired('2026-06-15 12:00:00', now), true)
    assert.equal(isExpired('2026-06-15 12:00:01', now), false)
  })

  // 「没设过期时间」= 永不过期。解析失败也走这条路，
  // 因为脏数据不该把正常用户锁在外面。
  test('空值 / 无法解析 = 未过期', () => {
    for (const v of [null, undefined, '', '   ', 'abc', 'not-a-date']) {
      assert.equal(isExpired(v, now), false, `${String(v)} 应视为未过期`)
    }
  })
})

/**
 * 写入侧的校验，与 isExpired 的判定侧是**反向**语义，别混：
 *
 *   isExpired('')            → false（空值 = 没过期，放行）
 *   isSqlDateTimeString('')  → **false**（空串不是一个合法时间，拒绝）
 *
 * 所以建子账户 / 改额度那两个接口里，「空」必须**先**归一成 null 再判：
 * `if (expireAt != null && !isSqlDateTimeString(expireAt))`。
 * 顺序反过来就等于「留空也报错」，用户没法设永不过期。
 *
 * ─────────────────────────────────────────────────────────────
 * 但这个函数比名字暗示的**弱得多**，下面第二组把边界全记下来。
 * 它只是 `parseSqlDateTime(v) !== null`，而后者基本就是 `new Date(v)`，
 * 所以任何 Date 认得的串都放行。这是已知缺陷，不是设计。
 */
describe('isSqlDateTimeString：写入侧的合法性校验', () => {
  test('正常格式放行', () => {
    for (const v of [
      '2026-01-01 00:00:00',
      '2026-12-31 23:59:59',
      '2026-01-01T00:00:00',
      '2026-01-01 00:00:00Z',
      '2026-06-15 12:00:00.000Z'
    ]) {
      assert.equal(isSqlDateTimeString(v), true, `${v} 应放行`)
    }
  })

  test('明显是垃圾的串拒绝', () => {
    for (const v of ['not a date', 'abc', 'now', '20260101', '2026-13-45 99:99:99']) {
      assert.equal(isSqlDateTimeString(v), false, `${v} 应拒绝`)
    }
  })

  test('空值/空白一律拒绝（不与 isExpired 的空值语义混用）', () => {
    for (const v of ['', '   ', null, undefined]) {
      assert.equal(isSqlDateTimeString(v), false, `${JSON.stringify(v)} 应拒绝`)
    }
    assert.equal(isExpired(''), false, '而 isExpired 对空值是「未过期」—— 两个语义相反，这是有意的')
  })

  /**
   * 已知缺陷：宽松到能放行一些**不该**进库的值。
   *
   * 全部记在这里，是为了让「谁哪天把它改严了」有据可依，也为了让
   * 「为什么 expire_at 会分叉」这件事有个具体的例子。
   * 收紧它是行为变更（可能有存量用户靠 'YYYY-MM-DD' 这种简写），要单独决定。
   */
  test('【已知缺陷】比名字暗示的宽松得多：这些都放行', () => {
    for (const v of [
      '2026/01/01',        // 斜杠分隔
      '2026.01.01',        // 点分隔
      '01/01/2026',        // 月/日/年
      '2026-01-01',        // 没有时间部分
      '2026-01',           // 只有年月
      '2026-1-1',          // 不补零
      'Jan 1 2026',        // 英文月份
      '1',                 // → 2001-01-01
      '0',                 // → 2000-01-01
      '-5',                // → 2001-05-01（负数也当年份偏移）
      '+0200-01-01'        // → 0200 年
    ]) {
      assert.equal(isSqlDateTimeString(v), true, `${JSON.stringify(v)} 当前被放行`)
    }
  })

  test('【已知缺陷】非法日期静默进位，不报错', () => {
    // '2026-02-30' 变成 2026-03-02。用户填错日期，存进去的是另一个日子。
    assert.equal(isSqlDateTimeString('2026-02-30 00:00:00'), true)
    assert.equal(parseSqlDateTime('2026-02-30 00:00:00')?.toISOString(), '2026-03-02T00:00:00.000Z')
  })

  /**
   * 这条是上面那个宽松缺陷**真正会伤到人的地方**，也是
   * quota.ts 里 NOT_EXPIRED_SQL 注释所说的「残留差异」的一个具体实例。
   *
   * `isExpired` 走 parseSqlDateTime（认斜杠），而 NOT_EXPIRED_SQL 走 SQLite 的
   * TEXT 字符串比较（按字节，'/' = 0x2F > '-' = 0x2D）。同一个值，
   * 一边判「已过期」，一边判「未过期」。
   *
   * 后果：页面显示还有额度，点上传/下载报「额度不足」——
   * 用户把限额调到天上也没用，因为他要做的其实是改 expire_at。
   */
  test('【已知缺陷】放行的某些格式会让 isExpired 与 SQL 的判定分叉', () => {
    const now = new Date('2026-10-02T09:00:00Z')
    const NOW_SQL = '2026-10-02 09:00:00'

    // isExpired 侧：按 Date 解析，斜杠能被认 → 2026-01-01，早于 now → 已过期
    assert.equal(isExpired('2026/01/01', now), true, 'Date 能解析斜杠，判已过期')
    // SQL 侧：字符串比较 '2026/01/01' > '2026-10-02 09:00:00'
    //          前 4 位相同，第 5 位 '/' (0x2F) > '-' (0x2D) → 为真 → 判「未过期」
    assert.ok('2026/01/01' > NOW_SQL, 'SQL 的字符串比较会判它未过期 —— 与上面相反')
    assert.equal(isSqlDateTimeString('2026/01/01'), true, '而写入侧的校验放它进来')

    // 结论：这个值能存进库，然后让两个判定打架。
    // 要根治得让 isSqlDateTimeString 只认 YYYY-MM-DD[ HH:MM:SS] 这个形状。
    const sqlSaysExpired = !('2026/01/01' > NOW_SQL) // NOT_EXPIRED_SQL 为假 = 过期
    assert.equal(isExpired('2026/01/01', now), true, '判定侧说过期')
    assert.equal(sqlSaysExpired, false, 'SQL 侧说未过期')
    assert.notEqual(isExpired('2026/01/01', now), sqlSaysExpired, '两边判定相反')
  })
})
