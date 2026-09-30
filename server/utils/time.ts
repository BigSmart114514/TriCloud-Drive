/**
 * 服务端时间工具。
 *
 * 约定：expire_at / created_at 这类 SQL 时间列一律存 **UTC 墙钟**
 * （"2026-01-01 12:00:00"），不带时区后缀。
 * 前端按 runtimeConfig.public.TimeZone 偏移显示（见 app/utils/datetimeLocal.ts）。
 *
 * 因此凡是「生成 SQL 时间字符串」的地方必须用 UTC 方法（getUTC*），
 * 凡是「比较」的地方必须按 UTC 解析 —— 混用会让过期判断整体偏一个时区。
 */

/**
 * SQL 时间字符串 → Date（按 UTC 解释）。
 *
 * "2026-01-01 12:00:00" / "2026-01-01T12:00:00" / 带 Z 或 ±HH:MM 的都接受。
 * 带时区后缀的按后缀解析；不带的一律当 UTC —— 因为 DB 里存的就是 UTC。
 * 解析不出来返回 null（调用方决定怎么处理，别静默当成"没过期"）。
 */
export function parseSqlDateTime(input: any): Date | null {
  if (input === null || input === undefined || input === '') return null
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input

  const s = String(input).trim()
  // 已经有时区信息（Z 或 ±HH:MM）就交给 Date 自己解析
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)
  const normalized = s.includes('T') ? s : s.replace(' ', 'T')
  const date = new Date(hasZone ? normalized : `${normalized}Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * 当前时刻 → SQL 时间字符串（UTC 墙钟）。
 *
 * **必须用 getUTC* 而不是 get***。用本地方法会在非 UTC 服务器上把本地时间
 * 当 UTC 存进去：服务器在 CST 时，nowSqlString() 产出的值比真实 UTC 快 8 小时，
 * 而 isExpired() 又按 UTC 解析它 —— 两者不同源，套餐过期时间会整体偏 8 小时。
 */
export function nowSqlString(): string {
  return dateToSqlString(new Date())
}

/** Date → SQL 时间字符串（UTC 墙钟） */
export function dateToSqlString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  )
}

/**
 * 套餐/账号是否已过期。
 *
 * expireAt 为空（NULL / '' / 解析失败）一律返回 false = 未过期 ——
 * 「没设过期时间」和「还没过期」在这个产品里是同一件事。
 */
export function isExpired(expireAt: any, now: Date = new Date()): boolean {
  const dt = parseSqlDateTime(expireAt)
  if (!dt) return false
  return now.getTime() >= dt.getTime()
}

export function formatToUTC8(dateString?: string): string {
  if (!dateString) return ''

  try {
    const d = new Date(dateString)
    // Use Intl to format in Asia/Shanghai timezone (UTC+8)
    return d.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch (e) {
    console.error('formatToUTC8 error:', e)
    return ''
  }
}
