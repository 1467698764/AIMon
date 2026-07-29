import type { GroupItem, HealthJob, HealthJobTarget, HealthStatus, ModelItem, SiteItem } from '../types'

export const statusLabels: Record<HealthStatus, string> = {
  excellent: '优质', available: '可用', failed: '失败', pending: '待测',
}

export const statusOrder: readonly HealthStatus[] = ['excellent', 'available', 'failed', 'pending']

export type StatusFilter = 'all' | HealthStatus
export type LatencyMetric = 'ttfb' | 'total' | 'ttft'
export type LatencyTone = 'good' | 'warning' | 'bad' | 'neutral'
export type HealthScope = { siteId?: number; groupId?: number; modelId?: number }

export const latencyThresholds: Record<LatencyMetric, readonly [number, number]> = {
  ttfb: [7_000, 15_000],
  total: [6_000, 20_000],
  ttft: [2_000, 6_000],
}

export const noActiveModelIds: ReadonlySet<number> = new Set()

export function latencyTone(metric: LatencyMetric, value: number | null): LatencyTone {
  if (value == null || !Number.isFinite(value)) return 'neutral'
  const [good, warning] = latencyThresholds[metric]
  if (value < good) return 'good'
  if (value < warning) return 'warning'
  return 'bad'
}

export function successTone(model: ModelItem): LatencyTone {
  if (model.successCount == null || model.attemptCount == null) return 'neutral'
  if (model.successCount >= model.attemptCount) return 'good'
  if (model.successCount >= Math.ceil(model.attemptCount * 2 / 3)) return 'warning'
  return 'bad'
}

export function effectiveModelStatus(model: ModelItem, activeModelIds: ReadonlySet<number> = noActiveModelIds): HealthStatus {
  return activeModelIds.has(model.id) ? 'pending' : model.status
}

export function statusCounts(models: ModelItem[], activeModelIds: ReadonlySet<number> = noActiveModelIds) {
  const counts = { excellent: 0, available: 0, failed: 0, pending: 0 }
  for (const model of models) counts[effectiveModelStatus(model, activeModelIds)] += 1
  return counts
}

export type StatusCounts = ReturnType<typeof statusCounts>

/** Worst-first tone used for directory dots and site badges. */
export function aggregateTone(counts: StatusCounts, checking: boolean): HealthStatus | 'checking' {
  if (checking) return 'checking'
  if (counts.failed) return 'failed'
  if (counts.available) return 'available'
  if (counts.excellent) return 'excellent'
  return 'pending'
}

export function healthKey(scope: HealthScope): string {
  if (scope.modelId) return `model:${scope.modelId}`
  if (scope.groupId) return `group:${scope.groupId}`
  if (scope.siteId) return `site:${scope.siteId}`
  return 'all'
}

export function summarizeHealthTargets(
  targets: readonly HealthJobTarget[],
  formatter: (target: HealthJobTarget) => string = (target) => target.label,
  limit = 3,
): string {
  const visible = targets.slice(0, Math.max(0, limit)).map(formatter)
  const remaining = targets.length - visible.length
  return `${visible.join('；')}${remaining > 0 ? `；另有 ${remaining} 个目标` : ''}`
}

export function summarizeRefreshingJobs(jobs: readonly HealthJob[]): string {
  const labels: string[] = []
  let total = 0
  for (const job of jobs) {
    total += job.targets?.length || 0
    if (labels.length < 3) {
      for (const target of job.targets || []) {
        labels.push(target.label)
        if (labels.length === 3) break
      }
    }
  }
  const remaining = total - labels.length
  return `${labels.join('；')}${remaining > 0 ? `；另有 ${remaining} 个目标` : ''}`
}

export function matchesModel(model: ModelItem, statusFilter: StatusFilter, activeModelIds: ReadonlySet<number> = noActiveModelIds): boolean {
  return statusFilter === 'all' || effectiveModelStatus(model, activeModelIds) === statusFilter
}

