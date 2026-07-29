import type { RefObject } from 'react'
import { ArrowUpDown, Search, X } from 'lucide-react'
import { sortModes, statusLabels, statusOrder, type SortMode, type StatusFilter } from '../lib/health'

export function FilterBar({
  query, onQuery, pending, inputRef, statusFilter, onStatusFilter, counts, sortMode, onSortMode, result,
}: {
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
}) {
  return <section className="filter-bar">
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
    <span className="filter-spacer" />
    {result && <span className="filter-result">{result}</span>}
    <label className="sort-select" title="选择排序方式">
      <ArrowUpDown size={15} />
      <span className="visually-hidden">排序方式</span>
      <select value={sortMode} onChange={(event) => onSortMode(event.target.value as SortMode)}>
        {sortModes.map((mode) => <option value={mode.value} key={mode.value}>{mode.label}</option>)}
      </select>
    </label>
  </section>
}
