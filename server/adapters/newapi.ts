import {
  authHeaders,
  extractMessage,
  readJson,
  remoteFetch,
  responseCookie,
  unwrap,
} from '../http.js'
import { browserLogin } from '../cloak.js'
import type {
  Credentials,
  ExistingRemoteKey,
  RemoteAuth,
  RemoteGroup,
  RemoteKey,
  SiteAdapter,
} from '../types.js'

interface NewApiToken {
  id: number
  name: string
  key?: string
  group?: string
  status?: number
  expired_time?: number
  remain_quota?: number
  unlimited_quota?: boolean
  model_limits_enabled?: boolean
  model_limits?: string
  allow_ips?: string
  cross_group_retry?: boolean
}

function monitorName(groupName: string): string {
  const name = `${groupName}_Monitor`
  if (name.length > 50) throw new Error(`分组「${groupName}」名称过长，无法按“分组名_Monitor”创建 New API Key（最多 50 个字符）`)
  return name
}

export class NewApiAdapter implements SiteAdapter {
  readonly type = 'newapi' as const

  async probe(baseUrl: string): Promise<boolean> {
    try {
      const response = await remoteFetch(baseUrl, '/api/status', {}, 6_000)
      if (!response.ok) return false
      const body = await response.json() as any
      const data = body?.data
      return body?.success === true && Boolean(data && typeof data === 'object' && (
        data.quota_per_unit != null
        || data.system_name
        || data.version
        || data.start_time != null
        || data.setup != null
      ))
    } catch {
      return false
    }
  }

