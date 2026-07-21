import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import request from 'supertest'

const dataDir = path.resolve('./data/test-auth-bootstrap')
fs.rmSync(dataDir, { recursive: true, force: true })
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.AIMON_SECRET = 'auth-bootstrap-integration-secret-2026'
process.env.AIMON_BOOTSTRAP_PASSWORD = 'bootstrap-password'

const { app } = await import('../server/index.js')
const { db } = await import('../server/db.js')

const anonymous = request(app)
let response = await anonymous.get('/api/auth/status')
assert.deepEqual(response.body, { configured: true, authenticated: false })

response = await anonymous.post('/api/auth/setup').send({ password: 'claimed-password' })
assert.equal(response.status, 409)

await anonymous.post('/api/auth/login').send({ password: 'wrong-password' }).expect(401)

const session = request.agent(app)
await session.post('/api/auth/login').send({ password: 'bootstrap-password' }).expect(200)
await session.get('/api/dashboard').expect(200)

await session.post('/api/auth/password').send({
  currentPassword: 'bootstrap-password',
  newPassword: 'replacement-password',
}).expect(200)
await session.post('/api/auth/logout').expect(204)
await session.post('/api/auth/login').send({ password: 'bootstrap-password' }).expect(401)
await session.post('/api/auth/login').send({ password: 'replacement-password' }).expect(200)

db.close()
fs.rmSync(dataDir, { recursive: true, force: true })
console.log('bootstrap auth integration test passed')
