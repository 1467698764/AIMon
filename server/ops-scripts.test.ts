import { execFile, execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const projectRoot = path.resolve(import.meta.dirname, '..')
const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aimon-ops-test-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('operations scripts', () => {
  it('validates deployment configuration without printing secrets', () => {
    const dataDir = path.join(temporaryDirectory(), 'data')
    const secret = 'doctor-secret-0123456789abcdef0123456789'
    const result = spawnSync(process.execPath, ['scripts/doctor.mjs'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        AIMON_SECRET: secret,
        AIMON_BOOTSTRAP_PASSWORD: 'doctor-password',
        DATA_DIR: dataDir,
      },
    })

    expect(result.status).toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('Doctor result:')
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret)
    expect(`${result.stdout}${result.stderr}`).not.toContain('doctor-password')
  })

  it('keeps doctor usable in a runtime image that does not contain repository metadata', () => {
    const runtimeRoot = temporaryDirectory()
    const result = spawnSync(process.execPath, [path.join(projectRoot, 'scripts/doctor.mjs')], {
      cwd: runtimeRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        AIMON_SECRET: 'runtime-secret-0123456789abcdef0123456789',
        AIMON_BOOTSTRAP_PASSWORD: 'runtime-password',
        DATA_DIR: path.join(runtimeRoot, 'data'),
      },
    })

    expect(result.status).toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('.gitignore is unavailable')
  })

  it('creates a readable SQLite snapshot without embedding AIMON_SECRET', () => {
    const root = temporaryDirectory()
    const dataDir = path.join(root, 'data')
    const outputDir = path.join(root, 'backups')
    fs.mkdirSync(dataDir)

    execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('CREATE TABLE sample (value TEXT)'); db.prepare('INSERT INTO sample VALUES (?)').run('preserved'); db.close()",
      path.join(dataDir, 'aimon.sqlite'),
    ])

    execFileSync(process.execPath, ['scripts/backup.mjs', '--data-dir', dataDir, '--output', outputDir], {
      cwd: projectRoot,
      env: { ...process.env, AIMON_SECRET: 'must-not-enter-backup' },
    })

    const backupDirectory = path.join(outputDir, fs.readdirSync(outputDir)[0])
    const snapshotValue = execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1], { readOnly: true }); process.stdout.write(String(db.prepare('SELECT value FROM sample').get().value)); db.close()",
      path.join(backupDirectory, 'aimon.sqlite'),
    ], { encoding: 'utf8' })
    expect(snapshotValue).toBe('preserved')

    const manifest = fs.readFileSync(path.join(backupDirectory, 'manifest.json'), 'utf8')
    expect(manifest).toContain('"includesEncryptionSecret": false')
    expect(manifest).not.toContain('must-not-enter-backup')
  })

  it('creates separate, complete destinations for concurrent backups', async () => {
    const root = temporaryDirectory()
    const dataDir = path.join(root, 'data')
    const outputDir = path.join(root, 'backups')
    fs.mkdirSync(dataDir)
    execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('CREATE TABLE sample (value TEXT)'); db.close()",
      path.join(dataDir, 'aimon.sqlite'),
    ])

    const command = [path.join(projectRoot, 'scripts/backup.mjs'), '--data-dir', dataDir, '--output', outputDir]
    await Promise.all([
      execFileAsync(process.execPath, command, { cwd: projectRoot }),
      execFileAsync(process.execPath, command, { cwd: projectRoot }),
    ])

    const entries = fs.readdirSync(outputDir)
    expect(entries).toHaveLength(2)
    expect(entries.every((entry) => entry.startsWith('aimon-backup-'))).toBe(true)
    for (const entry of entries) {
      expect(fs.existsSync(path.join(outputDir, entry, 'aimon.sqlite'))).toBe(true)
      expect(fs.existsSync(path.join(outputDir, entry, 'manifest.json'))).toBe(true)
    }
  })

  it('checks the API, application shell, caching, and security headers', async () => {
    const server = http.createServer((request, response) => {
      response.setHeader('Content-Security-Policy', "default-src 'self'")
      response.setHeader('X-Content-Type-Options', 'nosniff')
      response.setHeader('X-Frame-Options', 'DENY')
      response.setHeader('Referrer-Policy', 'same-origin')
      if (request.url === '/api/auth/status') {
        response.setHeader('Cache-Control', 'no-store')
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ configured: true, authenticated: false }))
        return
      }
      response.setHeader('Content-Type', 'text/html')
      response.end('<!doctype html><div id="root"></div>')
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP port')
      const result = await execFileAsync(process.execPath, ['scripts/smoke.mjs', `http://127.0.0.1:${address.port}`], {
        cwd: projectRoot,
      })
      expect(result.stdout).toContain('Smoke test passed')
    } finally {
      await new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()))
    }
  })

  it('keeps the container healthcheck valid when Basic Auth is enabled', async () => {
    const user = 'health-user'
    const password = 'health-password'
    const expectedAuthorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
    const server = http.createServer((request, response) => {
      if (request.headers.authorization !== expectedAuthorization) {
        response.statusCode = 401
        response.end()
        return
      }
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ configured: true, authenticated: false }))
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP port')
      await expect(execFileAsync(process.execPath, ['scripts/healthcheck.mjs'], {
        cwd: projectRoot,
        env: {
          ...process.env,
          PORT: String(address.port),
          AIMON_BASIC_USER: user,
          AIMON_BASIC_PASSWORD: password,
        },
      })).resolves.toBeDefined()
    } finally {
      await new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()))
    }
  })

  it('fails the healthcheck immediately when PORT is invalid', () => {
    const result = spawnSync(process.execPath, ['scripts/healthcheck.mjs'], {
      cwd: projectRoot,
      env: { ...process.env, PORT: 'invalid' },
    })
    expect(result.status).toBe(1)
  })

  it('fails server configuration fast when PORT is invalid', () => {
    const result = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e', "await import('./server/config.ts')",
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, PORT: 'invalid' },
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('PORT must be an integer')
  })

  it('accepts an explicit reverse-proxy hop count', () => {
    const result = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e', "const { config } = await import('./server/config.ts'); console.log(config.trustProxy)",
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, AIMON_TRUST_PROXY: '2' },
    })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('2')
  })
})
