import process from 'node:process'

const user = process.env.AIMON_BASIC_USER || ''
const password = process.env.AIMON_BASIC_PASSWORD || ''
const headers = {}
if (user && password) {
  headers.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
}

try {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || 8787}/api/auth/status`, {
    headers,
    signal: AbortSignal.timeout(4_000),
  })
  if (!response.ok) process.exitCode = 1
} catch {
  process.exitCode = 1
}
