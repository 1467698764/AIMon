import {
  authHeaders,
  extractMessage,
  readJson,
  remoteFetch,
  unwrap,
} from '../http.js'
import { browserLogin } from '../cloak.js'
import { endpointTypesForModel } from './model-types.js'
import type {
  Credentials,
  ExistingRemoteKey,
  RemoteAuth,
  RemoteGroup,
  RemoteKey,
  SiteAdapter,
} from '../types.js'

interface Sub2ApiKey {
  id: number
  key: string
  name: string
  group_id: number | null
  status?: string
  quota?: number
  quota_used?: number
  expires_at?: string | null
}

function monitorName(groupName: string): string {
  return `${groupName}_Monitor`
}

export class Sub2ApiAdapter implements SiteAdapter {
  readonly type = 'sub2api' as const

  async probe(baseUrl: string): Promise<boolean> {
    try {
      const response = await remoteFetch(baseUrl, '/api/v1/settings/public', {}, 6_000)
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return false
      }
      const body = await response.json() as any
      return body?.code === 0 || Boolean(body?.data?.registration_enabled)
    } catch {
      return false
    }
  }

  async login(baseUrl: string, credentials: Credentials): Promise<RemoteAuth> {
    const response = await remoteFetch(baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email: credentials.username, password: credentials.password }),
    })
    const raw = await response.json().catch(() => null) as any
    if (!response.ok || (typeof raw?.code === 'number' && raw.code !== 0)) {
      if (/turnstile|captcha|verification|人机|验证码|验证/i.test(`${extractMessage(raw)} ${raw?.reason || raw?.data?.reason || ''}`)) {
        return browserLogin('sub2api', baseUrl, credentials)
      }
      throw new Error(extractMessage(raw) || `Sub2API 登录失败（HTTP ${response.status}）`)
    }
    const data = unwrap(raw)
    if (data?.requires_2fa) throw new Error('该 Sub2API 账号启用了两步验证，暂不支持自动登录')
    if (!data?.access_token) throw new Error('Sub2API 登录成功但未返回 access token')
    return { accessToken: data.access_token, userId: data?.user?.id != null ? String(data.user.id) : undefined }
  }

  async snapshot(baseUrl: string, auth: RemoteAuth) {
    const headers = authHeaders(auth)
    const [userResponse, groupsResponse, ratesResponse] = await Promise.all([
      remoteFetch(baseUrl, '/api/v1/auth/me', { headers }),
      remoteFetch(baseUrl, '/api/v1/groups/available', { headers }),
      remoteFetch(baseUrl, '/api/v1/groups/rates', { headers }),
    ])
    const [user, groupsRaw, rates] = await Promise.all([
      readJson(userResponse),
      readJson(groupsResponse),
      readJson(ratesResponse),
    ])
    const groups: RemoteGroup[] = (Array.isArray(groupsRaw) ? groupsRaw : []).map((group: any) => ({
      externalId: String(group.id),
      name: String(group.name),
      ratio: Number(rates?.[group.id] ?? group.rate_multiplier ?? 1),
      platform: group.platform ? String(group.platform) : undefined,
    }))
    return {
      balance: Number(user?.balance || 0),
      currency: 'USD',
      groups,
    }
  }

  private async listKeys(baseUrl: string, auth: RemoteAuth): Promise<Sub2ApiKey[]> {
    const items: Sub2ApiKey[] = []
    for (let page = 1; page <= 100; page += 1) {
      const response = await remoteFetch(baseUrl, `/api/v1/keys?page=${page}&page_size=200`, { headers: authHeaders(auth) })
      const data = await readJson(response)
      const batch = Array.isArray(data) ? data : (data?.items || [])
      items.push(...batch)
      const pages = Number(data?.pages || 0)
      const total = Number(data?.total || 0)
      if (!batch.length || (pages && page >= pages) || (total && items.length >= total) || batch.length < 200) break
    }
    return items
  }

  async ensureKey(
    baseUrl: string,
    auth: RemoteAuth,
    group: RemoteGroup,
    existing?: ExistingRemoteKey,
  ): Promise<RemoteKey> {
    const keys = await this.listKeys(baseUrl, auth)
    const desiredName = monitorName(group.name)
    let key = existing ? keys.find((item) => String(item.id) === existing.externalId) : undefined
    key ||= keys.find((item) => item.name === desiredName && String(item.group_id) === group.externalId)

    const expired = Boolean(key?.expires_at && new Date(key.expires_at).getTime() <= Date.now())
    const exhausted = Boolean(key?.quota && Number(key.quota_used || 0) >= Number(key.quota))
    if (key && (key.name !== desiredName || String(key.group_id) !== group.externalId
      || key.status !== 'active' || expired || exhausted)) {
      const response = await remoteFetch(baseUrl, `/api/v1/keys/${key.id}`, {
        method: 'PUT',
        headers: { ...authHeaders(auth), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: desiredName,
          group_id: Number(group.externalId),
          status: 'active',
          quota: 0,
          reset_quota: true,
          ...(expired ? { expires_at: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString() } : {}),
        }),
      })
      key = await readJson(response)
    }

    if (!key) {
      const response = await remoteFetch(baseUrl, '/api/v1/keys', {
        method: 'POST',
        headers: { ...authHeaders(auth), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: desiredName, group_id: Number(group.externalId) }),
      })
      key = await readJson(response)
    }
    if (!key?.key) throw new Error(`无法读取 API Key「${desiredName}」的完整值`)
    return { externalId: String(key.id), value: key.key, name: desiredName }
  }

  async listModels(baseUrl: string, key: string) {
    const response = await remoteFetch(baseUrl, '/v1/models', {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    })
    const body = await response.json().catch(() => null) as any
    if (!response.ok) throw new Error(extractMessage(body) || `获取模型失败（HTTP ${response.status}）`)
    const unwrapped = unwrap(body)
    const data = unwrapped?.data || unwrapped
    const byName = new Map<string, string[]>()
    for (const item of Array.isArray(data) ? data : []) {
      const name = String(item?.id || item || '')
      if (!name) continue
      byName.set(name, endpointTypesForModel(name, item?.supported_endpoint_types))
    }
    return [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([name, endpointTypes]) => ({ name, endpointTypes }))
  }
}
