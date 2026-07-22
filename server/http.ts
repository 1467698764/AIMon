import { config } from './config.js'
import {
  browserFetch,
  cachedBrowserSession,
  isCloudflareChallenge,
  refreshBrowserSession,
  type BrowserSession,
} from './cloak.js'
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
  if (!value) throw new Error('Base URL cannot be empty')
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value)) {
    throw new Error('Base URL only supports HTTP or HTTPS')
  }
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`
  const parsed = new URL(withProtocol)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Base URL only supports HTTP or HTTPS')
  if (parsed.username || parsed.password) throw new Error('Base URL must not contain embedded username or password')
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

interface ActiveRequest {
  response: Response
  controller: AbortController
  timer: NodeJS.Timeout
}

const maxResponseBytes = 8 * 1024 * 1024

class OriginSemaphore {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active += 1
    try {
      return await task()
    } finally {
      this.active -= 1
      this.waiting.shift()?.()
    }
  }
}

const originSemaphores = new Map<string, OriginSemaphore>()

function semaphoreFor(baseUrl: string): OriginSemaphore {
  const origin = new URL(normalizeBaseUrl(baseUrl)).origin
  let semaphore = originSemaphores.get(origin)
  if (!semaphore) {
    semaphore = new OriginSemaphore(3)
    originSemaphores.set(origin, semaphore)
  }
  return semaphore
}

async function nodeRequest(
  targetUrl: string,
  init: RequestInit,
  timeoutMs: number,
  session?: BrowserSession,
): Promise<ActiveRequest> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal
  const headers = new Headers(init.headers)
  headers.set('User-Agent', session?.userAgent || 'AIMon/1.0')
  if (session?.cookie) {
    const existing = headers.get('Cookie')
    headers.set('Cookie', existing ? `${existing}; ${session.cookie}` : session.cookie)
  }
  try {
    const response = await fetch(targetUrl, { ...init, redirect: 'manual', signal, headers })
    return { response, controller, timer }
  } catch (error) {
    clearTimeout(timer)
    throw error
  }
}

async function discard(active: ActiveRequest | undefined): Promise<void> {
  if (!active) return
  clearTimeout(active.timer)
  active.controller.abort()
  await active.response.body?.cancel().catch(() => undefined)
}

function responseWithBodyDeadline(active: ActiveRequest, timeoutMs: number): Response {
  if (!active.response.body) {
    clearTimeout(active.timer)
    return active.response
  }
  const reader = active.response.body.getReader()
  let bytesRead = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          clearTimeout(active.timer)
          controller.close()
        } else {
          bytesRead += result.value.byteLength
          if (bytesRead > maxResponseBytes) {
            clearTimeout(active.timer)
            active.controller.abort()
            await reader.cancel().catch(() => undefined)
            controller.error(new RemoteError('The remote response exceeded the 8 MiB safety limit'))
            return
          }
          controller.enqueue(result.value)
        }
      } catch (error) {
        clearTimeout(active.timer)
        controller.error(error instanceof Error && error.name === 'AbortError'
          ? new RemoteError(`Request timed out (${timeoutMs}ms)`)
          : error)
      }
    },
    async cancel(reason) {
      clearTimeout(active.timer)
      active.controller.abort()
      await reader.cancel(reason).catch(() => undefined)
    },
  })
  return new Response(body, {
    status: active.response.status,
    statusText: active.response.statusText,
    headers: active.response.headers,
  })
}

async function remoteFetchInternal(
  baseUrl: string,
  pathname: string,
  init: RequestInit = {},
  timeoutMs = config.requestTimeoutMs,
): Promise<Response> {
  const targetUrl = endpoint(baseUrl, pathname)
  let active: ActiveRequest | undefined
  try {
    if (config.cloakBrowserProxy) {
      const browserResponse = await browserFetch(baseUrl, targetUrl, init, timeoutMs)
      if (await isCloudflareChallenge(browserResponse)) {
        throw new RemoteError('The proxied CloakBrowser request still returned Cloudflare verification; use manual API Key mode if interaction is required', browserResponse.status)
      }
      if (browserResponse.status >= 300 && browserResponse.status < 400) {
        throw new RemoteError('远端请求发生重定向，已拒绝跟随以避免泄露登录凭据', browserResponse.status)
      }
      return browserResponse
    }
    const initialSession = cachedBrowserSession(baseUrl)
    active = await nodeRequest(targetUrl, init, timeoutMs, initialSession)
    if (await isCloudflareChallenge(active.response)) {
      await discard(active)
      active = undefined
      if (init.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
      const newerSession = cachedBrowserSession(baseUrl)
      const session = newerSession && newerSession !== initialSession
        ? newerSession
        : await refreshBrowserSession(baseUrl, targetUrl, init.signal)
      if (init.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
      active = await nodeRequest(targetUrl, init, timeoutMs, session)
      if (await isCloudflareChallenge(active.response)) {
        await discard(active)
        active = undefined
        const browserResponse = await browserFetch(baseUrl, targetUrl, init, timeoutMs)
        if (await isCloudflareChallenge(browserResponse)) {
          throw new RemoteError('CloakBrowser completed the browser request, but the site still returned Cloudflare verification; use manual API Key mode if interaction is required', browserResponse.status)
        }
        if (browserResponse.status >= 300 && browserResponse.status < 400) {
          throw new RemoteError('远端请求发生重定向，已拒绝跟随以避免泄露登录凭据', browserResponse.status)
        }
        return browserResponse
      }
    }
    if (active.response.status >= 300 && active.response.status < 400) {
      const status = active.response.status
      await discard(active)
      active = undefined
      throw new RemoteError('远端请求发生重定向，已拒绝跟随以避免泄露登录凭据', status)
    }
    const response = responseWithBodyDeadline(active, timeoutMs)
    active = undefined
    return response
  } catch (error) {
    await discard(active)
    if (error instanceof RemoteError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new RemoteError(`Request timed out (${timeoutMs}ms)`)
    }
    throw new RemoteError(error instanceof Error ? error.message : 'Unable to connect to the site')
  }
}

export async function remoteFetch(
  baseUrl: string,
  pathname: string,
  init: RequestInit = {},
  timeoutMs = config.requestTimeoutMs,
): Promise<Response> {
  return semaphoreFor(baseUrl).run(() => remoteFetchInternal(baseUrl, pathname, init, timeoutMs))
}

export async function readJson(response: Response): Promise<any> {
  const text = await response.text()
  let body: any
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new RemoteError(`The remote returned non-JSON content (HTTP ${response.status})`, response.status)
  }
  if (!response.ok) {
    throw new RemoteError(extractMessage(body) || `Remote request failed (HTTP ${response.status})`, response.status, body)
  }
  return unwrap(body)
}

export function unwrap(body: any): any {
  if (body && typeof body === 'object' && typeof body.code === 'number') {
    if (body.code !== 0) throw new RemoteError(extractMessage(body) || `Remote error code ${body.code}`, undefined, body)
    return body.data
  }
  if (body && typeof body === 'object' && body.success === false) {
    throw new RemoteError(extractMessage(body) || 'Remote operation failed', undefined, body)
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
