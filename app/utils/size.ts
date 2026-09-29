/**
 * 容量「显示字符串 ↔ 字节数」互转，供用户管理页的输入框使用。
 *
 * 为什么不复用 format.ts 的 formatFileSize：那个是 log 法算单位，遇到
 * 0 会直接 Math.log(0) = -Infinity（虽然有 bytes === 0 的特判兜住），
 * 负数会算出 NaN，1023 字节会显示成 '1023 B' 而不是 '1023 B' 之外的一致行为。
 * 这里要的是「用户手输 1024 kb → 存 1048576 → 显示 1 MB」的闭环，所以单独一份。
 */

/** 把字节转成人类可读的字符串（B/KB/MB/GB/TB） */
export const formatBytes = (bytes: number): string => {
  if (!isFinite(bytes) || isNaN(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  let i = 0
  let val = bytes
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024
    i++
  }
  const display =
    val >= 100 ? Math.round(val) :
    val >= 10 ? Math.round(val * 10) / 10 :
    Math.round(val * 100) / 100
  return `${display} ${units[i]}`
}

/** 把字符串（可带单位）解析为字节数，支持：B/KB/MB/GB/TB、大小写、可省略 B */
export const parseBytes = (input: string | number): number => {
  if (typeof input === 'number') return Math.max(0, Math.round(input))
  if (!input) return 0
  let str = String(input).trim()
  if (!str) return 0

  // 处理中英文逗号、小写空格
  str = str.replace(/，/g, ',').replace(',', '.').replace(/\s+/g, ' ')
  const match = str.match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/)
  if (!match) return 0

  // slice(1) 才是两个捕获组（slice() 会把 match[0] 整个匹配串也算进来）
  // 默认值只是为了让 noUncheckedIndexedAccess 闭嘴
  const [numStr = '', unitStr = ''] = match.slice(1)
  let value = parseFloat(numStr)
  const unit = unitStr.toLowerCase()

  if (isNaN(value) || value < 0) value = 0

  let mult = 1
  if (!unit || unit === 'b') mult = 1
  else if (unit.startsWith('k')) mult = 1024
  else if (unit.startsWith('m')) mult = 1024 ** 2
  else if (unit.startsWith('g')) mult = 1024 ** 3
  else if (unit.startsWith('t')) mult = 1024 ** 4
  else mult = 1 // 未识别单位按字节处理

  const bytes = Math.round(value * mult)
  return bytes < 0 ? 0 : bytes
}