  async login(baseUrl: string, credentials: Credentials): Promise<RemoteAuth> {
    const response = await remoteFetch(baseUrl, '/api/user/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: credentials.username, password: credentials.password }),
    })
    const cookie = responseCookie(response)
    const raw = await response.json().catch(() => null) as any
    if (!response.ok || raw?.success === false) {
      const message = extractMessage(raw)
      if (/turnstile|captcha|人机|验证码|验证/i.test(`${message} ${raw?.reason || ''}`)) {
        return browserLogin('newapi', baseUrl, credentials)
      }
      if (/turnstile|captcha|人机|验证码/i.test(message)) {
        throw new Error('该 New API 站点启用了人机验证，无法自动登录；请为监控账号关闭登录验证码或使用站点提供的可信访问方式')
      }
      throw new Error(message || `New API 登录失败（HTTP ${response.status}）`)
    }
    const data = unwrap(raw)
    if (data?.require_2fa || raw?.data?.require_2fa) throw new Error('该 New API 账号启用了两步验证，暂不支持自动登录')
    const user = data?.user || data
    const accessToken = data?.access_token || raw?.data?.access_token
    if (!accessToken && !cookie) throw new Error('New API 登录成功但未返回可用会话')
    return {
      accessToken,
      cookie,
      userId: user?.id != null ? String(user.id) : undefined,
    }
  }

  async snapshot(baseUrl: string, auth: RemoteAuth) {
    const headers = authHeaders(auth)
    const [statusResponse, selfResponse, groupsResponse] = await Promise.all([
      remoteFetch(baseUrl, '/api/status', { headers }),
      remoteFetch(baseUrl, '/api/user/self', { headers }),
      remoteFetch(baseUrl, '/api/user/self/groups', { headers }),
    ])
    const [status, user, groupsRaw] = await Promise.all([
      readJson(statusResponse),
      readJson(selfResponse),
      readJson(groupsResponse),
    ])
    const quotaPerUnit = Number(status?.quota_per_unit || 500_000)
    const groups: RemoteGroup[] = Object.entries(groupsRaw || {}).map(([name, info]: [string, any]) => ({
      externalId: name,
      name,
      ratio: typeof info?.ratio === 'number' ? info.ratio : 1,
      ratioDynamic: typeof info?.ratio !== 'number',
    }))
    return {
      balance: Number(user?.quota || 0) / quotaPerUnit,
      currency: 'USD',
      groups,
    }
  }

  private async listTokens(baseUrl: string, auth: RemoteAuth): Promise<NewApiToken[]> {
    const items: NewApiToken[] = []
    for (let page = 1; page <= 100; page += 1) {
      const response = await remoteFetch(baseUrl, `/api/token/?p=${page}&size=100`, { headers: authHeaders(auth) })
      const data = await readJson(response)
      const batch = Array.isArray(data) ? data : (data?.items || [])
      items.push(...batch)
      const total = Number(data?.total || 0)
      if (!batch.length || batch.length < 100 || (total && items.length >= total)) break
    }
    return items
  }

  private async fullKey(baseUrl: string, auth: RemoteAuth, token: NewApiToken): Promise<string> {
    if (token.key && !token.key.includes('*')) return token.key.startsWith('sk-') ? token.key : `sk-${token.key}`
    const response = await remoteFetch(baseUrl, `/api/token/${token.id}/key`, {
      method: 'POST',
      headers: authHeaders(auth),
    })
    const data = await readJson(response)
    const key = String(data?.key || '')
    if (!key) throw new Error(`无法读取 API Key「${token.name}」的完整值`)
    return key
  }

  async ensureKey(
    baseUrl: string,
    auth: RemoteAuth,
    group: RemoteGroup,
    existing?: ExistingRemoteKey,
  ): Promise<RemoteKey> {
    const tokens = await this.listTokens(baseUrl, auth)
    const desiredName = monitorName(group.name)
    let token = existing ? tokens.find((item) => String(item.id) === existing.externalId) : undefined
    token ||= tokens.find((item) => item.name === desiredName)
    if (!token && existing) token = tokens.find((item) => item.name === monitorName(existing.previousGroupName))

    const needsRepair = token && (token.status !== 1 || (token.expired_time != null && token.expired_time !== -1)
      || (!token.unlimited_quota && Number(token.remain_quota || 0) <= 0))
    if (token && (token.name !== desiredName || token.group !== group.name || needsRepair)) {
      const response = await remoteFetch(baseUrl, '/api/token/', {
        method: 'PUT',
        headers: { ...authHeaders(auth), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: token.id,
          status: 1,
          name: desiredName,
          group: group.name,
          expired_time: -1,
          remain_quota: 0,
          unlimited_quota: true,
          model_limits_enabled: token.model_limits_enabled ?? false,
          model_limits: token.model_limits ?? '',
          allow_ips: token.allow_ips ?? '',
          cross_group_retry: token.cross_group_retry ?? false,
        }),
      })
      await readJson(response)
      token = { ...token, name: desiredName, group: group.name }
    }

    if (!token) {
      const response = await remoteFetch(baseUrl, '/api/token/', {
        method: 'POST',
        headers: { ...authHeaders(auth), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: desiredName,
          group: group.name,
          expired_time: -1,
          remain_quota: 0,
          unlimited_quota: true,
          model_limits_enabled: false,
          model_limits: '',
          allow_ips: '',
          cross_group_retry: false,
        }),
      })
      await readJson(response)
      const refreshed = await this.listTokens(baseUrl, auth)
      token = refreshed.find((item) => item.name === desiredName)
      if (!token) throw new Error(`已创建「${desiredName}」，但无法重新读取该 Key`)
    }

    return {
      externalId: String(token.id),
      value: await this.fullKey(baseUrl, auth, token),
      name: desiredName,
    }
  }

  async listModels(baseUrl: string, key: string) {
    const response = await remoteFetch(baseUrl, '/v1/models', {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    })
    const body = await response.json().catch(() => null) as any
    if (!response.ok) throw new Error(extractMessage(body) || `获取模型失败（HTTP ${response.status}）`)
    const data = body?.data || unwrap(body)?.data || unwrap(body)
    const byName = new Map<string, string[]>()
    for (const item of Array.isArray(data) ? data : []) {
      const name = String(item?.id || item || '')
      if (!name) continue
      byName.set(name, Array.isArray(item?.supported_endpoint_types)
        ? item.supported_endpoint_types.map(String)
        : [])
    }
    return [...byName.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, endpointTypes]) => ({ name, endpointTypes }))
  }
}
