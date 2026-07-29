import type { RefObject } from 'react'
import { Search, X } from 'lucide-react'
import type { SiteItem } from '../types'
import { aggregateTone, statusCounts } from '../lib/health'
import { hostOf } from '../lib/format'
import { HealthBreakdown } from './primitives'

export function SiteDirectory({
  sites, matches, focusedSiteId, focusedIndex, activeSiteIds, activeModelIds, query, onQuery, onSelect, listRef, focusMode,
}: {
  sites: SiteItem[]
  matches: SiteItem[]
  focusedSiteId?: number
  focusedIndex: number
  activeSiteIds: ReadonlySet<number>
  activeModelIds: ReadonlySet<number>
  query: string
  onQuery: (value: string) => void
  onSelect: (siteId: number) => void
  listRef: RefObject<HTMLElement | null>
  focusMode: boolean
}) {
  return <aside className="site-directory" aria-label="站点快速导航">
    <header>
      <div><small>{focusMode ? '单站查看' : '全部站点'}</small><strong>站点目录</strong></div>
      <span className="directory-count">{focusedIndex + 1} / {sites.length}</span>
    </header>
    <label className="search-box">
      <Search size={14} />
      <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="筛选站点名称或地址" aria-label="筛选站点目录" />
      {query && <button type="button" title="清空站点筛选" aria-label="清空站点筛选" onClick={() => onQuery('')}><X size={13} /></button>}
    </label>
    <nav className="site-directory-list" ref={listRef as RefObject<HTMLElement>} aria-label="选择站点">
      {matches.map((site) => {
        const models = site.groups.flatMap((group) => group.models)
        const tone = aggregateTone(statusCounts(models, activeModelIds), activeSiteIds.has(site.id))
        const active = site.id === focusedSiteId
        return <button
          type="button"
          key={site.id}
          className={active ? 'active' : ''}
          aria-current={active ? 'true' : undefined}
          title={`${site.name}\n${site.baseUrl}`}
          onClick={() => onSelect(site.id)}
        >
          <i className={`directory-dot ${tone}`} />
          <span className="directory-label">
            <strong>{site.name}</strong>
            <small>{hostOf(site.baseUrl)} · {site.groups.length} 组 · {models.length} 模型</small>
          </span>
          <HealthBreakdown models={models} activeModelIds={activeModelIds} />
        </button>
      })}
      {!matches.length && <div className="site-directory-empty">目录中没有匹配的站点</div>}
    </nav>
  </aside>
}
