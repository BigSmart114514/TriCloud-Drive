// app/utils/datetimeLocal.ts 的单元测试。
// 关键：DB 存 UTC，输入框是「按 TimeZone 换算后的本地墙钟」，两个方向必须配平。
//
// 注意 parseExpireAt **要求秒**（正则 6 段）。<input type="datetime-local"> 在
// 用户没碰秒时给的是 "YYYY-MM-DDTHH:mm"（5 段），必须先补 ":00" 再校验 ——
// 不补的话调用方会把用户刚填的值当成非法然后清空。
//
// 跑法：node --test tests/datetime-local.test.mjs
// TimeZone 从 process.env.TIMEZONE 取，与 nuxt.config.ts 的默认值 '+8' 一致；
// 想验别的时区：TIMEZONE=-5 node --test tests/datetime-local.test.mjs
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { buildDatetimeLocal } from './helpers/build-datetime-local.mjs'

let parseExpireAt, toDatetimeLocal, fromDatetimeLocal

before(async () => {
  const mod = await import(await buildDatetimeLocal())
  ;({ parseExpireAt, toDatetimeLocal, fromDatetimeLocal } = mod)
})

/** 与 fromDatetimeLocal / normalizeExpire 相同的补秒规则 */
const withSeconds = (raw) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw) ? `${raw}:00` : raw

