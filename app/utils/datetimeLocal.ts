/**
 * <input type="datetime-local"> 的值 ↔ 后端 SQL 格式互转。
 *
 * 两个格式必须严格区分，否则保存时会把时间存错：
 *   - 输入框要的是  "2026-01-01T00:00:00"（ISO 风格，带 T）
 *   - 后端/DB 要的是 "2026-01-01 00:00:00"（空格分隔）
 *
 * 别拿 utils/time.ts 的 formatDateTime 来填输入框：它输出的是 zh-CN 本地化
 * 字符串（"2026年1月1日 00:00"），datetime-local 认不出来，框里会显示为空。
 */

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 仅接受 YYYY-MM-DD HH:mm:ss（或中间用 T）的字符串，返回规范化字符串或 null（空/无效） */
export const parseExpireAt = (val: string | null): string | null => {
  if (!val) return null
  const s = String(val).trim()
  if (!s) return null

  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/)
  if (!m) return null

  // 正则保证 6 个捕获组都是数字。默认值只是为了让 noUncheckedIndexedAccess 闭嘴，
  // 走到这里说明正则已匹配成功，实际不会取到 undefined。
  const [y = 0, mo = 1, d = 1, h = 0, mi = 0, se = 0] = m.slice(1).map(Number)
  const date = new Date(y, mo - 1, d, h, mi, se)

  // 反校验，避免 2025-02-31 这种非法日期
  if (
    date.getFullYear() !== y ||
    date.getMonth() !== mo - 1 ||
    date.getDate() !== d ||
    date.getHours() !== h ||
    date.getMinutes() !== mi ||
    date.getSeconds() !== se
  ) {
    return null
  }

  return `${y}-${pad2(mo)}-${pad2(d)} ${pad2(h)}:${pad2(mi)}:${pad2(se)}`
}

/** "YYYY-MM-DD HH:mm:ss" / "YYYY-MM-DDTHH:mm:ss" -> "YYYY-MM-DDTHH:mm:ss"（给输入框） */
export const toDatetimeLocal = (val: string | null): string => {
  if (!val) return ''
  const normalized = parseExpireAt(String(val).trim())
  if (!normalized) return ''
  return normalized.replace(' ', 'T')
}

/** "YYYY-MM-DDTHH:mm[:ss]" -> "YYYY-MM-DD HH:mm:ss"（给后端）；空值返回 null = 不过期 */
export const fromDatetimeLocal = (val: string | null): string | null => {
  if (!val) return null
  const s = String(val).trim()
  if (!s) return null
  // 若无秒，补 ":00"
  const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) ? s + ':00' : s
  return parseExpireAt(withSeconds)
}
