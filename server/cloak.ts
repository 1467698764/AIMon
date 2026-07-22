import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { BrowserContext, Page } from 'playwright-core'
import { config } from './config.js'
import type { Credentials, RemoteAuth } from './types.js'

export interface BrowserSession {
  cookie: string
  userAgent: string
  expiresAt: number
}

interface ManagedContext {
  context: BrowserContext
  page: Page
  origin: string
  userAgent: string
  lastUsedAt: number
  requestGate: Semaphore
  challengeGate: Semaphore
  loginGate: Semaphore
  activeRequests: number
  idleTimer?: NodeJS.Timeout
}

interface BrowserFetchResult {
  status: number
  statusText: string
  headers: Array<[string, string]>
  text: string
  redirected: boolean
  finalUrl: string
  ttfbMs: number
  ttftMs: number | null
  totalMs: number
}

class Semaphore {
  private active = 0
  private readonly waiting: Array<{ resolve: () => void; signal?: AbortSignal | null; abort?: () => void }> = []

  constructor(private readonly limit: number) {}

  private async acquire(signal?: AbortSignal | null): Promise<void> {
    if (signal?.aborted) throw abortError()
    if (this.active < this.limit) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const entry: { resolve: () => void; signal?: AbortSignal | null; abort?: () => void } = { resolve, signal }
      entry.abort = () => {
        const index = this.waiting.indexOf(entry)
        if (index >= 0) this.waiting.splice(index, 1)
        reject(abortError())
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

  async run<T>(task: () => Promise<T>, signal?: AbortSignal | null): Promise<T> {
    await this.acquire(signal)
    try {
      return await task()
    } finally {
      this.release()
    }
  }
}

const sessions = new Map<string, BrowserSession>()
const contexts = new Map<string, ManagedContext>()
const pending = new Map<string, Promise<ManagedContext>>()
const refreshing = new Map<string, Promise<BrowserSession>>()
const closing = new Map<string, Promise<void>>()
const launchGate = new Semaphore(1)
const challengeInspectionBytes = 512 * 1024

function originOf(baseUrl: string): string {
  return new URL(baseUrl).origin
}

function challengePattern(value: string): boolean {
  return /cf-chl-|cf_chl_|challenge-form|challenge-error-text|just a moment|attention required|checking your browser|performing security verification/i.test(value)
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const withoutConfiguredProxy = config.cloakBrowserProxy
    ? message.replaceAll(config.cloakBrowserProxy, '[redacted proxy]')
    : message
  return withoutConfiguredProxy.replace(/((?:https?|socks5):\/\/)([^@\s/]+)@/gi, '$1[redacted]@')
}

function systemBrowserPath(): string | undefined {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
        path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  return candidates.find((candidate) => candidate && fs.existsSync(candidate))
}

async function launchCloakBrowser(options: import('cloakbrowser').LaunchPersistentContextOptions): Promise<BrowserContext> {
  const { launchPersistentContext } = await import('cloakbrowser')
  try {
    return await launchPersistentContext(options)
  } catch (primaryError) {
    if (process.env.CLOAKBROWSER_BINARY_PATH) throw primaryError
    const fallback = systemBrowserPath()
    if (!fallback) throw primaryError
    process.env.CLOAKBROWSER_BINARY_PATH = fallback
    console.warn(`[AIMon] CloakBrowser dedicated Chromium is unavailable; using local browser fallback: ${fallback}`)
    try {
      return await launchPersistentContext(options)
    } catch (fallbackError) {
      throw new Error(`${safeError(primaryError)}; local browser fallback also failed: ${safeError(fallbackError)}`)
    }
  }
}

export function cachedBrowserSession(baseUrl: string): BrowserSession | undefined {
  const origin = originOf(baseUrl)
  const session = sessions.get(origin)
  if (session && session.expiresAt > Date.now() + 30_000) return session
  if (session) sessions.delete(origin)
  return undefined
}

export async function isCloudflareChallenge(response: Response): Promise<boolean> {
  if (response.headers.get('cf-mitigated') === 'challenge') return true
  const contentType = response.headers.get('content-type') || ''
  const suspiciousStatus = [403, 429, 503].includes(response.status)
  if (!suspiciousStatus && !/text\/html|application\/xhtml\+xml/i.test(contentType)) return false
  const clone = response.clone()
  const reader = clone.body?.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  try {
    if (reader) {
      while (bytes < challengeInspectionBytes) {
        const chunk = await reader.read()
        if (chunk.done) break
        const remaining = challengeInspectionBytes - bytes
        const value = chunk.value.byteLength > remaining ? chunk.value.subarray(0, remaining) : chunk.value
        bytes += value.byteLength
        text += decoder.decode(value, { stream: true })
        if (challengePattern(text)) return true
      }
      text += decoder.decode()
    }
  } catch {
    text = ''
  } finally {
    void reader?.cancel().catch(() => undefined)
  }
  if (challengePattern(text)) return true
  return suspiciousStatus
    && /cloudflare/i.test(response.headers.get('server') || '')
    && /text\/html|application\/xhtml\+xml/i.test(contentType)
}

function cookieHeader(cookies: Awaited<ReturnType<BrowserContext['cookies']>>): string {
  return cookies.map((item) => `${item.name}=${item.value}`).join('; ')
}

async function sessionFrom(managed: ManagedContext, targetUrl: string): Promise<BrowserSession> {
  const cookies = await managed.context.cookies(targetUrl)
  const clearance = cookies.find((cookie) => cookie.name === 'cf_clearance')
  const expiresAt = clearance?.expires && clearance.expires > 0
    ? clearance.expires * 1000
    : Date.now() + 30 * 60_000
  const session = { cookie: cookieHeader(cookies), userAgent: managed.userAgent, expiresAt }
  sessions.set(managed.origin, session)
  return session
}

function touch(managed: ManagedContext): void {
  managed.lastUsedAt = Date.now()
  if (managed.idleTimer) clearTimeout(managed.idleTimer)
  managed.idleTimer = setTimeout(() => {
    if (managed.activeRequests > 0 || Date.now() - managed.lastUsedAt < config.cloakBrowserIdleMs) {
      touch(managed)
      return
    }
    void closeManaged(managed.origin)
  }, config.cloakBrowserIdleMs)
  managed.idleTimer.unref()
}

async function closeManaged(origin: string, force = false): Promise<void> {
  const alreadyClosing = closing.get(origin)
  if (alreadyClosing) return alreadyClosing
  const managed = contexts.get(origin)
  if (!managed) return
  if (!force && managed.activeRequests > 0) return
  contexts.delete(origin)
  sessions.delete(origin)
  if (managed.idleTimer) clearTimeout(managed.idleTimer)
  const task = managed.context.close().catch(() => undefined).finally(() => closing.delete(origin))
  closing.set(origin, task)
  await task
}

async function evictIfNeeded(exceptOrigin: string): Promise<void> {
  const deadline = Date.now() + config.cloakBrowserTimeoutMs
  while (contexts.size >= config.cloakBrowserMaxContexts) {
    const oldest = [...contexts.values()]
      .filter((item) => item.origin !== exceptOrigin && item.activeRequests === 0)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0]
    if (oldest) {
      await closeManaged(oldest.origin)
      continue
    }
    if (Date.now() >= deadline) throw new Error('All CloakBrowser contexts are busy; increase CLOAKBROWSER_MAX_CONTEXTS')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function navigateThroughChallenge(managed: ManagedContext, targetUrl: string): Promise<void> {
  if (new URL(targetUrl).origin !== managed.origin) throw new Error('CloakBrowser target must remain on the configured site origin')
  const page = managed.page
  const deadline = Date.now() + config.cloakBrowserTimeoutMs
  managed.activeRequests += 1
  try {
    let response: Awaited<ReturnType<Page['goto']>> | undefined = await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: Math.max(1, deadline - Date.now()),
    })
    const requiresClearance = response?.headers()['cf-mitigated'] === 'challenge'
    let lastTitle = ''
    while (Date.now() < deadline) {
      lastTitle = await page.title().catch(() => '')
      const content = await page.content().catch(() => '')
      const challengedByHeaders = response?.headers()['cf-mitigated'] === 'challenge'
      const challenged = challengedByHeaders || challengePattern(`${lastTitle}\n${content}\n${page.url()}`)
      if (!challenged) {
        const cookies = await managed.context.cookies(targetUrl)
        if (requiresClearance && !cookies.some((cookie) => cookie.name === 'cf_clearance')) {
          await page.waitForTimeout(Math.min(1_500, Math.max(1, deadline - Date.now())))
          response = undefined
          continue
        }
        if (new URL(page.url()).origin !== managed.origin) throw new Error('Cloudflare navigation left the configured site origin')
        await sessionFrom(managed, targetUrl)
        touch(managed)
        return
      }
      await page.waitForTimeout(Math.min(1_500, Math.max(1, deadline - Date.now())))
      response = undefined
    }
    throw new Error(`Cloudflare verification did not finish before timeout${lastTitle ? ` (${lastTitle})` : ''}`)
  } finally {
    managed.activeRequests -= 1
    touch(managed)
  }
}

async function createManaged(origin: string, targetUrl: string): Promise<ManagedContext> {
  if (!config.cloakBrowserEnabled) throw new Error('The site triggered Cloudflare verification, but CloakBrowser is disabled')
  return launchGate.run(async () => {
    await closing.get(origin)
    const existing = contexts.get(origin)
    if (existing) return existing
    await evictIfNeeded(origin)
    const profileName = createHash('sha256').update(origin).digest('hex').slice(0, 24)
    const userDataDir = path.join(config.dataDir, 'cloak-profiles', profileName)
    fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 })
    fs.chmodSync(userDataDir, 0o700)

    const context = await launchCloakBrowser({
      userDataDir,
      headless: config.cloakBrowserHeadless,
      humanize: true,
      ...(config.cloakBrowserProxy ? { proxy: config.cloakBrowserProxy } : {}),
      launchOptions: { timeout: config.cloakBrowserTimeoutMs },
      contextOptions: { acceptDownloads: false, bypassCSP: true },
    })
    try {
      const page = context.pages()[0] || await context.newPage()
      const userAgent = await page.evaluate(() => navigator.userAgent)
      const managed: ManagedContext = {
        context,
        page,
        origin,
        userAgent,
        lastUsedAt: Date.now(),
        requestGate: new Semaphore(3),
        challengeGate: new Semaphore(1),
        loginGate: new Semaphore(1),
        activeRequests: 0,
      }
      await navigateThroughChallenge(managed, targetUrl)
      contexts.set(origin, managed)
      context.on('close', () => {
        if (contexts.get(origin) === managed) {
          contexts.delete(origin)
          sessions.delete(origin)
        }
        if (managed.idleTimer) clearTimeout(managed.idleTimer)
      })
      return managed
    } catch (error) {
      await context.close().catch(() => undefined)
      contexts.delete(origin)
      throw error
    }
  })
}

