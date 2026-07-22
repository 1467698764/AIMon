import type { AuthStatus, Dashboard, HealthJob, PreparedGroup, Settings, SiteEditor } from './types'

type Validator<T> = (value: unknown) => value is T

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isAuthStatus(value: unknown): value is AuthStatus {
  return isRecord(value) && typeof value.configured === 'boolean' && typeof value.authenticated === 'boolean'
}

function isSettings(value: unknown): value is Settings {
  return isRecord(value)
    && typeof value.username === 'string'
    && typeof value.hasPassword === 'boolean'
    && typeof value.autoCheckMinutes === 'number'
    && typeof value.healthAttempts === 'number'
}

function isDashboard(value: unknown): value is Dashboard {
  if (!isRecord(value) || !isSettings(value.settings) || !isRecord(value.summary) || !Array.isArray(value.sites)) return false
  const summary = value.summary
  if (!['sites', 'groups', 'models', 'excellent', 'checking'].every((key) => typeof summary[key] === 'number')) return false
  return value.sites.every((site) => isRecord(site)
    && typeof site.id === 'number'
    && typeof site.name === 'string'
    && typeof site.baseUrl === 'string'
    && Array.isArray(site.groups)
    && site.groups.every((group) => isRecord(group)
      && typeof group.id === 'number'
      && typeof group.name === 'string'
      && Array.isArray(group.models)
      && group.models.every((model) => isRecord(model)
        && typeof model.id === 'number'
        && typeof model.name === 'string'
        && ['excellent', 'available', 'failed', 'pending'].includes(String(model.status))
        && Array.isArray(model.attempts))))
}

function isHealthJobs(value: unknown): value is HealthJob[] {
  return Array.isArray(value) && value.every((job) => isRecord(job)
    && typeof job.id === 'string'
    && ['queued', 'running', 'completed', 'failed'].includes(String(job.status))
    && ['refreshing', 'checking'].includes(String(job.phase))
    && typeof job.total === 'number'
    && typeof job.completed === 'number'
    && Array.isArray(job.targets)
    && job.targets.every((target) => isRecord(target)
      && typeof target.siteId === 'number'
      && typeof target.groupId === 'number'
      && typeof target.modelId === 'number'
      && typeof target.label === 'string'
      && typeof target.status === 'string'))
}

export async function request<T>(url: string, init?: RequestInit, timeoutOverrideMs?: number, validator?: Validator<T>): Promise<T> {
  const controller = new AbortController()
  const timeoutMs = timeoutOverrideMs ?? (init?.method && init.method !== 'GET' ? 90_000 : 15_000)
  let timedOut = false
  const abortFromCaller = () => controller.abort()
  if (init?.signal?.aborted) controller.abort()
  else init?.signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
    if (response.status === 204) {
      if (validator) throw new Error('服务器返回的数据结构不完整，请稍后重试')
      return undefined as T
    }
    let body: unknown = {}
    try {
      const text = await response.text()
      body = text ? JSON.parse(text) : {}
    } catch (error) {
      if (controller.signal.aborted) throw error
      if (response.ok) throw new Error('服务器返回了无效响应（应为 JSON）')
      body = {}
    }
    if (!response.ok) {
      if (response.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event('aimon-auth-expired'))
      const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `请求失败（HTTP ${response.status}）`
      throw new Error(message)
    }
    if (body == null || typeof body !== 'object') throw new Error('服务器返回了无效响应（应为 JSON 对象或数组）')
    if (validator && !validator(body)) throw new Error('服务器返回的数据结构不完整，请稍后重试')
    return body as T
  } catch (error) {
    if (timedOut) throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`)
    throw error
  } finally {
    clearTimeout(timer)
    init?.signal?.removeEventListener('abort', abortFromCaller)
  }
}

export const api = {
  authStatus: () => request<AuthStatus>('/api/auth/status', undefined, undefined, isAuthStatus),
  setupPassword: (password: string) => request<{ ok: true }>('/api/auth/setup', { method: 'POST', body: JSON.stringify({ password }) }),
  login: (password: string) => request<{ ok: true }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string) => request<{ ok: true }>('/api/auth/password', {
    method: 'POST', body: JSON.stringify({ currentPassword, newPassword }),
  }),
  dashboard: (signal?: AbortSignal) => request<Dashboard>('/api/dashboard', { signal }, undefined, isDashboard),
  settings: () => request<Settings>('/api/settings', undefined, undefined, isSettings),
  saveSettings: (data: Partial<Settings> & { password?: string }) =>
    request<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(data) }, undefined, isSettings),
  site: (id: number, signal?: AbortSignal) => request<SiteEditor>(`/api/sites/${id}`, { signal }),
  discover: (data: Record<string, unknown>, signal?: AbortSignal) =>
    request<SiteEditor>('/api/sites/discover', { method: 'POST', body: JSON.stringify(data), signal }, 5 * 60_000),
  manual: (data: Record<string, unknown>, signal?: AbortSignal) =>
    request<{ editor: SiteEditor; draftId: number; groups: PreparedGroup[] }>('/api/sites/manual', {
      method: 'POST', body: JSON.stringify(data), signal,
    }, 15 * 60_000),
  prepare: (draftId: number, groupIds: number[], signal?: AbortSignal) =>
    request<{ draftId: number; groups: PreparedGroup[] }>(`/api/drafts/${draftId}/prepare`, {
      method: 'POST', body: JSON.stringify({ groupIds }), signal,
    }, 15 * 60_000),
  configure: (draftId: number, selections: Array<{ groupId: number; modelIds: number[] }>, runHealth = true, signal?: AbortSignal) =>
    request<{
      ok: true
      siteId: number
      dashboard?: Dashboard
      job?: HealthJob
      healthStartError?: string
      refreshError?: string
    }>(`/api/drafts/${draftId}/configure`, {
      method: 'POST', body: JSON.stringify({ selections, runHealth }), signal,
    }, 5 * 60_000),
  deleteSite: (id: number) => request<void>(`/api/sites/${id}`, { method: 'DELETE' }),
  discardDraft: (id: number) => request<void>(`/api/drafts/${id}`, { method: 'DELETE' }),
  expanded: (kind: 'site' | 'group', id: number, expanded: boolean) =>
    request(`/api/sites/${kind}/${id}/expanded`, { method: 'PATCH', body: JSON.stringify({ expanded }) }),
  expandedBulk: (siteIds: number[], expanded: boolean) =>
    request<{ ok: true; sites: number; groups: number }>('/api/sites/expanded/bulk', {
      method: 'PATCH', body: JSON.stringify({ siteIds, expanded }),
    }),
  reorder: (kind: 'site' | 'group', ids: number[]) =>
    request(`/api/order/${kind}`, { method: 'PUT', body: JSON.stringify({ ids }) }),
  health: (scope: { siteId?: number; groupId?: number; modelId?: number } = {}) =>
    request<HealthJob>('/api/health/run', { method: 'POST', body: JSON.stringify(scope) }),
  jobs: (signal?: AbortSignal) => request<HealthJob[]>('/api/health/jobs', { signal }, undefined, isHealthJobs),
}
