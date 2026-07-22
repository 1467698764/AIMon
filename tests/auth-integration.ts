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
assert.equal(response.headers['cache-control'], 'no-store')
assert.match(String(response.headers['content-security-policy']), /default-src 'self'/)
assert.equal(response.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=()')

response = await anonymous.get('/api/dashboard')
assert.equal(response.status, 428)

response = await anonymous
  .post('/api/auth/login')
  .set('Content-Type', 'application/json')
  .send('{broken json')
assert.equal(response.status, 400)
assert.equal(response.body.error, 'Malformed JSON request body')

response = await anonymous.post('/api/auth/setup').send({ password: 'short' })
assert.equal(response.status, 400)

const session = request.agent(app)
response = await session.post('/api/auth/setup').send({ password: 'first-password' })
assert.equal(response.status, 200)

response = await session.get('/api/dashboard')
assert.equal(response.status, 200)

response = await session.get('/api/does-not-exist')
assert.equal(response.status, 404)
assert.equal(response.body.error, 'API endpoint not found')

response = await session.get('/api/sites/not-a-number')
assert.equal(response.status, 400)

response = await session.post('/api/drafts/1/configure').send({
  runHealth: false,
  selections: [
    { groupId: 2, modelIds: [3] },
    { groupId: 2, modelIds: [4] },
  ],
})
assert.equal(response.status, 400)

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

for (let attempt = 0; attempt < 5; attempt += 1) {
  await session.post('/api/auth/password')
    .send({ currentPassword: 'wrong-current-password', newPassword: 'third-password' })
    .expect(401)
}
await session.post('/api/auth/password')
  .send({ currentPassword: 'second-password', newPassword: 'third-password' })
  .expect(429)

const attackerIp = '203.0.113.45'
for (let attempt = 0; attempt < 5; attempt += 1) {
  await anonymous.post('/api/auth/login')
    .set('X-Forwarded-For', attackerIp)
    .send({ password: 'wrong-password' })
    .expect(401)
}
await anonymous.post('/api/auth/login')
  .set('X-Forwarded-For', attackerIp)
  .send({ password: 'second-password' })
  .expect(429)

db.close()
fs.rmSync(dataDir, { recursive: true, force: true })
console.log('auth integration test passed')
