export type ThemeChoice = 'auto' | 'light' | 'dark'
export type Density = 'comfortable' | 'compact'
export type SiteViewMode = 'focus' | 'all'

const keys = {
  theme: 'aimon-theme',
  density: 'aimon-density',
  siteView: 'aimon-site-view',
  focusedSite: 'aimon-focused-site',
  sort: 'aimon-sort',
} as const

function read(key: string): string | null {
  if (typeof window === 'undefined') return null
  try { return window.localStorage.getItem(key) } catch { return null }
}

function write(key: string, value: string): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(key, value) } catch { /* Preferences are best-effort only. */ }
}

export const prefs = {
  theme(): ThemeChoice {
    const stored = read(keys.theme)
    return stored === 'light' || stored === 'dark' || stored === 'auto' ? stored : 'auto'
  },
  setTheme(value: ThemeChoice) { write(keys.theme, value) },
  density(): Density {
    return read(keys.density) === 'compact' ? 'compact' : 'comfortable'
  },
  setDensity(value: Density) { write(keys.density, value) },
  siteView(): SiteViewMode | null {
    const stored = read(keys.siteView)
    return stored === 'focus' || stored === 'all' ? stored : null
  },
  setSiteView(value: SiteViewMode) { write(keys.siteView, value) },
  focusedSite(): number | null {
    const stored = Number(read(keys.focusedSite))
    return Number.isInteger(stored) && stored > 0 ? stored : null
  },
  setFocusedSite(value: number) { write(keys.focusedSite, String(value)) },
  sort(): string | null { return read(keys.sort) },
  setSort(value: string) { write(keys.sort, value) },
}

const themeColors: Record<'light' | 'dark', string> = { light: '#eef1f6', dark: '#0b0f17' }

export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice === 'auto') return systemPrefersDark() ? 'dark' : 'light'
  return choice
}

export function applyDensity(density: Density): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.density = density
}

/** Keeps the document, the native form controls and the browser chrome in sync. */
export function applyTheme(choice: ThemeChoice): 'light' | 'dark' {
  const resolved = resolveTheme(choice)
  if (typeof document === 'undefined') return resolved
  const root = document.documentElement
  root.dataset.theme = resolved
  root.dataset.themeChoice = choice
  root.style.colorScheme = resolved
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta) meta.content = themeColors[resolved]
  return resolved
}
