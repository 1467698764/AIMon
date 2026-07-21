import path from 'node:path'

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
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 30_000),
  healthAttempts: Math.max(1, Number(process.env.HEALTH_ATTEMPTS || 3)),
  basicAuthUser,
  basicAuthPassword,
  allowUnauthenticated,
  cloakBrowserEnabled: process.env.CLOAKBROWSER_ENABLED !== 'false',
  cloakBrowserHeadless: process.env.CLOAKBROWSER_HEADLESS !== 'false',
  cloakBrowserTimeoutMs: Math.max(10_000, Number(process.env.CLOAKBROWSER_TIMEOUT_MS || 60_000)),
  isProduction,
}
