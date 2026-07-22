import assert from 'node:assert/strict'

const { db } = await import('../server/db.js')
const mode = process.argv[2]

if (mode === 'write') {
  db.prepare(`
    UPDATE settings SET username_enc = ?, auto_check_minutes = ?, health_attempts = ?, admin_password_hash = ? WHERE id = 1
  `).run('persisted-username', 37, 6, 'persisted-password-hash')
} else if (mode === 'read') {
  const settings = db.prepare(`
    SELECT username_enc, auto_check_minutes, health_attempts, admin_password_hash FROM settings WHERE id = 1
  `).get() as Record<string, unknown>
  assert.equal(settings.username_enc, 'persisted-username')
  assert.equal(settings.auto_check_minutes, 37)
  assert.equal(settings.health_attempts, 6)
  assert.equal(settings.admin_password_hash, 'persisted-password-hash')
} else {
  throw new Error(`unknown persistence worker mode: ${mode}`)
}

db.close()