async function managedFor(baseUrl: string, targetUrl: string): Promise<ManagedContext> {
  const origin = originOf(baseUrl)
  const running = pending.get(origin)
  if (running) return running
  const existing = contexts.get(origin)
  if (existing) {
    touch(existing)
    return existing
  }
  const promise = createManaged(origin, targetUrl)
    .catch((error) => {
      throw new Error(`CloakBrowser could not establish a Cloudflare session: ${safeError(error)}`)
    })
    .finally(() => pending.delete(origin))
  pending.set(origin, promise)
  return promise
}

export async function refreshBrowserSession(
  baseUrl: string,
  targetUrl = baseUrl,
  signal?: AbortSignal | null,
): Promise<BrowserSession> {
  const origin = originOf(baseUrl)
  const running = refreshing.get(origin)
  if (running) return raceAbort(running, signal)
  sessions.delete(origin)
  const task = (async () => {
    const managed = await managedFor(baseUrl, targetUrl)
    const acquired = sessions.get(origin)
    if (acquired) return acquired
    await managed.challengeGate.run(() => navigateThroughChallenge(managed, targetUrl))
    return sessionFrom(managed, targetUrl)
  })().finally(() => refreshing.delete(origin))
  refreshing.set(origin, task)
  return raceAbort(task, signal)
}

