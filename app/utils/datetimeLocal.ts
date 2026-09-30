/**
 * <input type="datetime-local"> 的值 ↔ 后端 SQL 格式互转。
 *
 * 两个格式必须严格区分，否则保存时会把时间存错：
 *   - 输入框要的是  "2026-01-01T00:00:00"（ISO 风格，带 T）
 *   - 后端/DB 要的是 "2026-01-01 00:00:00"（空格分隔，**UTC 墙钟**）
 *
 * 时区：DB 一律存 UTC，显示时按 runtimeConfig.public.TimeZone 偏移。
 * 所以两个方向的转换都过同一个偏移量：
 *   DB(UTC) → 输入框  要 +offset
 *   输入框(本地) → DB(UTC) 要 -offset
 *
 * 以前这里用 `new Date(y, mo-1, d, h, mi, se)` —— 那是**浏览器本地时区**，
 * 和 TimeZone 配置无关。在 UTC+8 的机器上恰好「看起来对」（服务器也是 +8），
 * 换个时区就整体偏 8 小时：DB 里 2026-01-01 00:00Z 会显示成 00:00 而不是 08:00。
 * 反向更隐蔽：fromDatetimeLocal 把用户输入当本地时间理解，用户想设
 * 「北京时间明天 9 点」，在 UTC 时区存进去就变成了 UTC 的 9 点 = 北京 17 点。
 *
 * 别拿 utils/time.ts 的 formatDateTime 来填输入框：它输出的是 zh-CN 本地化
 * 字符串（"2026年1月1日 00:00"），datetime-local 认不出来，框里会显示为空。
 * 但**偏移量的解析**复用那边（parseOffset / configuredTimeZone），不重复实现。
 */

import { formatTimeZone, parseTimeValue } from '~/utils/time'

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 把 Date 的 UTC 字段格式化成 "YYYY-MM-DD HH:mm:ss"（不做任何本地化） */
const formatUtcParts = (date: Date): string =>
  `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ` +
  `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`

/**
 * TimeZone 配置 → 偏移分钟数。
 *
 * 优先按 "+8" / "-05:30" 这类固定偏移解析（复用 utils/time 的规则）；
 * 解析不出来（比如配了 IANA 名字）就按 UTC 处理。
 *
 * 为什么不走 Intl：Intl 只能格式化，不能反推某个本地墙钟对应的 UTC 时刻
 * （那需要 tzdata 和 DST 规则）。fixed-offset 是这套系统现有的能力范围，
 * runtimeConfig.TimeZone 本来默认就是 '+8'。
 */
const offsetMinutes = (): number => {
  const raw = formatTimeZone().trim().replace(/^(?:UTC|GMT)/i, '').trim()
  const m = raw.match(/^([+-])?(\d{1,2})(?::?(\d{2}))?$/)
  if (!m) return 0
  const hours = Number(m[2])
  const minutes = Number(m[3] || 0)
  if (hours > 23 || minutes > 59) return 0
  const sign = m[1] === '-' ? -1 : 1
  return sign * (hours * 60 + minutes)
}

/**
 * 纯格式校验与规范化，**不做时区转换**。
 * "2026-01-01 00:00" / "2026-01-01T00:00:00" → 规范化的空格分隔串。
 * 用于校验格式合法性（比如输入框的日期部分不能是 2025-02-31）。
 */
export const parseExpireAt = (val: string | null): string | null => {
  if (!val) return null
  const s = String(val).trim()
  if (!s) return null

  // 秒和毫秒都可选。<input type="datetime-local"> 的 step 决定用户能选到多细：
  // step="1" 给到秒、用户没碰秒时给 5 段 "T09:00"，step 含小数还会带上 ".123"。
  // 早先只认 6 段，5 段被判成非法 → 调用方（normalizeExpire）把用户刚填的值
  // 清空，表现是「改了时间没反应」。
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/)
  if (!m) return null

  const [y = 0, mo = 1, d = 1, h = 0, mi = 0, se = 0] = [m[1], m[2], m[3], m[4], m[5], m[6] || 0].map(Number)
  // 非法日期（2025-02-31 之类）。用 UTC 构造，反校验 UTC 字段 ——
  // 纯日历校验，不涉及任何时区。
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, se))
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d ||
    date.getUTCHours() !== h ||
    date.getUTCMinutes() !== mi ||
    date.getUTCSeconds() !== se
  ) {
    return null
  }

  return formatUtcParts(date)
}

/**
 * DB(UTC) → 输入框（按 TimeZone 偏移）。
 * "2026-01-01 00:00:00" 在 TimeZone=+8 下应显示成 "2026-01-01T08:00:00"。
 */
export const toDatetimeLocal = (val: string | null): string => {
  if (!val) return ''
  const s = String(val).trim()
  if (!s) return ''
  // parseTimeValue 对无时区的字符串补 Z，即按 UTC 解析 —— 与 DB 的存法一致
  const date = parseTimeValue(s)
  if (!date) return ''
  const shifted = new Date(date.getTime() + offsetMinutes() * 60 * 1000)
  return formatUtcParts(shifted).replace(' ', 'T')
}

/**
 * 输入框（本地墙钟）→ DB(UTC)。
 * "2026-01-01T08:00" 在 TimeZone=+8 下应存成 "2026-01-01 00:00:00"。
 * 空值返回 null = 不过期。
 */
export const fromDatetimeLocal = (val: string | null): string | null => {
  if (!val) return null
  const s = String(val).trim()
  if (!s) return null
  // 若无秒，补 ":00"
  const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) ? `${s}:00` : s
  // 先按字面量校验格式与日历合法性（parseExpireAt 是纯校验）
  if (!parseExpireAt(withSeconds)) return null
  // 把墙钟当 UTC 解析，再减掉偏移 = 得到真正的 UTC 时刻
  const asUtc = parseTimeValue(`${withSeconds.replace(' ', 'T')}Z`)
  if (!asUtc) return null
  return formatUtcParts(new Date(asUtc.getTime() - offsetMinutes() * 60 * 1000))
}
