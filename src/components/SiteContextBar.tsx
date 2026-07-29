import { ArrowLeft, ArrowRight, ChevronsDown, ChevronsUp, List, PanelLeft } from 'lucide-react'

export function SiteContextBar({
  focusMode, siteName, index, count, busy, onPrev, onNext, onToggleView, onExpand, onCollapse,
}: {
  focusMode: boolean
  siteName: string
  index: number
  count: number
  busy: boolean
  onPrev?: () => void
  onNext?: () => void
  onToggleView: () => void
  onExpand: () => void
  onCollapse: () => void
}) {
  return <nav
    className="site-context-bar"
    aria-label={focusMode ? '单站查看操作' : '全部站点操作'}
    aria-busy={busy}
  >
    <div className="context-heading">
      {focusMode ? <PanelLeft size={18} /> : <List size={18} />}
      <span>
        <small>{focusMode ? '单站查看' : '全部站点'}</small>
        <strong><b>{siteName || '当前站点'}</b><em>{index + 1} / {count}</em></strong>
      </span>
    </div>
    <div className="context-actions">
      {focusMode && <>
        <button type="button" className="button compact" title="上一站" disabled={!onPrev} onClick={onPrev}><ArrowLeft size={15} />上一站</button>
        <button type="button" className="button compact" title="下一站" disabled={!onNext} onClick={onNext}>下一站<ArrowRight size={15} /></button>
        <span className="context-separator" />
      </>}
      <button type="button" className="button compact" onClick={onToggleView}>
        {focusMode ? <><List size={15} />返回全部站点</> : <><PanelLeft size={15} />单站查看</>}
      </button>
      <button type="button" className="button compact" disabled={busy} onClick={onExpand}>
        <ChevronsDown size={16} />{focusMode ? '展开本站' : '展开所有站点'}
      </button>
      <button type="button" className="button compact" disabled={busy} onClick={onCollapse}>
        <ChevronsUp size={16} />{focusMode ? '收起本站' : '收起所有站点'}
      </button>
    </div>
  </nav>
}
