import { Activity, Command, LogOut, Moon, RefreshCw, Rows3, Search, Settings as SettingsIcon, Sun, SunMoon } from 'lucide-react'
import type { Density, ThemeChoice } from '../lib/prefs'
import { IconButton } from './primitives'

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent)

const themeIcons: Record<ThemeChoice, typeof Sun> = { auto: SunMoon, light: Sun, dark: Moon }
const themeLabels: Record<ThemeChoice, string> = { auto: '跟随系统', light: '浅色', dark: '深色' }

export function AppHeader({
  runtimeLabel, runtimeTone, runtimeTitle, refreshing, onRefresh, theme, onTheme, density, onDensity,
  onPalette, onShortcuts, onSettings, onSignOut,
}: {
  runtimeLabel: string
  runtimeTone: 'ready' | 'busy' | 'error'
  runtimeTitle: string
  refreshing: boolean
  onRefresh: () => void
  theme: ThemeChoice
  onTheme: () => void
  density: Density
  onDensity: () => void
  onPalette: () => void
  onShortcuts: () => void
  onSettings: () => void
  onSignOut: () => void
}) {
  const ThemeIcon = themeIcons[theme]
  return <header className="app-header">
    <div className="brand">
      <div className="logo-mark"><Activity size={19} /></div>
      <div><strong>AIMon</strong><span>AI RELAY MONITOR</span></div>
    </div>
    <div className={`runtime-state ${runtimeTone === 'error' ? 'offline' : runtimeTone === 'busy' ? 'busy' : ''}`} title={runtimeTitle}>
      <i /><span className="runtime-label">{runtimeLabel}</span>
    </div>
    <div className="header-actions">
      <button type="button" className="header-search" onClick={onPalette} title="打开命令面板">
        <Search size={15} />搜索与命令
        <kbd>{isMac ? '⌘' : 'Ctrl'}</kbd><kbd>K</kbd>
      </button>
      <span className="header-divider" />
      <IconButton title="刷新监控数据" className="quiet" disabled={refreshing} onClick={onRefresh}>
        <RefreshCw className={refreshing ? 'spin' : ''} size={17} />
      </IconButton>
      <IconButton title={`主题：${themeLabels[theme]}（点击切换）`} className="quiet" onClick={onTheme}><ThemeIcon size={17} /></IconButton>
      <IconButton
        title={density === 'compact' ? '切换为舒适布局' : '切换为紧凑布局'}
        className="quiet"
        pressed={density === 'compact'}
        onClick={onDensity}
      ><Rows3 size={17} /></IconButton>
      <IconButton title="键盘快捷键" className="quiet hide-narrow" onClick={onShortcuts}><Command size={17} /></IconButton>
      <span className="header-divider hide-narrow" />
      <IconButton title="默认配置" className="quiet" onClick={onSettings}><SettingsIcon size={17} /></IconButton>
      <IconButton title="退出登录" className="quiet" onClick={onSignOut}><LogOut size={17} /></IconButton>
    </div>
  </header>
}
