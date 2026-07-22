import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.js'
import { prepareDataDirectory } from './storage.js'

prepareDataDirectory(config.dataDir, config.requirePersistentData)

export const db = new DatabaseSync(path.join(config.dataDir, 'aimon.sqlite'))
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username_enc TEXT,
    password_enc TEXT,
    admin_password_hash TEXT,
    admin_password_version INTEGER NOT NULL DEFAULT 0,
    auto_check_minutes INTEGER NOT NULL DEFAULT 0,
    health_attempts INTEGER NOT NULL DEFAULT 3,
    last_auto_check_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  INSERT OR IGNORE INTO settings (id) VALUES (1);

  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL UNIQUE,
    type TEXT CHECK (type IN ('newapi', 'sub2api')),
    username_enc TEXT,
    password_enc TEXT,
    balance REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    recharge_ratio REAL NOT NULL DEFAULT 1,
    connection_mode TEXT NOT NULL DEFAULT 'auto' CHECK (connection_mode IN ('auto', 'manual')),
    config_revision INTEGER NOT NULL DEFAULT 1,
    configured INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    expanded INTEGER NOT NULL DEFAULT 1,
    last_sync_at TEXT,
    last_check_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS site_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    name TEXT NOT NULL,
    ratio REAL NOT NULL DEFAULT 1,
    ratio_dynamic INTEGER NOT NULL DEFAULT 0,
    platform TEXT,
    api_key_enc TEXT,
    api_key_external_id TEXT,
    selected INTEGER NOT NULL DEFAULT 0,
    available INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    expanded INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(site_id, external_id)
  );

  CREATE TABLE IF NOT EXISTS models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES site_groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    endpoint_types_json TEXT NOT NULL DEFAULT '[]',
    selected INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE(group_id, name)
  );

  CREATE TABLE IF NOT EXISTS health_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    success_count INTEGER NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 3,
    avg_ttfb_ms REAL,
    avg_ttft_ms REAL,
    avg_total_ms REAL,
    config_revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts_json TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS site_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('newapi', 'sub2api')),
    username_enc TEXT,
    password_enc TEXT,
    balance REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    recharge_ratio REAL NOT NULL DEFAULT 1,
    connection_mode TEXT NOT NULL DEFAULT 'auto' CHECK (connection_mode IN ('auto', 'manual')),
    site_config_revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS draft_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id INTEGER NOT NULL REFERENCES site_drafts(id) ON DELETE CASCADE,
    source_group_id INTEGER REFERENCES site_groups(id) ON DELETE SET NULL,
    external_id TEXT NOT NULL,
    name TEXT NOT NULL,
    ratio REAL NOT NULL DEFAULT 1,
    ratio_dynamic INTEGER NOT NULL DEFAULT 0,
    platform TEXT,
    api_key_enc TEXT,
    api_key_external_id TEXT,
    selected INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE(draft_id, external_id)
  );

  CREATE TABLE IF NOT EXISTS draft_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_group_id INTEGER NOT NULL REFERENCES draft_groups(id) ON DELETE CASCADE,
    source_model_id INTEGER REFERENCES models(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    endpoint_types_json TEXT NOT NULL DEFAULT '[]',
    selected INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE(draft_group_id, name)
  );

  CREATE INDEX IF NOT EXISTS idx_groups_site ON site_groups(site_id, selected, sort_order);
  CREATE INDEX IF NOT EXISTS idx_models_group ON models(group_id, selected, sort_order);
  CREATE INDEX IF NOT EXISTS idx_checks_model ON health_checks(model_id, checked_at DESC);
  CREATE INDEX IF NOT EXISTS idx_drafts_site ON site_drafts(site_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_draft_groups ON draft_groups(draft_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_draft_models ON draft_models(draft_group_id, sort_order);
`)

// A process restart must not leave checks looking permanently active.
db.prepare(`
  UPDATE health_checks SET status = 'failed', checked_at = ?, attempts_json = ? WHERE status = 'pending'
`).run(new Date().toISOString(), JSON.stringify([{ ok: false, error: '服务重启，测活任务未完成' }]))

for (const statement of [
  'ALTER TABLE settings ADD COLUMN auto_check_minutes INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE settings ADD COLUMN health_attempts INTEGER NOT NULL DEFAULT 3',
  'ALTER TABLE settings ADD COLUMN last_auto_check_at TEXT',
  'ALTER TABLE settings ADD COLUMN admin_password_hash TEXT',
  'ALTER TABLE settings ADD COLUMN admin_password_version INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE site_groups ADD COLUMN available INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE sites ADD COLUMN configured INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE site_groups ADD COLUMN ratio_dynamic INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE draft_groups ADD COLUMN ratio_dynamic INTEGER NOT NULL DEFAULT 0',
  `ALTER TABLE models ADD COLUMN endpoint_types_json TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE draft_models ADD COLUMN endpoint_types_json TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE sites ADD COLUMN connection_mode TEXT NOT NULL DEFAULT 'auto'`,
  `ALTER TABLE site_drafts ADD COLUMN connection_mode TEXT NOT NULL DEFAULT 'auto'`,
  `ALTER TABLE site_drafts ADD COLUMN site_config_revision INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE sites ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE health_checks ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1`,
]) {
  try {
    db.exec(statement)
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('duplicate column name')) throw error
  }
}

// Drafts can contain encrypted credentials and API keys. Remove abandoned
// drafts after a day so interrupted browser sessions do not retain them forever.
db.prepare(`
  DELETE FROM site_drafts
  WHERE julianday(updated_at) < julianday('now', '-1 day')
`).run()

export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}
