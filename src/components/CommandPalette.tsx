import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CornerDownLeft, Search } from 'lucide-react'

export type PaletteAction = {
  id: string
  section: string
  label: string
  hint?: string
  icon?: ReactNode
  run: () => void
}

export function CommandPalette({ actions, onClose }: { actions: PaletteAction[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(typeof document === 'undefined' ? null : document.activeElement as HTMLElement)

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return actions
    return actions.filter((action) => `${action.label} ${action.section} ${action.hint || ''}`.toLowerCase().includes(needle))
  }, [actions, query])

  useEffect(() => setCursor(0), [query])
  useEffect(() => () => restoreRef.current?.focus?.(), [])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.palette-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [cursor, matches.length])

  function commit(action: PaletteAction | undefined) {
    if (!action) return
    onClose()
    action.run()
  }

  let lastSection = ''
  return <div
    className="palette-backdrop"
    role="presentation"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
  >
    <div
      className="palette"
      role="dialog"
      aria-modal="true"
      aria-label="命令面板"
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
        if (event.key === 'ArrowDown') { event.preventDefault(); setCursor((current) => matches.length ? (current + 1) % matches.length : 0); return }
        if (event.key === 'ArrowUp') { event.preventDefault(); setCursor((current) => matches.length ? (current - 1 + matches.length) % matches.length : 0); return }
        if (event.key === 'Enter') { event.preventDefault(); commit(matches[cursor]) }
      }}
    >
      <div className="palette-search">
        <Search size={17} />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索命令、站点与视图"
          aria-label="搜索命令"
        />
      </div>
      <div className="palette-list" ref={listRef}>
        {matches.map((action, index) => {
          const heading = action.section !== lastSection ? action.section : ''
          lastSection = action.section
          return <div key={action.id}>
            {heading && <div className="palette-section">{heading}</div>}
            <button
              type="button"
              className={`palette-item ${index === cursor ? 'active' : ''}`}
              onMouseEnter={() => setCursor(index)}
              onClick={() => commit(action)}
            >
              {action.icon}
              <span>{action.label}</span>
              {action.hint && <small>{action.hint}</small>}
            </button>
          </div>
        })}
        {!matches.length && <div className="palette-empty">没有匹配的命令</div>}
      </div>
      <div className="palette-hint">
        <span><kbd>↑</kbd><kbd>↓</kbd>选择</span>
        <span><kbd><CornerDownLeft size={11} /></kbd>执行</span>
        <span><kbd>Esc</kbd>关闭</span>
      </div>
    </div>
  </div>
}
