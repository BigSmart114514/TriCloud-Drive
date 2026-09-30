// server/utils/time.ts 的单元测试。
// 核心不变量：expire_at 一律按 UTC 解释和生成 —— 解析端和生成端必须同源。
//
// 跑法：TZ=<任意> node --test tests/server-time.test.mjs
// TZ 故意设成非 UTC：如果实现里混进了 getFullYear() 这类本地方法，
// 下面的断言会挂。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseSqlDateTime, dateToSqlString, nowSqlString, isExpired } from '../server/utils/time.ts'

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
