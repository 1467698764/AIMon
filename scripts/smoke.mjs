import process from 'node:process'

const rawBaseUrl = process.argv[2] || process.env.AIMON_URL
if (!rawBaseUrl) {
  console.error('Usage: npm run smoke -- https://aimon.example.com')
  process.exit(1)
}

let baseUrl
try {
  baseUrl = new URL(rawBaseUrl)
} catch {
  console.error('The deployment URL is invalid')
  process.exit(1)
}

if (!['http:', 'https:'].includes(baseUrl.protocol)) {
  console.error('The deployment URL must use HTTP or HTTPS')
  process.exit(1)
}
const basePath = baseUrl.pathname.replace(/\/+$/, '')

const basicUser = process.env.AIMON_BASIC_USER || ''
const basicPassword = process.env.AIMON_BASIC_PASSWORD || ''
const headers = {}
if (basicUser && basicPassword) {
  headers.Authorization = `Basic ${Buffer.from(`${basicUser}:${basicPassword}`).toString('base64')}`
}

async function get(pathname) {
  const requestUrl = new URL(baseUrl)
  requestUrl.pathname = `${basePath}${pathname}`
  requestUrl.search = ''
  requestUrl.hash = ''
  const response = await fetch(requestUrl, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  })
  return response
}

try {
  const statusResponse = await get('/api/auth/status')
  if (!statusResponse.ok) throw new Error(`/api/auth/status returned HTTP ${statusResponse.status}`)
  const status = await statusResponse.json().catch(() => null)
  if (typeof status?.configured !== 'boolean' || typeof status?.authenticated !== 'boolean') {
    throw new Error('/api/auth/status did not return the expected AIMon JSON payload')
  }
  if (!/no-store/i.test(statusResponse.headers.get('cache-control') || '')) {
    throw new Error('/api responses are missing Cache-Control: no-store')
  }
  console.log(`[PASS] API responded; management password configured: ${status.configured ? 'yes' : 'no'}`)

  const pageResponse = await get('/')
  if (!pageResponse.ok) throw new Error(`/ returned HTTP ${pageResponse.status}`)
  const contentType = pageResponse.headers.get('content-type') || ''
  if (!contentType.includes('text/html')) throw new Error(`/ returned an unexpected Content-Type: ${contentType || '(missing)'}`)
  const html = await pageResponse.text()
  if (!html.includes('<div id="root"')) throw new Error('/ does not look like the AIMon web application')
  console.log('[PASS] Web application shell responded')

  for (const header of ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy']) {
    if (!pageResponse.headers.has(header)) throw new Error(`security response header is missing: ${header}`)
  }
  console.log('[PASS] Security response headers are present')

  const local = ['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname)
  if (baseUrl.protocol !== 'https:' && !local) console.warn('[WARN] Public deployment is not using HTTPS')
  console.log('\nSmoke test passed')
} catch (cause) {
  console.error(`[FAIL] ${cause instanceof Error ? cause.message : String(cause)}`)
  process.exitCode = 1
}