function cookiesFromHeader(value: string | null, origin: string) {
  if (!value) return []
  return value.split(';').map((part) => part.trim()).filter(Boolean).flatMap((part) => {
    const separator = part.indexOf('=')
    if (separator <= 0) return []
    return [{ name: part.slice(0, separator).trim(), value: part.slice(separator + 1).trim(), url: origin }]
  })
}

function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError')
}

async function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) throw abortError()
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError())
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export async function browserFetch(
  baseUrl: string,
  targetUrl: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const expectedOrigin = originOf(baseUrl)
  if (new URL(targetUrl).origin !== expectedOrigin) throw new Error('CloakBrowser target must remain on the configured site origin')
  const managed = await managedFor(baseUrl, targetUrl)
  return managed.requestGate.run(async () => {
    if (init.signal?.aborted) throw abortError()
    managed.activeRequests += 1
    touch(managed)
    let page: Page | undefined
    try {
      const headers = new Headers(init.headers)
      const suppliedCookies = cookiesFromHeader(headers.get('cookie'), managed.origin)
      if (suppliedCookies.length) await managed.context.addCookies(suppliedCookies)
      for (const name of ['cookie', 'user-agent', 'host', 'content-length', 'connection']) headers.delete(name)
      if (init.body != null && typeof init.body !== 'string') {
        throw new Error('CloakBrowser fallback only supports text request bodies')
      }
      page = await managed.context.newPage()
      await raceAbort(page.goto(managed.origin, { waitUntil: 'domcontentloaded', timeout: timeoutMs }), init.signal)
      if (new URL(page.url()).origin !== managed.origin) throw new Error('Browser bootstrap navigation left the configured site origin')
      const task = page.evaluate(async ({ url, method, requestHeaders, body, requestTimeoutMs }) => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
        const started = performance.now()
        try {
          const response = await fetch(url, {
            method,
            headers: requestHeaders,
            body,
            credentials: 'include',
            redirect: 'manual',
            signal: controller.signal,
          })
          const headersAt = performance.now()
          const reader = response.body?.getReader()
          const decoder = new TextDecoder()
          let text = ''
          let scanBuffer = ''
          let bytes = 0
          let firstBodyAt: number | null = null
          let ttftMs: number | null = null
          const hasGeneratedText = (value: any): boolean => {
            if (!value || typeof value !== 'object') return false
            const direct = [
              value.output_text,
              value.text,
              value.content,
              value.choices?.[0]?.delta?.content,
              value.choices?.[0]?.message?.content,
            ]
            if (direct.some((item) => typeof item === 'string' && item.trim())) return true
            if (typeof value.delta === 'string' && value.delta.trim()) {
              const eventType = typeof value.type === 'string' ? value.type : ''
              if (!eventType || /(?:output_)?text.*delta|delta.*(?:output_)?text/i.test(eventType)) return true
            }
            return Array.isArray(value.output) && value.output.some((item: any) => Array.isArray(item?.content)
              && item.content.some((content: any) => {
                const generated = content?.text || content?.output_text
                return typeof generated === 'string' && generated.trim()
              }))
          }
          const containsGeneratedText = (payload: string): boolean => {
            const trimmed = payload.trim()
            try {
              if (hasGeneratedText(JSON.parse(trimmed))) return true
            } catch { /* Streaming payloads are parsed line by line below. */ }
            return payload.split(/\r?\n/).some((line) => {
              const data = line.match(/^data:\s*(.+)$/i)?.[1]?.trim()
              if (!data || data === '[DONE]') return false
              try { return hasGeneratedText(JSON.parse(data)) } catch { return false }
            })
          }
          if (reader) {
            while (true) {
              const chunk = await reader.read()
              if (chunk.done) break
              if (firstBodyAt == null && chunk.value.byteLength > 0) firstBodyAt = performance.now()
              bytes += chunk.value.byteLength
              if (bytes > 8 * 1024 * 1024) {
                controller.abort()
                throw new Error('The browser response exceeded the 8 MiB safety limit')
              }
              const decoded = decoder.decode(chunk.value, { stream: true })
              text += decoded
              scanBuffer = `${scanBuffer}${decoded}`.slice(-16_384)
              if (ttftMs == null && containsGeneratedText(scanBuffer)) {
                ttftMs = performance.now() - started
              }
            }
            const tail = decoder.decode()
            text += tail
            scanBuffer = `${scanBuffer}${tail}`.slice(-16_384)
            if (ttftMs == null && containsGeneratedText(scanBuffer)) ttftMs = performance.now() - started
          }
          return {
            status: response.status,
            statusText: response.statusText,
            headers: [...response.headers.entries()],
            text,
            redirected: response.redirected,
            finalUrl: response.url,
            ttfbMs: (firstBodyAt ?? headersAt) - started,
            ttftMs,
            totalMs: performance.now() - started,
          }
        } finally {
          clearTimeout(timer)
        }
      }, {
        url: targetUrl,
        method: init.method || 'GET',
        requestHeaders: Object.fromEntries(headers.entries()),
        body: init.body as string | undefined,
        requestTimeoutMs: timeoutMs,
      }) as Promise<BrowserFetchResult>
      const result = await raceAbort(task, init.signal)
      if (!result.status || result.redirected || (result.finalUrl && new URL(result.finalUrl).origin !== managed.origin)) {
        throw new Error('The browser request was redirected; credentials were not forwarded')
      }
      const responseHeaders = new Headers(result.headers)
      responseHeaders.delete('content-length')
      responseHeaders.delete('content-encoding')
      responseHeaders.set('x-aimon-browser-fallback', '1')
      responseHeaders.set('x-aimon-browser-ttfb-ms', String(result.ttfbMs))
      if (result.ttftMs != null) responseHeaders.set('x-aimon-browser-ttft-ms', String(result.ttftMs))
      responseHeaders.set('x-aimon-browser-total-ms', String(result.totalMs))
      const cookies = await managed.context.cookies(targetUrl)
      for (const cookie of cookies) {
        const attributes = [
          `${cookie.name}=${cookie.value}`,
          `Path=${cookie.path || '/'}`,
          cookie.domain ? `Domain=${cookie.domain}` : '',
          cookie.expires > 0 ? `Expires=${new Date(cookie.expires * 1000).toUTCString()}` : '',
          cookie.httpOnly ? 'HttpOnly' : '',
          cookie.secure ? 'Secure' : '',
          cookie.sameSite ? `SameSite=${cookie.sameSite}` : '',
        ].filter(Boolean)
        responseHeaders.append('set-cookie', attributes.join('; '))
      }
      await sessionFrom(managed, targetUrl)
      const noBody = ['HEAD'].includes((init.method || 'GET').toUpperCase()) || [204, 205, 304].includes(result.status)
      return new Response(noBody ? null : result.text, {
        status: result.status,
        statusText: result.statusText,
        headers: responseHeaders,
      })
    } finally {
      await page?.close().catch(() => undefined)
      managed.activeRequests -= 1
      touch(managed)
    }
  }, init.signal)
}

