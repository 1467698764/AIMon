import type { RefObject } from 'react'
import {
  ArrowLeft, ArrowRight, ArrowUpDown, ChevronsDown, ChevronsUp, List, PanelLeft, Search, X,
} from 'lucide-react'
import { sortModes, statusLabels, statusOrder, type SortMode, type StatusFilter } from '../lib/health'

/**
 * One sticky toolbar for everything that acts on the site list: search, status filter,
 * sort, and the view / expansion controls. These used to be two stacked bands, which
 * read as two competing toolbars and pushed the first site panel below the fold.
 */
export function Workbench({
  barRef, query, onQuery, pending, inputRef, statusFilter, onStatusFilter, counts,
  sortMode, onSortMode, result,
  focusMode, siteName, index, count, busy, onPrev, onNext, onToggleView, onExpand, onCollapse,
}: {
  barRef: RefObject<HTMLElement | null>
  query: string
  onQuery: (value: string) => void
  pending: boolean
  inputRef: RefObject<HTMLInputElement | null>
  statusFilter: StatusFilter
  onStatusFilter: (value: StatusFilter) => void
  counts: Record<StatusFilter, number>
  sortMode: SortMode
  onSortMode: (value: SortMode) => void
  result: string
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
  return <section className="workbench" ref={barRef} aria-label="监控视图工具条" aria-busy={busy}>
    <div className="workbench-row">
      <label className={`search-box ${pending ? 'pending' : ''}`}>
        <Search size={16} />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="搜索站点、分组或模型"
          aria-label="搜索站点、分组或模型"
        />
        {query
          ? <button type="button" title="清空搜索" aria-label="清空搜索" onClick={() => onQuery('')}><X size={14} /></button>
          : <kbd>/</kbd>}
      </label>
      <div className="segmented" role="group" aria-label="模型状态筛选">
        {(['all', ...statusOrder] as StatusFilter[]).map((value) => <button
          type="button"
          key={value}
          aria-pressed={statusFilter === value}
          className={statusFilter === value ? 'active' : ''}
          onClick={() => onStatusFilter(value)}
        ><span>{value === 'all' ? '全部' : statusLabels[value]}</span><b>{counts[value]}</b></button>)}
      </div>
      <span className="workbench-spacer" />
      {result && <span className="workbench-result">{result}</span>}
    </div>
    <div className="workbench-row workbench-view">
      {count > 0 && <div className="workbench-scope">
        {focusMode ? <PanelLeft size={17} /> : <List size={17} />}
        <span>
          <small>{focusMode ? '单站查看' : '全部站点'}</small>
          <strong><b>{siteName || '当前站点'}</b><em>{index + 1} / {count}</em></strong>
        </span>
      </div>}
      {count > 0 && focusMode && <div className="workbench-steps">
        <button type="button" className="button compact" title="上一站" disabled={!onPrev} onClick={onPrev}>
          <ArrowLeft size={15} />上一站
        </button>
        <button type="button" className="button compact" title="下一站" disabled={!onNext} onClick={onNext}>
          下一站<ArrowRight size={15} />
        </button>
      </div>}
      <span className="workbench-spacer" />
      <label className="sort-select" title="选择排序方式">
        <ArrowUpDown size={15} />
        <span className="visually-hidden">排序方式</span>
        <select value={sortMode} onChange={(event) => onSortMode(event.target.value as SortMode)}>
          {sortModes.map((mode) => <option value={mode.value} key={mode.value}>{mode.label}</option>)}
        </select>
      </label>
      {count > 0 && <div className="workbench-actions">
        <button type="button" className="button compact" onClick={onToggleView}>
          {focusMode ? <><List size={15} />全部站点</> : <><PanelLeft size={15} />单站查看</>}
        </button>
        <button type="button" className="button compact" disabled={busy} onClick={onExpand}>
          <ChevronsDown size={16} />{focusMode ? '展开本站' : '全部展开'}
        </button>
        <button type="button" className="button compact" disabled={busy} onClick={onCollapse}>
          <ChevronsUp size={16} />{focusMode ? '收起本站' : '全部收起'}
        </button>
      </div>}
    </div>
  </section>
}
