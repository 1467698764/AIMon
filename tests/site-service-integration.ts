import assert from 'node:assert/strict'

process.env.NODE_ENV = 'test'
process.env.DATA_DIR = './data/test-integration'
process.env.AIMON_SECRET = 'test-secret-for-aimon-integration-only'
process.env.CLOAKBROWSER_ENABLED = 'false'

const { db } = await import('../server/db.js')
const {
  configureSite,
  deleteSite,
  discoverSite,
  discardDraft,
  getDashboard,
  getHealthTargets,
  getSiteEditor,
  prepareManualSite,
  refreshHealthMetadata,
  saveSettings,
  updateExpandedBulk,
} = await import('../server/site-service.js')

globalThis.fetch = async () => new Response(JSON.stringify({
  object: 'list',
  data: [
    { id: 'gpt-4o-mini', supported_endpoint_types: ['openai'] },
    { id: 'text-embedding-3-small', supported_endpoint_types: ['embeddings'] },
  ],
}), { status: 200, headers: { 'Content-Type': 'application/json' } })

db.exec('DELETE FROM site_drafts; DELETE FROM sites;')

const draft = await prepareManualSite({
  name: 'Manual relay',
  baseUrl: 'https://manual.example/v1',
  rechargeRatio: 10,
  groups: [
    { name: 'cheap', ratio: 1, apiKey: 'sk-cheap' },
    { name: 'premium', ratio: 2, apiKey: 'sk-premium' },
  ],
})
assert.equal(draft.editor.connectionMode, 'manual')
assert.equal(draft.editor.balanceKnown, false)
assert.equal(draft.groups.length, 2)

const siteId = configureSite(draft.draftId, draft.groups.map((group) => ({
  groupId: group.id,
  modelIds: group.models.map((model) => model.id),
})))
const initial = getDashboard().sites[0]
assert.deepEqual(initial.groups.map((group: any) => group.name), ['cheap', 'premium'])
assert.equal(initial.groups[0].standardRatio, 0.1)
assert.deepEqual(getHealthTargets({ siteId }).map((target: any) => target.apiKey), [
  'sk-cheap', 'sk-cheap', 'sk-premium', 'sk-premium',
])
assert.doesNotMatch(JSON.stringify(getDashboard()), /sk-cheap|sk-premium/)
assert.doesNotMatch(JSON.stringify(getSiteEditor(siteId)), /sk-cheap|sk-premium|"apiKey"/)

const collapsed = updateExpandedBulk([siteId, siteId], false)
assert.equal(collapsed.sites, 1)
assert.equal(collapsed.groups, 2)
assert.equal(getDashboard().sites[0].expanded, false)
assert.ok(getDashboard().sites[0].groups.every((group: any) => group.expanded === false))
assert.throws(
  () => updateExpandedBulk([siteId, 999_999], true),
  /包含不存在或未配置的站点/,
)
assert.equal(getDashboard().sites[0].expanded, false)
assert.ok(getDashboard().sites[0].groups.every((group: any) => group.expanded === false))
updateExpandedBulk([siteId], true)

const edit = await prepareManualSite({
  id: siteId,
  name: 'Manual relay',
  baseUrl: 'https://manual.example',
  rechargeRatio: 10,
  groups: initial.groups.map((group: any) => ({
    id: group.id,
    name: group.name === 'cheap' ? 'budget' : group.name,
    ratio: group.name === 'cheap' ? 1.25 : group.ratio,
  })),
})
discardDraft(edit.draftId)
assert.equal(getDashboard().sites[0].groups[0].name, 'cheap')
assert.equal(getDashboard().sites[0].groups[0].ratio, 1)

let manualRefreshCalls = 0
globalThis.fetch = async () => {
  manualRefreshCalls += 1
  throw new Error('manual sites must not perform metadata login')
}
await refreshHealthMetadata({ siteId })
assert.equal(manualRefreshCalls, 0)

deleteSite(siteId)

saveSettings({ username: 'monitor', password: 'secret', healthAttempts: 4 })
assert.doesNotMatch(JSON.stringify(getDashboard()), /secret/)
const autoSiteId = Number(db.prepare(`
  INSERT INTO sites
    (name, base_url, type, balance, currency, recharge_ratio, connection_mode, configured, config_revision, sort_order)
  VALUES ('Auto relay', 'https://auto.example', 'newapi', 5, 'USD', 2, 'auto', 1, 1, 0)
`).run().lastInsertRowid)
const autoGroupId = Number(db.prepare(`
  INSERT INTO site_groups
    (site_id, external_id, name, ratio, ratio_dynamic, selected, available, sort_order)
  VALUES (?, 'default', 'default', 1, 0, 1, 1, 0)
`).run(autoSiteId).lastInsertRowid)