export function siteHasVisibleModels(
  site: SiteItem,
  query: string,
  statusFilter: StatusFilter,
  activeModelIds: ReadonlySet<number> = noActiveModelIds,
): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized && statusFilter === 'all') return true
  const siteMatches = !normalized || `${site.name} ${site.baseUrl}`.toLowerCase().includes(normalized)
  if (statusFilter === 'all' && siteMatches) return true
  if (statusFilter === 'all' && site.groups.some((group) => group.name.toLowerCase().includes(normalized))) return true
  return site.groups.some((group) => {
    const groupMatches = siteMatches || group.name.toLowerCase().includes(normalized)
    return group.models.some((model) =>
      matchesModel(model, statusFilter, activeModelIds) && (groupMatches || model.name.toLowerCase().includes(normalized)))
  })
}

export function scoreModel(model: ModelItem, standardRatio: number | null): number {
  if (!model.attemptCount || model.status === 'pending') return -1_000_000
  const success = (model.successCount || 0) / model.attemptCount
  const price = standardRatio == null ? 0 : 180 / Math.max(standardRatio, 0.05)
  const latency = (model.avgTtftMs || 10_000) * 0.07 + (model.avgTotalMs || 30_000) * 0.012
  return success * 1200 + Math.min(price, 360) - latency
}

export function statusError(model: ModelItem): string {
  return model.attempts
    .map((attempt, index) => attempt.ok ? '' : `第${index + 1}次：${attempt.error || '测活失败，未返回错误信息'}`)
    .filter(Boolean)
    .join('\n')
}

export type SortMode = 'manual' | 'recommended' | 'latency' | 'success' | 'name'

export const sortModes: ReadonlyArray<{ value: SortMode; label: string; hint: string }> = [
  { value: 'manual', label: '自定义顺序', hint: '保持拖动排序的结果' },
  { value: 'recommended', label: '智能推荐', hint: '综合成功率、价格与延迟' },
  { value: 'latency', label: '响应最快', hint: '按平均 TTFT 从快到慢' },
  { value: 'success', label: '成功率最高', hint: '按测活成功率从高到低' },
  { value: 'name', label: '名称', hint: '按模型名称字典序' },
]

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

function latencyRank(model: ModelItem): number {
  const value = model.avgTtftMs ?? model.avgTotalMs
  if (value == null || !Number.isFinite(value) || model.status === 'pending') return Number.POSITIVE_INFINITY
  return value
}

function successRank(model: ModelItem): number {
  if (!model.attemptCount) return -1
  return (model.successCount || 0) / model.attemptCount
}

/** Ordering applied inside a group. `manual` keeps the persisted sort order. */
export function sortModels(models: ModelItem[], mode: SortMode, standardRatio: number | null): ModelItem[] {
  if (mode === 'manual') return models
  const sorted = [...models]
  if (mode === 'recommended') sorted.sort((a, b) => scoreModel(b, standardRatio) - scoreModel(a, standardRatio))
  else if (mode === 'latency') sorted.sort((a, b) => latencyRank(a) - latencyRank(b) || collator.compare(a.name, b.name))
  else if (mode === 'success') sorted.sort((a, b) => successRank(b) - successRank(a) || latencyRank(a) - latencyRank(b))
  else sorted.sort((a, b) => collator.compare(a.name, b.name))
  return sorted
}

/** Groups follow their best model so the strongest option surfaces first. */
export function sortGroups(groups: GroupItem[], mode: SortMode): GroupItem[] {
  if (mode === 'manual' || mode === 'name') {
    return mode === 'name' ? [...groups].sort((a, b) => collator.compare(a.name, b.name)) : groups
  }
  const rank = (group: GroupItem) => {
    if (mode === 'latency') return Math.min(...group.models.map(latencyRank), Number.POSITIVE_INFINITY)
    if (mode === 'success') return -Math.max(...group.models.map(successRank), -1)
    return -Math.max(...group.models.map((model) => scoreModel(model, group.standardRatio)), -1_000_000)
  }
  return [...groups].sort((a, b) => rank(a) - rank(b))
}
