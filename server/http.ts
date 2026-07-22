import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
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
  private readonly waiting: Array<{
    resolve: () => void
    reject: (error: Error) => void
    signal?: AbortSignal | null
    abort?: () => void
  }> = []

  constructor(private readonly limit: number) {}

  private async acquire(signal?: AbortSignal | null): Promise<void> {
    if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
    if (this.active < this.limit) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const entry: (typeof this.waiting)[number] = { resolve, reject, signal }
      entry.abort = () => {
        const index = this.waiting.indexOf(entry)
        if (index >= 0) this.waiting.splice(index, 1)
        reject(new DOMException('The operation was aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', entry.abort, { once: true })
      this.waiting.push(entry)
    })
  }

  private release(): void {
    this.active -= 1
    while (this.waiting.length) {
      const next = this.waiting.shift()!
      next.signal?.removeEventListener('abort', next.abort!)
      if (next.signal?.aborted) continue
      this.active += 1
      next.resolve()
      break
    }
  }

  async acquirePermit(signal?: AbortSignal | null): Promise<() => void> {
    await this.acquire(signal)
    let released = false
    return () => {
      if (released) return
      released = true
      this.release()
    }
  }

  get idle(): boolean {
    return this.active === 0 && this.waiting.length === 0
  }
}

const originSemaphores = new Map<string, OriginSemaphore>()
const destinationChecks = new Map<string, { expiresAt: number; promise: Promise<void> }>()
const privateNetworkBlockList = new BlockList()

for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as Array<[string, number]>) privateNetworkBlockList.addSubnet(network, prefix, 'ipv4')

for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as Array<[string, number]>) privateNetworkBlockList.addSubnet(network, prefix, 'ipv6')

export function isPrivateNetworkAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%', 1)[0]
  const family = isIP(normalized)
  return family !== 0 && privateNetworkBlockList.check(normalized, family === 4 ? 'ipv4' : 'ipv6')
}

async function assertRemoteDestination(baseUrl: string): Promise<void> {
  if (config.allowPrivateNetwork) return
  const hostname = new URL(normalizeBaseUrl(baseUrl)).hostname.toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new RemoteError('Private or loopback network destinations are disabled')
  }
  const cached = destinationChecks.get(hostname)
  if (cached && cached.expiresAt > Date.now()) return cached.promise
  const promise = lookup(hostname, { all: true, verbatim: true }).then((addresses) => {
    if (!addresses.length || addresses.some(({ address }) => isPrivateNetworkAddress(address))) {
      throw new RemoteError('Private or loopback network destinations are disabled')
    }
  }).catch((error) => {
    if (error instanceof RemoteError) throw error
    throw new RemoteError(`Unable to resolve the remote site: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (!cached && destinationChecks.size >= 1_024) {
    const oldest = destinationChecks.keys().next().value
    if (oldest) destinationChecks.delete(oldest)
  }
  destinationChecks.set(hostname, { expiresAt: Date.now() + 60_000, promise })
  try {
    await promise
  } catch (error) {
    if (destinationChecks.get(hostname)?.promise === promise) destinationChecks.delete(hostname)
    throw error
  }
}

function semaphoreFor(baseUrl: string): OriginSemaphore {
  const origin = new URL(normalizeBaseUrl(baseUrl)).origin
  let semaphore = originSemaphores.get(origin)
  if (!semaphore) {
    semaphore = new OriginSemaphore(3)
    originSemaphores.set(origin, semaphore)
  }
  return semaphore
}

function responseWithPermit(response: Response, release: () => void, timeoutMs: number): Response {
  if (!response.body) {
    release()
    return response
  }
  const reader = response.body.getReader()
  let finished = false
  const fallback = setTimeout(finish, timeoutMs)
  fallback.unref()
  function finish(): void {
    if (finished) return
    finished = true
    clearTimeout(fallback)
    release()
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          finish()
          controller.close()
        } else {
          controller.enqueue(chunk.value)
        }
      } catch (error) {
        finish()
        controller.error(error)
      }
    },
    async cancel(reason) {
      finish()
      await reader.cancel(reason).catch(() => undefined)
    },
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
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
  await assertRemoteDestination(baseUrl)
  const semaphore = semaphoreFor(baseUrl)
  const origin = new URL(normalizeBaseUrl(baseUrl)).origin
  const cleanup = () => {
    if (semaphore.idle && originSemaphores.get(origin) === semaphore) originSemaphores.delete(origin)
  }
  const releasePermit = await semaphore.acquirePermit(init.signal)
  const release = () => {
    releasePermit()
    cleanup()
  }
  try {
    const response = await remoteFetchInternal(baseUrl, pathname, init, timeoutMs)
    return responseWithPermit(response, release, timeoutMs)
  } catch (error) {
    release()
    throw error
  }
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
