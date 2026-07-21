import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import request from 'supertest'

const dataDir = path.resolve('./data/test-auth')
fs.rmSync(dataDir, { recursive: true, force: true })
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dataDir
process.env.AIMON_SECRET = 'auth-integration-test-secret-2026'

const { app } = await import('../server/index.js')
const { db } = await import('../server/db.js')

const anonymous = request(app)
let response = await anonymous.get('/api/auth/status')
assert.deepEqual(response.body, { configured: false, authenticated: false })

response = await anonymous.get('/api/dashboard')
assert.equal(response.status, 428)

response = await anonymous.post('/api/auth/setup').send({ password: 'short' })
assert.equal(response.status, 400)

const session = request.agent(app)
response = await session.post('/api/auth/setup').send({ password: 'first-password' })
assert.equal(response.status, 200)

response = await session.get('/api/dashboard')
assert.equal(response.status, 200)

response = await anonymous.get('/api/dashboard')
assert.equal(response.status, 401)

const stored = db.prepare('SELECT admin_password_hash FROM settings WHERE id = 1').get() as { admin_password_hash: string }
assert.match(stored.admin_password_hash, /^scrypt\$16384\$/)
assert.ok(!stored.admin_password_hash.includes('first-password'))

response = await session.post('/api/auth/password').send({ currentPassword: 'first-password', newPassword: 'second-password' })
assert.equal(response.status, 200)

await session.post('/api/auth/logout').expect(204)
await session.post('/api/auth/login').send({ password: 'first-password' }).expect(401)
await session.post('/api/auth/login').send({ password: 'second-password' }).expect(200)
await session.get('/api/dashboard').expect(200)

db.close()
fs.rmSync(dataDir, { recursive: true, force: true })
console.log('auth integration test passed')
