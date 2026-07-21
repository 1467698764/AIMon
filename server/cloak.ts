import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

export interface BrowserSession {
  cookie: string
  userAgent: string
  expiresAt: number
}

const sessions = new Map<string, BrowserSession>()
const pending = new Map<string, Promise<BrowserSession>>()

function originOf(baseUrl: string): string {
  return new URL(baseUrl).origin
}

export function cachedBrowserSession(baseUrl: string): BrowserSession | undefined {
  const session = sessions.get(originOf(baseUrl))
  if (session && session.expiresAt > Date.now() + 30_000) return session
  if (session) sessions.delete(originOf(baseUrl))
  return undefined
}

export async function isCloudflareChallenge(response: Response): Promise<boolean> {
  if (response.headers.get('cf-mitigated') === 'challenge') return true
  if (![403, 429, 503].includes(response.status)) return false
  const server = response.headers.get('server') || ''
  const text = await response.clone().text().catch(() => '')
  return /cloudflare/i.test(server)
    || /cf-chl-|challenge-platform|just a moment|cloudflare ray id|turnstile/i.test(text)
}

async function acquire(baseUrl: string): Promise<BrowserSession> {
  if (!config.cloakBrowserEnabled) throw new Error('站点触发了 Cloudflare 验证，但 CloakBrowser 已禁用')
  const origin = originOf(baseUrl)
  const profileName = createHash('sha256').update(origin).digest('hex').slice(0, 24)
  const userDataDir = path.join(config.dataDir, 'cloak-profiles', profileName)
  fs.mkdirSync(userDataDir, { recursive: true })

  let context: Awaited<ReturnType<(typeof import('cloakbrowser'))['launchPersistentContext']>> | undefined
  try {
    const { launchPersistentContext } = await import('cloakbrowser')
    context = await launchPersistentContext({
      userDataDir,
      headless: config.cloakBrowserHeadless,
      humanize: true,
      launchOptions: { timeout: config.cloakBrowserTimeoutMs },
    })
    const page = context.pages()[0] || await context.newPage()
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: config.cloakBrowserTimeoutMs })
    const deadline = Date.now() + config.cloakBrowserTimeoutMs
    let lastTitle = ''
    while (Date.now() < deadline) {
      const cookies = await context.cookies(origin)
      const clearance = cookies.find((cookie) => cookie.name === 'cf_clearance')
      lastTitle = await page.title().catch(() => '')
      const stillChallenged = /just a moment|attention required|请稍候|安全验证/i.test(lastTitle)
      if (clearance || !stillChallenged) {
        const userAgent = await page.evaluate(() => navigator.userAgent)
        const cookie = cookies.map((item) => `${item.name}=${item.value}`).join('; ')
        const expires = cookies.map((item) => item.expires > 0 ? item.expires * 1000 : 0).filter(Boolean)
        return {
          cookie,
          userAgent,
          expiresAt: expires.length ? Math.min(...expires) : Date.now() + 30 * 60_000,
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500))
    }
    throw new Error(`Cloudflare 验证未在限定时间内通过${lastTitle ? `（${lastTitle}）` : ''}`)
  } catch (error) {
    throw new Error(`CloakBrowser 无法建立 Cloudflare 会话：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await context?.close().catch(() => undefined)
  }
}

export function refreshBrowserSession(baseUrl: string): Promise<BrowserSession> {
  const origin = originOf(baseUrl)
  sessions.delete(origin)
  const running = pending.get(origin)
  if (running) return running
  const promise = acquire(baseUrl)
    .then((session) => { sessions.set(origin, session); return session })
    .finally(() => pending.delete(origin))
  pending.set(origin, promise)
  return promise
}
