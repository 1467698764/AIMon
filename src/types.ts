export type HealthStatus = 'excellent' | 'available' | 'failed' | 'pending'

export interface AuthStatus {
  configured: boolean
  authenticated: boolean
}

export interface HealthAttempt {
  ok: boolean
  ttfbMs: number | null
  ttftMs: number | null
  totalMs: number
  httpStatus: number | null
  error?: string
}

export interface ModelItem {
  id: number
  name: string
  sortOrder: number
  checkedAt: string | null
  successCount: number | null
  attemptCount: number | null
  avgTtfbMs: number | null
  avgTtftMs: number | null
  avgTotalMs: number | null
  status: HealthStatus
  attempts: HealthAttempt[]
}

export interface GroupItem {
  id: number
  name: string
  ratio: number
  ratioDynamic: boolean
  standardRatio: number | null
  platform?: string
  expanded: boolean
  models: ModelItem[]
}

export interface SiteItem {
  id: number
  name: string
  baseUrl: string
  type: 'newapi' | 'sub2api'
  balance: number
  currency: string
  rechargeRatio: number
  connectionMode: 'auto' | 'manual'
  balanceKnown: boolean
  expanded: boolean
  lastSyncAt: string | null
  lastCheckAt: string | null
  lastError: string | null
  groups: GroupItem[]
}

export interface Settings {
  username: string
  hasPassword: boolean
  autoCheckMinutes: number
}

export interface Dashboard {
  settings: Settings
  summary: { sites: number; groups: number; models: number; excellent: number; checking: number }
  sites: SiteItem[]
}

export interface EditorGroup {
  id: number
  externalId: string
  name: string
  ratio: number
  ratioDynamic: boolean
  platform?: string
  selected: boolean
  available: boolean
  sortOrder: number
  hasKey: boolean
}

export interface SiteEditor {
  id: number
  draftId: number | null
  name: string
  baseUrl: string
  type: 'newapi' | 'sub2api'
  username: string
  hasPassword: boolean
  balance: number
  currency: string
  rechargeRatio: number
  connectionMode: 'auto' | 'manual'
  balanceKnown: boolean
  groups: EditorGroup[]
}

export interface PreparedGroup {
  id: number
  name: string
  ratio: number
  standardRatio: number | null
  models: Array<{ id: number; name: string; selected: boolean }>
}

export interface HealthJob {
  id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  total: number
  completed: number
  current: string
  targets: HealthJobTarget[]
  createdAt: string
  finishedAt?: string
  error?: string
  deduplicated?: boolean
}

export interface HealthJobTarget {
  siteId: number
  groupId: number
  modelId: number
  label: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  attempt: number
  attemptCount: number
}
