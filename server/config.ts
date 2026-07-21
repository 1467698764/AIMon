import path from 'node:path'

function positiveNumber(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value ?? fallback)
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback
}

const isProduction = process.env.NODE_ENV === 'production'
const secret = process.env.AIMON_SECRET || 'aimon-development-only-change-me'

if (isProduction && secret === 'aimon-development-only-change-me') {
  throw new Error('生产环境必须设置 AIMON_SECRET')
}

const basicAuthUser = process.env.AIMON_BASIC_USER || ''
const basicAuthPassword = process.env.AIMON_BASIC_PASSWORD || ''
const allowUnauthenticated = process.env.ALLOW_UNAUTHENTICATED === 'true'
if (isProduction && !allowUnauthenticated && (!basicAuthUser || !basicAuthPassword)) {
  throw new Error('生产环境必须设置 AIMON_BASIC_USER 与 AIMON_BASIC_PASSWORD；仅限受保护内网可显式设置 ALLOW_UNAUTHENTICATED=true')
}

export const config = {
  port: Number(process.env.PORT || 8787),
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  secret,
  requestTimeoutMs: positiveNumber(process.env.REQUEST_TIMEOUT_MS, 30_000, 1_000),
  healthAttempts: Math.floor(positiveNumber(process.env.HEALTH_ATTEMPTS, 3, 1)),
  basicAuthUser,
  basicAuthPassword,
  allowUnauthenticated,
  cloakBrowserEnabled: process.env.CLOAKBROWSER_ENABLED !== 'false',
  cloakBrowserHeadless: process.env.CLOAKBROWSER_HEADLESS !== 'false',
  cloakBrowserTimeoutMs: positiveNumber(process.env.CLOAKBROWSER_TIMEOUT_MS, 60_000, 10_000),
  cloakBrowserIdleMs: positiveNumber(process.env.CLOAKBROWSER_IDLE_MS, 5 * 60_000, 60_000),
  cloakBrowserMaxContexts: Math.floor(positiveNumber(process.env.CLOAKBROWSER_MAX_CONTEXTS, 4, 1)),
  cloakBrowserProxy: process.env.CLOAKBROWSER_PROXY || '',
  isProduction,
}
