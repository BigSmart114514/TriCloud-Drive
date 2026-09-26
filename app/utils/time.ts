export type TimeValue = string | number | Date | null | undefined

const DEFAULT_TIME_ZONE = '+8'

const configuredTimeZone = () => {
  try {
    const config = useRuntimeConfig()
    return String((config.public as { TimeZone?: string })?.TimeZone || DEFAULT_TIME_ZONE)
  } catch {
    return DEFAULT_TIME_ZONE
  }
}

const parseOffset = (value: string): number | null => {
  const normalized = value.trim().replace(/^(?:UTC|GMT)/i, '').trim()
  const match = normalized.match(/^([+-])?(\d{1,2})(?::?(\d{2}))?$/)
  if (!match) return null
  const hours = Number(match[2])
  const minutes = Number(match[3] || 0)
  if (hours > 23 || minutes > 59) return null
  const sign = match[1] === '-' ? -1 : 1
  return sign * (hours * 60 + minutes)
}

const hasTimeZone = (value: string) => /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())

export const parseTimeValue = (value: TimeValue): Date | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  if (typeof value !== 'string' || !value.trim()) return null

  const trimmed = value.trim()
  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T')
  const date = new Date(hasTimeZone(normalized) ? normalized : `${normalized}Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

export const formatDateTime = (value: TimeValue, timeZone = configuredTimeZone()): string => {
  const date = parseTimeValue(value)
  if (!date) return typeof value === 'string' ? value : ''

  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }
  const offset = parseOffset(timeZone)
  if (offset !== null) {
    const shifted = new Date(date.getTime() + offset * 60 * 1000)
    return new Intl.DateTimeFormat('zh-CN', { ...options, timeZone: 'UTC' }).format(shifted)
  }

  try {
    return new Intl.DateTimeFormat('zh-CN', { ...options, timeZone }).format(date)
  } catch {
    const fallback = new Date(date.getTime() + 8 * 60 * 60 * 1000)
    return new Intl.DateTimeFormat('zh-CN', { ...options, timeZone: 'UTC' }).format(fallback)
  }
}

export const formatTimeZone = () => configuredTimeZone()
