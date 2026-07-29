import type { SiteViewMode } from './prefs'

export function resolveSiteView(siteCount: number, preference: SiteViewMode | null): SiteViewMode {
  return preference || (siteCount > 6 ? 'focus' : 'all')
}

let manualGroupSequence = 0

export function createManualGroupClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  manualGroupSequence += 1
  return `manual-group-${Date.now().toString(36)}-${manualGroupSequence.toString(36)}`
}

export function comparableBaseUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    parsed.hash = ''
    parsed.search = ''
    parsed.pathname = parsed.pathname.replace(/\/(api\/)?v1\/?$/i, '').replace(/\/+$/, '')
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return trimmed.replace(/\/+$/, '').toLowerCase()
  }
}

export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch { /* Fall through to the legacy path below. */ }
  try {
    const area = document.createElement('textarea')
    area.value = value
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}
