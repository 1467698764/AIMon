import { config } from './config.js'
import { cachedBrowserSession, isCloudflareChallenge, refreshBrowserSession, type BrowserSession } from './cloak.js'
import type { RemoteAuth } from './types.js'

export class RemoteError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message)
  }
}

export function normalizeBaseUrl(raw: string): string {
  const value = raw.trim()
  if (!value) throw new Error('Base URL 不能为空')
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value)) {
    throw new Error('Base URL 仅支持 HTTP 或 HTTPS')
  }
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`
  const parsed = new URL(withProtocol)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Base URL 仅支持 HTTP 或 HTTPS')
  parsed.hash = ''
  parsed.search = ''
  parsed.pathname = parsed.pathname.replace(/\/(api\/)?v1\/?$/i, '').replace(/\/+$/, '')
  return parsed.toString().replace(/\/$/, '')
}

export function endpoint(baseUrl: string, pathname: string): string {
  return `${normalizeBaseUrl(baseUrl)}${pathname.startsWith('/') ? pathname : `/${pathname}`}`
}

export function authHeaders(auth?: RemoteAuth): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (auth?.accessToken) headers.Authorization = `Bearer ${auth.accessToken}`
  if (auth?.cookie) headers.Cookie = auth.cookie
  if (auth?.userId) headers['New-Api-User'] = auth.userId
  return headers
}

export async function remoteFetch(
  baseUrl: string,
  pathname: string,
  init: RequestInit = {},
  timeoutMs = config.requestTimeoutMs,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal
  const run = (session?: BrowserSession) => {
    const headers = new Headers(init.headers)
    headers.set('User-Agent', session?.userAgent || 'AIMon/1.0')
    if (session?.cookie) {
      const existing = headers.get('Cookie')
      headers.set('Cookie', existing ? `${existing}; ${session.cookie}` : session.cookie)
    }
    return fetch(endpoint(baseUrl, pathname), {
      ...init,
      redirect: 'manual',
      signal,
      headers,
    })
  }
  try {
    let response = await run(cachedBrowserSession(baseUrl))
    if (await isCloudflareChallenge(response)) {
      const session = await refreshBrowserSession(baseUrl)
      response = await run(session)
      if (await isCloudflareChallenge(response)) {
        throw new RemoteError('CloakBrowser 已取得浏览器会话，但站点仍返回 Cloudflare 验证；可改用手动 API Key 接入', response.status)
      }
    }
    if (response.status >= 300 && response.status < 400) {
      throw new RemoteError('远端请求发生重定向，已拒绝跟随以避免泄露登录凭据', response.status)
    }
    return response
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new RemoteError(`请求超时（${timeoutMs}ms）`)
    }
    throw new RemoteError(error instanceof Error ? error.message : '无法连接站点')
  } finally {
    clearTimeout(timer)
  }
}

export async function readJson(response: Response): Promise<any> {
  const text = await response.text()
  let body: any
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new RemoteError(`远端返回了非 JSON 内容（HTTP ${response.status}）`, response.status)
  }
  if (!response.ok) {
    throw new RemoteError(extractMessage(body) || `远端请求失败（HTTP ${response.status}）`, response.status, body)
  }
  return unwrap(body)
}

export function unwrap(body: any): any {
  if (body && typeof body === 'object' && typeof body.code === 'number') {
    if (body.code !== 0) throw new RemoteError(extractMessage(body) || `远端错误码 ${body.code}`, undefined, body)
    return body.data
  }
  if (body && typeof body === 'object' && body.success === false) {
    throw new RemoteError(extractMessage(body) || '远端操作失败', undefined, body)
  }
  if (body && typeof body === 'object' && body.success === true && 'data' in body) return body.data
  return body
}

export function extractMessage(body: any): string {
  return String(body?.message || body?.error?.message || body?.error || body?.msg || '')
}

export function responseCookie(response: Response): string {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || '']
  return values
    .filter(Boolean)
    .map((value) => value.split(';', 1)[0])
    .join('; ')
}
