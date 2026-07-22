import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import express, { type ErrorRequestHandler } from 'express'
import { ZodError } from 'zod'
import { config } from './config.js'
import authRoutes from './auth-routes.js'
import { AuthError, requireAppAuth } from './auth.js'
import routes from './routes.js'
import { startAutoHealthScheduler } from './health.js'
import { redactSensitiveText, sensitiveValues } from './privacy.js'

export const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '))
  next()
})
if (config.basicAuthUser || config.basicAuthPassword) {
  if (!config.basicAuthUser || !config.basicAuthPassword) throw new Error('AIMON_BASIC_USER 与 AIMON_BASIC_PASSWORD 必须同时设置')
  app.use((req, res, next) => {
    const encoded = req.headers.authorization?.startsWith('Basic ') ? req.headers.authorization.slice(6) : ''
    const decoded = Buffer.from(encoded, 'base64').toString('utf8')
    const expected = `${config.basicAuthUser}:${config.basicAuthPassword}`
    const actualBuffer = Buffer.from(decoded)
    const expectedBuffer = Buffer.from(expected)
    if (actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)) {
      next(); return
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="AIMon", charset="UTF-8"')
    res.status(401).send('Authentication required')
  })
}
app.use(express.json({ limit: '1mb' }))
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Pragma', 'no-cache')
  next()
})
app.use('/api/auth', authRoutes)
app.use('/api', requireAppAuth, routes)
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found' })
})

if (config.isProduction) {
  const dist = path.resolve('dist')
  app.use(express.static(dist, {
    index: false,
    setHeaders: (res, filePath) => {
      if (path.basename(filePath) === 'index.html') {
        res.setHeader('Cache-Control', 'no-store')
      } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      } else {
        res.setHeader('Cache-Control', 'no-cache')
      }
    },
  }))
  app.get('*splat', (req, res) => {
    if (req.path.startsWith('/assets/')) {
      res.status(404).end()
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    res.sendFile(path.join(dist, 'index.html'))
  })
}

const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({ error: error.issues[0]?.message || '请求参数错误' })
    return
  }
  if (error instanceof AuthError) {
    res.status(error.status).json({ error: error.message })
    return
  }
  if (error && typeof error === 'object' && 'type' in error) {
    if (error.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Malformed JSON request body' })
      return
    }
    if (error.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request body is too large' })
      return
    }
  }
  const secrets = sensitiveValues(req.body)
  const message = redactSensitiveText(error instanceof Error ? error.message : '服务器内部错误', secrets)
  console.error(redactSensitiveText(error instanceof Error ? error.stack || error.message : error, secrets))
  res.status(500).json({ error: message })
}
app.use(errorHandler)

if (process.env.NODE_ENV !== 'test') {
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`AIMon API listening on http://0.0.0.0:${config.port}`)
  })
  startAutoHealthScheduler()
}