describe('datetime-local 的「没碰秒」形态', () => {
  // 回归：normalizeExpire 原来直接拿 5 段的值去校验，parseExpireAt 返回 null，
  // 于是 blur 时把用户刚填的时间清空 —— 表现是「改了没反应」。
  // 现在 parseExpireAt 直接接受 5 段，调用方不必记得先补秒。
  test('5 段（无秒）被接受，秒补 00', () => {
    assert.equal(parseExpireAt('2027-01-01T09:00'), '2027-01-01 09:00:00')
    assert.equal(parseExpireAt('2027-01-01 09:00'), '2027-01-01 09:00:00')
  })

  test('调用方补秒后结果一致（幂等）', () => {
    assert.equal(parseExpireAt(withSeconds('2027-01-01T09:00')), '2027-01-01 09:00:00')
    assert.equal(
      parseExpireAt(withSeconds(parseExpireAt('2027-01-01T09:00'))),
      '2027-01-01 09:00:00'
    )
  })

  test('fromDatetimeLocal 也接受 5 段', () => {
    assert.match(fromDatetimeLocal('2027-01-01T09:00'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  test('6 段原样通过，不被重复补秒', () => {
    assert.equal(parseExpireAt(withSeconds('2027-01-01T09:00:30')), '2027-01-01 09:00:30')
  })

  test('非法日期仍被拒（5 段和 6 段都不放过）', () => {
    assert.equal(parseExpireAt(withSeconds('2027-02-31T09:00')), null)
    assert.equal(parseExpireAt('2027-02-31T09:00:00'), null)
  })

  // step 含小数时浏览器会给毫秒。早先的正则会把它判成非法 → 同样清空输入。
  test('容忍毫秒（step 含小数的 datetime-local 会给 .123）', () => {
    assert.equal(parseExpireAt('2027-01-01T09:00:30.123'), '2027-01-01 09:00:30')
    assert.equal(parseExpireAt('2027-01-01T09:00:30.999'), '2027-01-01 09:00:30')
    assert.equal(parseExpireAt('2027-01-01T09:00.500'), '2027-01-01 09:00:00')
  })

  test('toDatetimeLocal 的输出总能被 parseExpireAt 认回来', () => {
    const out = toDatetimeLocal('2027-01-01 00:00:00')
    assert.match(out, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
    assert.ok(parseExpireAt(out), '自己吐出来的值自己得认')
  })
})

describe('parseExpireAt —— 纯格式校验，不涉及时区', () => {
  test('规范化为空格分隔', () => {
    assert.equal(parseExpireAt('2026-01-01 00:00:00'), '2026-01-01 00:00:00')
    assert.equal(parseExpireAt('2026-01-01T00:00:00'), '2026-01-01 00:00:00')
    assert.equal(parseExpireAt('  2026-12-31T23:59:59  '), '2026-12-31 23:59:59')
  })

  test('单位数日期/时间不接受（正则要求两位，与原行为一致）', () => {
    // DB 和 datetime-local 都产出两位，补零的必要只在显示侧
    assert.equal(parseExpireAt('2026-1-1 0:0:0'), null)
    assert.equal(parseExpireAt('2026-01-01 0:00:00'), null)
  })

  test('空/无效返回 null', () => {
    // 注意 '2026-01-01 00:00' 是**有效**的（秒可选），所以不在这个列表里
    for (const v of [null, '', '   ', 'abc', '2026-01-01', '2026-01-01 00', '2026/01/01 00:00']) {
      assert.equal(parseExpireAt(v), null, `${String(v)} 应为 null`)
    }
  })

  // 以前这里用 new Date(y, mo-1, d, h, …) 做校验，那是**本地时区**构造。
  // 在某些时区下 2025-02-31 会被自动进位成 3-03，校验形同虚设。
  test('拒绝不存在的日期（不因时区而被进位放过）', () => {
    assert.equal(parseExpireAt('2025-02-31 00:00:00'), null)
    assert.equal(parseExpireAt('2025-13-01 00:00:00'), null)
    assert.equal(parseExpireAt('2025-01-32 00:00:00'), null)
    assert.equal(parseExpireAt('2025-04-31 00:00:00'), null)
  })

  test('接受闰年的 2 月 29', () => {
    assert.equal(parseExpireAt('2024-02-29 00:00:00'), '2024-02-29 00:00:00')
    assert.equal(parseExpireAt('2025-02-29 00:00:00'), null, '2025 不是闰年')
  })
})

describe('时区往返 —— DB(UTC) ↔ 输入框(local)', () => {
  // 核心不变量：往返回同一个值，偏移量必须完全抵消。
  const tz = process.env.TIMEZONE || '+8'

  test(`DB → 输入框 → DB 往返一致（TimeZone=${tz}）`, () => {
    const samples = [
      '2026-01-01 00:00:00',
      '2026-09-30 10:19:37',
      '2026-06-15 23:59:59',
      '2027-03-01 12:34:56'
    ]
    for (const db of samples) {
      const local = toDatetimeLocal(db)
      assert.equal(fromDatetimeLocal(local), db, `${db} 往返不一致`)
    }
  })

  test('往返不一致就是真 bug：偏移没抵消', () => {
    // 如果两个方向的偏移量不等，这里必然失败
    assert.equal(fromDatetimeLocal(toDatetimeLocal('2026-01-01 00:00:00')), '2026-01-01 00:00:00')
  })
})

describe('toDatetimeLocal —— DB(UTC) → 输入框，按 TimeZone 偏移', () => {
  test('空值返回空串', () => {
    assert.equal(toDatetimeLocal(null), '')
    assert.equal(toDatetimeLocal(''), '')
    assert.equal(toDatetimeLocal('   '), '')
  })

  test('无效值返回空串而不是 "Invalid Date"', () => {
    assert.equal(toDatetimeLocal('abc'), '')
    assert.equal(toDatetimeLocal('2026-13-45 99:99:99'), '')
  })

  test('输出是输入框要的 T 分隔 + 含秒', () => {
    const out = toDatetimeLocal('2026-01-01 00:00:00')
    assert.match(out, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
  })

  test('偏移量正好是 TIMEZONE 配的那个值', () => {
    const tz = (process.env.TIMEZONE || '+8').replace(/^(?:UTC|GMT)/i, '').trim()
    const m = tz.match(/^([+-])?(\d{1,2})(?::?(\d{2}))?$/)
    if (!m) return // 配了 IANA 名字，本测试跳过
    const sign = m[1] === '-' ? -1 : 1
    const minutes = sign * (Number(m[2]) * 60 + Number(m[3] || 0))

    const out = toDatetimeLocal('2026-01-01 00:00:00')
    const [d, t] = out.split('T')
    const [Y, Mo, D] = d.split('-').map(Number)
    const [h, mi, s] = t.split(':').map(Number)

    // 与「UTC 基准时刻 + 偏移分钟」逐字段比对，不依赖任何本地时区
    const base = Date.UTC(2026, 0, 1, 0, 0, 0) + minutes * 60 * 1000
    const d2 = new Date(base)
    assert.equal(Y, d2.getUTCFullYear())
    assert.equal(Mo, d2.getUTCMonth() + 1)
    assert.equal(D, d2.getUTCDate())
    assert.equal(h, d2.getUTCHours())
    assert.equal(mi, d2.getUTCMinutes())
    assert.equal(s, d2.getUTCSeconds())
  })
})

describe('fromDatetimeLocal —— 输入框(local) → DB(UTC)', () => {
  test('空值返回 null = 不过期', () => {
    assert.equal(fromDatetimeLocal(null), null)
    assert.equal(fromDatetimeLocal(''), null)
    assert.equal(fromDatetimeLocal('  '), null)
  })

  test('补秒', () => {
    const out = fromDatetimeLocal('2026-01-01T08:00')
    assert.match(out, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  test('非法日期返回 null', () => {
    assert.equal(fromDatetimeLocal('2025-02-31T00:00'), null)
    assert.equal(fromDatetimeLocal('abc'), null)
  })

  test('偏移量正好是 TIMEZONE 的相反数', () => {
    const tz = (process.env.TIMEZONE || '+8').replace(/^(?:UTC|GMT)/i, '').trim()
    const m = tz.match(/^([+-])?(\d{1,2})(?::?(\d{2}))?$/)
    if (!m) return
    const sign = m[1] === '-' ? -1 : 1
    const minutes = sign * (Number(m[2]) * 60 + Number(m[3] || 0))

    // 输入框的墙钟 2026-01-01T00:00，减去偏移后写进 DB
    const out = fromDatetimeLocal('2026-01-01T00:00:00')
    const [y, mo, d, h, mi] = out.split(/[ :-]/).map(Number)
    const expected = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) - minutes * 60 * 1000)
    assert.equal(y, expected.getUTCFullYear())
    assert.equal(mo, expected.getUTCMonth() + 1)
    assert.equal(d, expected.getUTCDate())
    assert.equal(h, expected.getUTCHours())
    assert.equal(mi, expected.getUTCMinutes())
  })
})
