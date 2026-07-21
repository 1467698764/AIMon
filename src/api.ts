import type { AuthStatus, Dashboard, HealthJob, PreparedGroup, Settings, SiteEditor } from './types'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (response.status === 204) return undefined as T
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (response.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event('aimon-auth-expired'))
    throw new Error(body.error || `请求失败（HTTP ${response.status}）`)
  }
  return body as T
}

export const api = {
  authStatus: () => request<AuthStatus>('/api/auth/status'),
  setupPassword: (password: string) => request<{ ok: true }>('/api/auth/setup', { method: 'POST', body: JSON.stringify({ password }) }),
  login: (password: string) => request<{ ok: true }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string) => request<{ ok: true }>('/api/auth/password', {
    method: 'POST', body: JSON.stringify({ currentPassword, newPassword }),
  }),
  dashboard: () => request<Dashboard>('/api/dashboard'),
  settings: () => request<Settings>('/api/settings'),
  saveSettings: (data: Partial<Settings> & { password?: string }) =>
    request<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(data) }),
  site: (id: number) => request<SiteEditor>(`/api/sites/${id}`),
  discover: (data: Record<string, unknown>) =>
    request<SiteEditor>('/api/sites/discover', { method: 'POST', body: JSON.stringify(data) }),
  manual: (data: Record<string, unknown>) =>
    request<{ editor: SiteEditor; draftId: number; groups: PreparedGroup[] }>('/api/sites/manual', {
      method: 'POST', body: JSON.stringify(data),
    }),
  prepare: (draftId: number, groupIds: number[]) =>
    request<{ draftId: number; groups: PreparedGroup[] }>(`/api/drafts/${draftId}/prepare`, {
      method: 'POST', body: JSON.stringify({ groupIds }),
    }),
  configure: (draftId: number, selections: Array<{ groupId: number; modelIds: number[] }>, runHealth = true) =>
    request<{
      ok: true
      siteId: number
      dashboard?: Dashboard
      job?: HealthJob
      healthStartError?: string
      refreshError?: string
    }>(`/api/drafts/${draftId}/configure`, {
      method: 'POST', body: JSON.stringify({ selections, runHealth }),
    }),
  deleteSite: (id: number) => request<void>(`/api/sites/${id}`, { method: 'DELETE' }),
  discardDraft: (id: number) => request<void>(`/api/drafts/${id}`, { method: 'DELETE' }),
  expanded: (kind: 'site' | 'group', id: number, expanded: boolean) =>
    request(`/api/sites/${kind}/${id}/expanded`, { method: 'PATCH', body: JSON.stringify({ expanded }) }),
  reorder: (kind: 'site' | 'group', ids: number[]) =>
    request(`/api/order/${kind}`, { method: 'PUT', body: JSON.stringify({ ids }) }),
  health: (scope: { siteId?: number; groupId?: number; modelId?: number } = {}) =>
    request<HealthJob>('/api/health/run', { method: 'POST', body: JSON.stringify(scope) }),
  jobs: () => request<HealthJob[]>('/api/health/jobs'),
}
