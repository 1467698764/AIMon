import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimon-db-persistence-'))
const worker = path.resolve('tests/db-persistence-worker.ts')
const env = {
  ...process.env,
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  AIMON_SECRET: 'db-persistence-integration-secret',
  REQUIRE_PERSISTENT_DATA: 'false',
}

function run(mode: 'write' | 'read'): void {
  const result = spawnSync(process.execPath, ['--import', 'tsx', worker, mode], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `${mode} process failed:\n${result.stdout}\n${result.stderr}`)
}

try {
  run('write')
  assert.ok(fs.existsSync(path.join(dataDir, 'aimon.sqlite')))
  run('read')
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true })
}

console.log('database restart persistence test passed')
