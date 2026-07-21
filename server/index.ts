import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import express, { type ErrorRequestHandler } from 'express'
import { ZodError } from 'zod'
import { config } from './config.js'
import authRoutes from './auth-routes.js'
import { AuthError, requireAppAuth } from './auth.js'
import routes from './routes.js'
import { startAutoHealthScheduler } from './health.js'

export const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'same-origin')
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
app.use('/api/auth', authRoutes)
app.use('/api', requireAppAuth, routes)

if (config.isProduction) {
  const dist = path.resolve('dist')
  app.use(express.static(dist, { maxAge: '1h', index: false }))
  app.get('*splat', (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({ error: error.issues[0]?.message || '请求参数错误' })
    return
  }
  if (error instanceof AuthError) {
    res.status(error.status).json({ error: error.message })
    return
  }
  const message = error instanceof Error ? error.message : '服务器内部错误'
  console.error(error)
  res.status(500).json({ error: message })
}
app.use(errorHandler)

if (process.env.NODE_ENV !== 'test') {
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`AIMon API listening on http://0.0.0.0:${config.port}`)
  })
  startAutoHealthScheduler()
}