let remoteRatio = 1.5
globalThis.fetch = async (input) => {
  const url = String(input)
  if (url.endsWith('/api/user/login')) {
    return new Response(JSON.stringify({ success: true, data: { access_token: 'session', user: { id: 9 } } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (url.endsWith('/api/status')) {
    return new Response(JSON.stringify({ success: true, data: { quota_per_unit: 500_000 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (url.endsWith('/api/user/self')) {
    return new Response(JSON.stringify({ success: true, data: { quota: 6_250_000 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (url.endsWith('/api/user/self/groups')) {
    return new Response(JSON.stringify({ success: true, data: { default: { ratio: remoteRatio } } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  throw new Error(`unexpected metadata URL: ${url}`)
}

await refreshHealthMetadata({ groupId: autoGroupId })
let autoSite = db.prepare('SELECT balance FROM sites WHERE id = ?').get(autoSiteId) as Record<string, any>
let autoGroup = db.prepare('SELECT ratio FROM site_groups WHERE id = ?').get(autoGroupId) as Record<string, any>
assert.equal(autoSite.balance, 5)
assert.equal(autoGroup.ratio, 1.5)

remoteRatio = 2
await refreshHealthMetadata({ siteId: autoSiteId })
autoSite = db.prepare('SELECT balance FROM sites WHERE id = ?').get(autoSiteId) as Record<string, any>
autoGroup = db.prepare('SELECT ratio FROM site_groups WHERE id = ?').get(autoGroupId) as Record<string, any>
assert.equal(autoSite.balance, 12.5)
assert.equal(autoGroup.ratio, 2)
assert.equal(getDashboard().settings.healthAttempts, 4)

const defaultCredentialDraft = await discoverSite({
  id: autoSiteId,
  name: 'Auto relay',
  baseUrl: 'https://auto.example',
  useDefaultCredentials: true,
  rechargeRatio: 2,
})
const storedDraftCredentials = db.prepare(
  'SELECT username_enc, password_enc FROM site_drafts WHERE id = ?',
).get(defaultCredentialDraft.draftId) as Record<string, any>
assert.equal(storedDraftCredentials.username_enc, null)
assert.equal(storedDraftCredentials.password_enc, null)
discardDraft(defaultCredentialDraft.draftId)

await assert.rejects(
  discoverSite({
    id: autoSiteId,
    name: 'Moved relay',
    baseUrl: 'https://different-origin.example',
    username: 'monitor',
    useDefaultCredentials: false,
  }),
  /Base URL 已变化/,
)

let releaseSnapshot!: () => void
let snapshotStarted!: () => void
const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve })
const snapshotStartedGate = new Promise<void>((resolve) => { snapshotStarted = resolve })
globalThis.fetch = async (input) => {
  const url = String(input)
  if (url.endsWith('/api/user/login')) {
    return new Response(JSON.stringify({ success: true, data: { access_token: 'session', user: { id: 9 } } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (url.endsWith('/api/status')) {
    return new Response(JSON.stringify({ success: true, data: { quota_per_unit: 500_000 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (url.endsWith('/api/user/self')) {
    return new Response(JSON.stringify({ success: true, data: { quota: 99_000_000 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (url.endsWith('/api/user/self/groups')) {
    snapshotStarted()
    await snapshotGate
    return new Response(JSON.stringify({ success: true, data: { default: { ratio: 99 } } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  throw new Error(`unexpected concurrent metadata URL: ${url}`)
}

const staleRefresh = refreshHealthMetadata({ siteId: autoSiteId })
await snapshotStartedGate
db.prepare('UPDATE sites SET config_revision = config_revision + 1, balance = 44 WHERE id = ?').run(autoSiteId)
db.prepare('UPDATE site_groups SET ratio = 4 WHERE id = ?').run(autoGroupId)
releaseSnapshot()
const staleWarnings = await staleRefresh
autoSite = db.prepare('SELECT balance FROM sites WHERE id = ?').get(autoSiteId) as Record<string, any>
autoGroup = db.prepare('SELECT ratio FROM site_groups WHERE id = ?').get(autoGroupId) as Record<string, any>
assert.equal(autoSite.balance, 44)
assert.equal(autoGroup.ratio, 4)
assert.match(staleWarnings.join('；'), /配置已变化/)

const modelId = Number(db.prepare(`
  INSERT INTO models (group_id, name, selected, sort_order)
  VALUES (?, 'corrupted-history-model', 1, 0)
`).run(autoGroupId).lastInsertRowid)
db.prepare(`
  INSERT INTO health_checks (model_id, checked_at, success_count, attempt_count, config_revision, status, attempts_json)
  VALUES (?, ?, 0, 3, 1, 'failed', 'not-json')
`).run(modelId, new Date().toISOString())
const damagedModel = getDashboard().sites[0].groups[0].models
  .find((model: any) => model.id === modelId)
assert.deepEqual(damagedModel.attempts, [])

globalThis.fetch = async (input) => {
  const url = String(input)
  if (url.endsWith('/v1/models')) {
    return new Response(JSON.stringify({
      object: 'list',
      data: [{ id: 'gpt-4o-mini', supported_endpoint_types: ['openai'] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  throw new Error(`unexpected stale draft URL: ${url}`)
}
const staleDraft = await prepareManualSite({
  id: autoSiteId,
  name: 'Auto relay manual edit',
  baseUrl: 'https://auto.example',
  rechargeRatio: 2,
  groups: [{ id: autoGroupId, name: 'default', ratio: 4, apiKey: 'sk-stale-draft' }],
})
db.prepare('UPDATE sites SET config_revision = config_revision + 1 WHERE id = ?').run(autoSiteId)
assert.throws(
  () => configureSite(staleDraft.draftId, staleDraft.groups.map((group) => ({
    groupId: group.id,
    modelIds: group.models.map((model) => model.id),
  }))),
  /其他页面发生变化/,
)
discardDraft(staleDraft.draftId)

deleteSite(autoSiteId)
console.log('site service integration test passed')
