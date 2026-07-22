import type { AuthStatus, Dashboard, HealthJob, PreparedGroup, Settings, SiteEditor } from './types'

async function request<T>(url: string, init?: RequestInit, timeoutOverrideMs?: number): Promise<T> {
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
    if (response.status === 204) return undefined as T
    let body: Record<string, any>
    try {
      body = await response.json()
    } catch (error) {
      if (controller.signal.aborted) throw error
      body = {}
    }
    if (!response.ok) {
      if (response.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event('aimon-auth-expired'))
      throw new Error(body.error || `请求失败（HTTP ${response.status}）`)
    }
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
  authStatus: () => request<AuthStatus>('/api/auth/status'),
  setupPassword: (password: string) => request<{ ok: true }>('/api/auth/setup', { method: 'POST', body: JSON.stringify({ password }) }),
  login: (password: string) => request<{ ok: true }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string) => request<{ ok: true }>('/api/auth/password', {
    method: 'POST', body: JSON.stringify({ currentPassword, newPassword }),
  }),
  dashboard: (signal?: AbortSignal) => request<Dashboard>('/api/dashboard', { signal }),
  settings: () => request<Settings>('/api/settings'),
  saveSettings: (data: Partial<Settings> & { password?: string }) =>
    request<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(data) }),
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
  jobs: (signal?: AbortSignal) => request<HealthJob[]>('/api/health/jobs', { signal }),
}
