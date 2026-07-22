import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const cwd = process.cwd()
const envFile = path.join(cwd, '.env')
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile)

const errors = []
const warnings = []
const passes = []

function pass(message) {
  passes.push(message)
}

function error(message) {
  errors.push(message)
}

function warn(message) {
  warnings.push(message)
}

function checkInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name]
  if (!raw) {
    pass(`${name} uses default ${fallback}`)
    return
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    error(`${name} must be an integer between ${minimum} and ${maximum}`)
  } else {
    pass(`${name} is valid`)
  }
}

const [major, minor] = process.versions.node.split('.').map(Number)
if (major > 22 || (major === 22 && minor >= 5)) pass(`Node.js ${process.versions.node}`)
else error(`Node.js 22.5 or newer is required; current version is ${process.versions.node}`)

if (fs.existsSync(envFile)) pass('.env is present')
else warn('.env is absent; Docker Compose deployment should start from .env.example')

const secret = process.env.AIMON_SECRET || ''
if (!secret) {
  error('AIMON_SECRET is missing')
} else if (secret === 'replace-with-at-least-32-random-characters' || secret === 'replace-me') {
  error('AIMON_SECRET still contains a documented placeholder')
} else if (secret.length < 32) {
  error('AIMON_SECRET must contain at least 32 characters')
} else {
  pass('AIMON_SECRET is configured (value hidden)')
}

const bootstrapPassword = process.env.AIMON_BOOTSTRAP_PASSWORD || ''
if (!bootstrapPassword) warn('AIMON_BOOTSTRAP_PASSWORD is empty; protect first-time setup before exposing the service')
else if (bootstrapPassword.length < 8 || bootstrapPassword.length > 200) error('AIMON_BOOTSTRAP_PASSWORD must contain 8 to 200 characters')
else pass('AIMON_BOOTSTRAP_PASSWORD is configured (value hidden)')

const basicUser = process.env.AIMON_BASIC_USER || ''
const basicPassword = process.env.AIMON_BASIC_PASSWORD || ''
if (Boolean(basicUser) !== Boolean(basicPassword)) error('AIMON_BASIC_USER and AIMON_BASIC_PASSWORD must be set together')
else if (basicUser) pass('HTTP Basic Auth is configured (values hidden)')
else warn('HTTP Basic Auth is disabled; the in-app management password remains required')

if (process.env.AIMON_ALLOW_PRIVATE_NETWORK === 'true') {
  warn('AIMON_ALLOW_PRIVATE_NETWORK is enabled; only trusted administrators should be able to configure Base URLs')
} else {
  pass('Private-network and cloud-metadata destinations remain blocked in production')
}

checkInteger('PORT', 8787, 1, 65535)
checkInteger('REQUEST_TIMEOUT_MS', 30000, 1000, 600000)
checkInteger('CLOAKBROWSER_TIMEOUT_MS', 60000, 10000, 600000)
checkInteger('CLOAKBROWSER_IDLE_MS', 180000, 60000, 86400000)
checkInteger('CLOAKBROWSER_MAX_CONTEXTS', 2, 1, 32)

const dataDir = path.resolve(process.env.DATA_DIR || './data')
try {
  fs.mkdirSync(dataDir, { recursive: true })
  const probe = path.join(dataDir, `.aimon-doctor-${process.pid}`)
  fs.writeFileSync(probe, 'ok', { flag: 'wx', mode: 0o600 })
  fs.rmSync(probe)
  pass(`DATA_DIR is writable: ${dataDir}`)
} catch (cause) {
  error(`DATA_DIR is not writable: ${cause instanceof Error ? cause.message : String(cause)}`)
}

const gitignore = fs.existsSync(path.join(cwd, '.gitignore')) ? fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8') : ''
if (/^\.env\s*$/m.test(gitignore) && /^data\/\s*$/m.test(gitignore) && /^backups\/\s*$/m.test(gitignore)) {
  pass('.gitignore protects .env, data/, and backups/')
} else {
  error('.gitignore must exclude .env, data/, and backups/')
}

for (const message of passes) console.log(`[PASS] ${message}`)
for (const message of warnings) console.warn(`[WARN] ${message}`)
for (const message of errors) console.error(`[FAIL] ${message}`)
console.log(`\nDoctor result: ${passes.length} passed, ${warnings.length} warning(s), ${errors.length} failure(s)`)
if (errors.length) process.exitCode = 1