async function turnstileToken(page: Page): Promise<string> {
  const selector = 'textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"]'
  const field = page.locator(selector).first()
  try {
    await field.waitFor({ state: 'attached', timeout: 5_000 })
  } catch {
    return ''
  }
  try {
    await page.waitForFunction((candidate) => {
      const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(candidate)
      return Boolean(element?.value)
    }, selector, { timeout: config.cloakBrowserTimeoutMs })
    return await field.inputValue()
  } catch {
    throw new Error('The site requires an interactive Turnstile challenge that could not be completed automatically; use manual API Key mode')
  }
}

function loginError(raw: any, status: number): string {
  return String(raw?.message || raw?.msg || raw?.error?.message || raw?.error || `Login failed (HTTP ${status})`)
}

export async function browserLogin(
  type: 'newapi' | 'sub2api',
  baseUrl: string,
  credentials: Credentials,
): Promise<RemoteAuth> {
  const origin = originOf(baseUrl)
  const loginPath = type === 'newapi' ? '/sign-in' : '/login'
  const managed = await managedFor(baseUrl, `${origin}${loginPath}`)
  return managed.loginGate.run(async () => {
    managed.activeRequests += 1
    let page: Page | undefined
    try {
      page = await managed.context.newPage()
      let loginResponse = await page.goto(`${origin}${loginPath}`, {
        waitUntil: 'domcontentloaded',
        timeout: config.cloakBrowserTimeoutMs,
      })
      if (new URL(page.url()).origin !== origin) throw new Error('Login navigation left the configured site origin')

      if (type === 'newapi') {
        const usernameField = page.locator('[name="username"]').first()
        const modernPageReady = await usernameField.waitFor({ state: 'attached', timeout: 3_000 })
          .then(() => true, () => false)
        if (!modernPageReady || loginResponse?.status() === 404) {
          loginResponse = await page.goto(`${origin}/login`, {
            waitUntil: 'domcontentloaded',
            timeout: config.cloakBrowserTimeoutMs,
          })
          if (loginResponse && loginResponse.status() >= 400) throw new Error(`New API login page returned HTTP ${loginResponse.status()}`)
          await page.locator('[name="username"]').first().waitFor({ state: 'attached', timeout: 5_000 }).catch(() => undefined)
        }
        await page.locator('[name="username"]').first().fill(credentials.username).catch(() => undefined)
        await page.locator('[name="password"]').first().fill(credentials.password).catch(() => undefined)
        await page.locator('#legal-consent').check({ force: true }).catch(() => undefined)
      } else {
        await page.locator('#email').fill(credentials.username).catch(() => undefined)
        await page.locator('#password').fill(credentials.password).catch(() => undefined)
        await page.locator('#login-agreement-consent').check({ force: true }).catch(() => undefined)
      }

      const token = await turnstileToken(page)
      const result = await page.evaluate(async ({ provider, username, password, turnstile }) => {
        const url = provider === 'newapi'
          ? `/api/user/login${turnstile ? `?turnstile=${encodeURIComponent(turnstile)}` : ''}`
          : '/api/v1/auth/login'
        const body = provider === 'newapi'
          ? { username, password }
          : { email: username, password, turnstile_token: turnstile }
        const response = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const text = await response.text()
        let raw: any = null
        try { raw = text ? JSON.parse(text) : null } catch { /* handled by caller */ }
        return { status: response.status, ok: response.ok, raw, text }
      }, { provider: type, username: credentials.username, password: credentials.password, turnstile: token })

      if (!result.ok || !result.raw) throw new Error(loginError(result.raw, result.status) || result.text.slice(0, 200))
      const data = result.raw?.data ?? result.raw
      if (data?.require_2fa || data?.requires_2fa) throw new Error('This account has two-factor authentication enabled, which automatic login does not support')
      if (type === 'sub2api') {
        if (typeof result.raw?.code === 'number' && result.raw.code !== 0) throw new Error(loginError(result.raw, result.status))
        if (!data?.access_token) throw new Error('Sub2API browser login succeeded but returned no access token')
        return {
          accessToken: data.access_token,
          userId: data?.user?.id != null ? String(data.user.id) : undefined,
        }
      }

      if (result.raw?.success === false) throw new Error(loginError(result.raw, result.status))
      const user = data?.user || data
      const session = await sessionFrom(managed, `${origin}/api/user/self`)
      const accessToken = data?.access_token
      if (!accessToken && !session.cookie) throw new Error('New API browser login succeeded but returned no usable session')
      return {
        accessToken,
        cookie: session.cookie,
        userId: user?.id != null ? String(user.id) : undefined,
      }
    } catch (error) {
      throw new Error(`CloakBrowser login failed: ${safeError(error)}`)
    } finally {
      await page?.close().catch(() => undefined)
      managed.activeRequests -= 1
      touch(managed)
    }
  })
}

export async function closeAllBrowserSessions(): Promise<void> {
  await Promise.all([...contexts.keys()].map((origin) => closeManaged(origin, true)))
  sessions.clear()
}

if (process.env.NODE_ENV !== 'test') {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void closeAllBrowserSessions().finally(() => process.exit(0))
    })
  }
}
