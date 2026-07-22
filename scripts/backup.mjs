import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { randomBytes } from 'node:crypto'
import { backup, DatabaseSync } from 'node:sqlite'

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const dataDir = path.resolve(argument('--data-dir') || process.env.DATA_DIR || './data')
const outputRoot = path.resolve(argument('--output') || './backups')
const databasePath = path.join(dataDir, 'aimon.sqlite')

if (!fs.existsSync(databasePath)) {
  console.error(`AIMon database was not found: ${databasePath}`)
  process.exit(1)
}

const relativeOutput = path.relative(dataDir, outputRoot)
if (relativeOutput === '' || (!relativeOutput.startsWith('..') && !path.isAbsolute(relativeOutput))) {
  console.error('Backup output must be outside DATA_DIR to avoid recursive or same-volume snapshots')
  process.exit(1)
}

const stamp = new Date().toISOString().replaceAll(':', '-')
const destination = path.join(outputRoot, `aimon-backup-${stamp}-${randomBytes(4).toString('hex')}`)
fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 })
const temporary = fs.mkdtempSync(path.join(outputRoot, '.aimon-backup-tmp-'))
fs.chmodSync(temporary, 0o700)

try {
  const source = new DatabaseSync(databasePath, { readOnly: true })
  try {
    await backup(source, path.join(temporary, 'aimon.sqlite'))
  } finally {
    source.close()
  }

  for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
    if (entry.name === 'aimon.sqlite' || entry.name === 'aimon.sqlite-wal' || entry.name === 'aimon.sqlite-shm') continue
    const sourcePath = path.join(dataDir, entry.name)
    const destinationPath = path.join(temporary, entry.name)
    fs.cpSync(sourcePath, destinationPath, { recursive: true, errorOnExist: true, verbatimSymlinks: true })
  }

  const manifest = {
    format: 1,
    createdAt: new Date().toISOString(),
    sourceDataDir: dataDir,
    nodeVersion: process.version,
    includesEncryptionSecret: false,
    restoreRequires: ['AIMON_SECRET used by the source deployment'],
  }
  fs.writeFileSync(path.join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, destination)
} catch (error) {
  fs.rmSync(temporary, { recursive: true, force: true })
  throw error
}

console.log(`Backup created: ${destination}`)
console.log('Store the matching AIMON_SECRET separately; it is intentionally not included in this backup.')
