import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown, ChevronRight, ExternalLink, GripVertical,
  LoaderCircle, MessageSquareText, MoveDown, MoveUp, Pencil, RefreshCw, Server, Trash2,
} from 'lucide-react'
import { api } from '../api'
import type { GroupItem, HealthJobTarget, SiteItem } from '../types'
import { errorMessage, fmtCurrency, fmtTime } from '../lib/format'
import { matchesModel, sortGroups, type HealthScope, type SortMode, type StatusFilter } from '../lib/health'
import { HealthBreakdown, IconButton } from './primitives'
import { ModelGrid } from './ModelGrid'

export type DragState = { kind: 'site' | 'group'; id: number } | null

export function SitePanel({
  site, sortMode, query, statusFilter, activeModelIds, siteDragEnabled, focusedView, expansionCommand,
  onEdit, onDelete, deleting, onHealth, onCustomHealth, isHealthActive, activeTargetFor, onChanged, onError, onNotice,
  onMoveSite, siteIndex, siteCount, dragging, setDragging,
}: {
  site: SiteItem
  sortMode: SortMode
  query: string
  statusFilter: StatusFilter
  activeModelIds: ReadonlySet<number>
  siteDragEnabled: boolean
  focusedView: boolean
  expansionCommand?: { revision: number; expanded: boolean }
  onEdit: () => void
  onDelete: () => void
  deleting: boolean
  onHealth: (scope: HealthScope) => void
  onCustomHealth: (scope: HealthScope, label: string, hint: string) => void
  isHealthActive: (scope: HealthScope) => boolean
  activeTargetFor: (modelId: number) => HealthJobTarget | undefined
  onChanged: () => void
  onError: (message: string) => void
  onNotice: (message: string) => void
  onMoveSite: (delta: number) => void
  siteIndex: number
  siteCount: number
  dragging: DragState
  setDragging: (value: DragState) => void
}) {
  const [localGroups, setLocalGroups] = useState(() => focusedView
    ? site.groups.map((group) => ({ ...group, expanded: true }))
    : site.groups)
  const [siteExpanded, setSiteExpanded] = useState(focusedView || site.expanded)
  const groupMutationRef = useRef(false)
  const siteToggleRef = useRef(false)
  const siteExpandedOverrideRef = useRef<boolean | null>(null)
  const groupToggleRef = useRef(new Set<number>())
  const groupExpandedOverridesRef = useRef(new Map<number, boolean>())

  useEffect(() => {
    if (groupMutationRef.current) return
    setLocalGroups((current) => site.groups.map((group) => {
      const desired = groupExpandedOverridesRef.current.get(group.id)
      if (desired == null) {
        const local = current.find((item) => item.id === group.id)
        return focusedView ? { ...group, expanded: local?.expanded ?? true } : group
      }
      if (group.expanded === desired) {
        groupExpandedOverridesRef.current.delete(group.id)
        return group
      }
      return { ...group, expanded: desired }
    }))
  }, [site.groups])

  useEffect(() => {
    const desired = siteExpandedOverrideRef.current
    if (desired == null) {
      if (!focusedView || site.expanded) setSiteExpanded(site.expanded)
      return
    }
    if (site.expanded === desired) {
      siteExpandedOverrideRef.current = null
      setSiteExpanded(site.expanded)
    }
  }, [site.id, site.expanded])

  useEffect(() => {
    if (!expansionCommand) {
      siteExpandedOverrideRef.current = null
      groupExpandedOverridesRef.current.clear()
      setSiteExpanded(focusedView || site.expanded)
      setLocalGroups(focusedView ? site.groups.map((group) => ({ ...group, expanded: true })) : site.groups)
      return
    }
    siteExpandedOverrideRef.current = expansionCommand.expanded
    for (const group of site.groups) groupExpandedOverridesRef.current.set(group.id, expansionCommand.expanded)
    setSiteExpanded(expansionCommand.expanded)
    setLocalGroups((current) => current.map((group) => ({ ...group, expanded: expansionCommand.expanded })))
  }, [expansionCommand?.revision])

  const manualOrder = sortMode === 'manual'
  const normalizedQuery = query.trim().toLowerCase()
  const filtering = Boolean(normalizedQuery || statusFilter !== 'all')
  const reorderable = manualOrder && !filtering
  const siteMatches = !normalizedQuery || `${site.name} ${site.baseUrl} ${site.apiBaseUrl}`.toLowerCase().includes(normalizedQuery)
  const groups = sortGroups(localGroups, sortMode).map((group): GroupItem | null => {
    const groupMatches = siteMatches || group.name.toLowerCase().includes(normalizedQuery)
    const models = group.models.filter((model) =>
      matchesModel(model, statusFilter, activeModelIds) && (groupMatches || model.name.toLowerCase().includes(normalizedQuery)))
    if (filtering && !models.length && !(statusFilter === 'all' && groupMatches)) return null
    return { ...group, models }
  }).filter((group): group is GroupItem => group !== null)
  const siteModels = localGroups.flatMap((group) => group.models)
  const modelCount = site.groups.reduce((sum, group) => sum + group.models.length, 0)

  async function toggleSite() {
    if (siteToggleRef.current) return
    siteToggleRef.current = true
    const next = !siteExpanded
    siteExpandedOverrideRef.current = next
    setSiteExpanded(next)
    try {
      await api.expanded('site', site.id, next)
      setSiteExpanded(next)
    } catch (error) {
      siteExpandedOverrideRef.current = null
      setSiteExpanded(!next)
      onError(errorMessage(error))
    } finally {
      siteToggleRef.current = false
    }
  }

  async function toggleGroup(group: GroupItem) {
    if (groupToggleRef.current.has(group.id)) return
    groupToggleRef.current.add(group.id)
    const next = !group.expanded
    groupExpandedOverridesRef.current.set(group.id, next)
    setLocalGroups((current) => current.map((item) => item.id === group.id ? { ...item, expanded: next } : item))
    try {
      await api.expanded('group', group.id, next)
      setLocalGroups((current) => current.map((item) => item.id === group.id ? { ...item, expanded: next } : item))
    } catch (error) {
      groupExpandedOverridesRef.current.delete(group.id)
      setLocalGroups((current) => current.map((item) => item.id === group.id ? { ...item, expanded: !next } : item))
      onError(errorMessage(error))
    } finally {
      groupToggleRef.current.delete(group.id)
    }
  }
  async function dropGroup(targetId: number) {
    if (!reorderable || groupMutationRef.current || dragging?.kind !== 'group' || dragging.id === targetId) return
    const from = localGroups.findIndex((group) => group.id === dragging.id)
    const to = localGroups.findIndex((group) => group.id === targetId)
    if (from < 0 || to < 0) return
    const previous = localGroups
    const next = [...localGroups]
    next.splice(to, 0, next.splice(from, 1)[0])
    setLocalGroups(next)
    setDragging(null)
    groupMutationRef.current = true
    try {
      await api.reorder('group', next.map((group) => group.id))
      onChanged()
    } catch (error) {
      setLocalGroups(previous)
      onError(errorMessage(error))
    } finally {
      groupMutationRef.current = false
    }
  }

  async function moveGroup(index: number, delta: number) {
    if (!reorderable || groupMutationRef.current) return
    const target = index + delta
    if (target < 0 || target >= localGroups.length) return
    const previous = localGroups
    const next = [...localGroups]
    ;[next[index], next[target]] = [next[target], next[index]]
    setLocalGroups(next)
    groupMutationRef.current = true
    try {
      await api.reorder('group', next.map((group) => group.id))
      onChanged()
    } catch (error) {
      setLocalGroups(previous)
      onError(errorMessage(error))
    } finally {
      groupMutationRef.current = false
    }
  }

  const siteChecking = isHealthActive({ siteId: site.id })
  const canDragSite = siteDragEnabled && reorderable
  const reorderHint = !manualOrder ? '切换到手动排序后可调整顺序' : filtering ? '筛选时无法排序' : '拖动排序'

  return <article className="site-panel">
    <header className="site-panel-header">
      <div className="site-reorder">
        <button
          className="drag-handle"
          title={!siteDragEnabled ? '切换到全部视图后可拖动排序' : reorderHint}
          draggable={canDragSite}
          disabled={!canDragSite}
          onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; setDragging({ kind: 'site', id: site.id }) }}
          onDragEnd={() => setDragging(null)}
        ><GripVertical size={18} /></button>
        <button
          className="collapse"
          aria-expanded={siteExpanded}
          title={siteExpanded ? '收起站点' : '展开站点'}
          onClick={() => void toggleSite()}
        >{siteExpanded ? <ChevronDown size={19} /> : <ChevronRight size={19} />}</button>
      </div>
      <div className="site-identity">
        <div className="site-mark"><Server size={19} /></div>
        <div>
          <div className="site-name-line">
            <h2 title={site.name}>{site.name}</h2>
            <span className={`platform ${site.connectionMode === 'manual' ? 'manual' : site.type}`}>
              {site.connectionMode === 'manual' ? '手动接入' : site.type === 'newapi' ? 'New API' : 'Sub2API'}
            </span>
          </div>
          <span className="site-link">
            <a href={site.baseUrl} target="_blank" rel="noreferrer" title={site.baseUrl}>{site.baseUrl}</a>
            <ExternalLink size={12} />
            {site.apiBaseUrl && <a
              className="api-origin"
              href={site.apiBaseUrl}
              target="_blank"
              rel="noreferrer"
              title={`模型列表与测活使用 ${site.apiBaseUrl}`}
            >API {site.apiBaseUrl.replace(/^https?:\/\//, '')}</a>}
          </span>
        </div>
      </div>
      <div className="site-facts">
        <div><small>账户余额</small><strong>{site.balanceKnown ? fmtCurrency(site.balance, site.currency) : '--'}</strong></div>
        <div><small>监控范围</small><strong>{site.groups.length}<em> 组</em> / {modelCount}<em> 模型</em></strong></div>
        <div><small>健康分布</small><HealthBreakdown models={siteModels} activeModelIds={activeModelIds} /></div>
        <div><small>最近测活</small><span>{fmtTime(site.lastCheckAt)}</span></div>
      </div>
      <div className="site-actions">
        <span className="mobile-order">
          <IconButton title="站点上移" disabled={!reorderable || siteIndex === 0} onClick={() => onMoveSite(-1)}><MoveUp size={15} /></IconButton>
          <IconButton title="站点下移" disabled={!reorderable || siteIndex === siteCount - 1} onClick={() => onMoveSite(1)}><MoveDown size={15} /></IconButton>
        </span>
        <button
          type="button"
          className="button compact accent site-health-button"
          title={siteChecking ? '此站点正在测活' : '测活此站点'}
          disabled={siteChecking}
          onClick={() => onHealth({ siteId: site.id })}
        ><RefreshCw className={siteChecking ? 'spin' : ''} size={15} /><span>{siteChecking ? '测活中' : '测活'}</span></button>
        <IconButton
          title="用自定义问题测活此站点"
          disabled={siteChecking}
          onClick={() => onCustomHealth({ siteId: site.id }, site.name, `“${site.name}”的所有模型`)}
        ><MessageSquareText size={16} /></IconButton>
        <IconButton title="编辑站点" disabled={deleting} onClick={onEdit}><Pencil size={16} /></IconButton>
        <IconButton
          title={siteChecking ? '测活完成后可删除站点' : deleting ? '正在删除站点' : '删除站点'}
          disabled={siteChecking || deleting}
          tone="danger"
          onClick={onDelete}
        >{deleting ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}</IconButton>
      </div>
    </header>
    {siteExpanded && <div className="group-stack">
      {groups.map((group, groupIndex) => {
        const groupChecking = isHealthActive({ groupId: group.id })
        return <section
          className="group"
          key={group.id}
          onDragOver={(event) => { if (reorderable) event.preventDefault() }}
          onDrop={() => void dropGroup(group.id)}
        >
          <header className="group-header">
            <div className="group-leading">
              <button
                className="drag-handle"
                title={reorderHint}
                draggable={reorderable}
                disabled={!reorderable}
                onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.effectAllowed = 'move'; setDragging({ kind: 'group', id: group.id }) }}
                onDragEnd={() => setDragging(null)}
              ><GripVertical size={16} /></button>
              <button
                className="collapse"
                aria-expanded={group.expanded}
                title={group.expanded ? '收起分组' : '展开分组'}
                onClick={() => void toggleGroup(group)}
              >{group.expanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</button>
              <div className="group-title">
                <span className="level-tag">分组</span>
                <h3 title={group.name}>{group.name}</h3>
                {group.platform && <span title={group.platform}>{group.platform}</span>}
              </div>
            </div>
            <div className="group-meta">
              <span>分组倍率 <b>{group.ratioDynamic ? '自动' : `x${group.ratio}`}</b></span>
              <span>标准倍率 <b className="standard-ratio">{group.standardRatio == null ? '--' : `x${group.standardRatio.toFixed(3)}`}</b></span>
              <span>{group.models.length} 个模型</span>
              <HealthBreakdown models={group.models} activeModelIds={activeModelIds} />
            </div>
            <div className="group-actions">
              <span className="mobile-order">
                <IconButton title="分组上移" disabled={!reorderable || groupIndex === 0} onClick={() => void moveGroup(groupIndex, -1)}><MoveUp size={14} /></IconButton>
                <IconButton title="分组下移" disabled={!reorderable || groupIndex === groups.length - 1} onClick={() => void moveGroup(groupIndex, 1)}><MoveDown size={14} /></IconButton>
              </span>
              <button
                type="button"
                className="button compact accent"
                title={groupChecking ? '此分组正在测活' : '测活此分组'}
                disabled={groupChecking}
                onClick={() => onHealth({ groupId: group.id })}
              ><RefreshCw className={groupChecking ? 'spin' : ''} size={15} /><span>{groupChecking ? '测活中' : '测活分组'}</span></button>
              <IconButton
                title="用自定义问题测活此分组"
                disabled={groupChecking}
                onClick={() => onCustomHealth({ groupId: group.id }, `${site.name} / ${group.name}`, `“${group.name}”分组的所有模型`)}
              ><MessageSquareText size={15} /></IconButton>
            </div>
          </header>
          {group.expanded && <ModelGrid
            group={group}
            sortMode={sortMode}
            onHealth={onHealth}
            onCustomHealth={(scope, modelName) => onCustomHealth(scope, `${group.name} / ${modelName}`, `模型“${modelName}”`)}
            activeTargetFor={activeTargetFor}
            onNotice={onNotice}
          />}
        </section>
      })}
      {!groups.length && <div className="empty-inline">尚未选择分组，编辑站点以完成配置。</div>}
    </div>}
  </article>
}
