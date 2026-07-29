const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
})

const clockFormatter = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

export function fmtMs(value: number | null): string {
  if (value == null) return '--'
  if (value < 1000) return `${Math.round(value)}ms`
  const precision = Number.isInteger(value / 10) ? 2 : 3
  return `${(value / 1000).toFixed(precision)}s`
}

export function fmtTime(value: string | null): string {
  if (!value) return '尚未测活'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '时间未知'
  return timeFormatter.format(date)
}

export function fmtClock(value: number | string): string {
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  if (!Number.isFinite(date.getTime())) return '--'
  return clockFormatter.format(date)
}

/** Coarse relative label for "how stale is this reading" hints. */
export function fmtAge(value: string | null, now = Date.now()): string {
  if (!value) return '尚未测活'
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return '时间未知'
  const seconds = Math.max(0, Math.round((now - time) / 1000))
  if (seconds < 45) return '刚刚'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

export function fmtCurrency(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value)
  } catch {
    return `${currency || '$'} ${value.toFixed(2)}`
  }
}

export function fmtRatio(value: number | null): string {
  if (value == null) return '--'
  const rounded = Number(value.toFixed(3))
  return `x${rounded}`
}

export function hostOf(url: string): string {
  return url.replace(/^https?:\/\//i, '').split('/')[0] || url
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
