import assert from 'node:assert/strict'

process.env.NODE_ENV = 'test'
process.env.DATA_DIR = './data/test-integration'
process.env.AIMON_SECRET = 'test-secret-for-aimon-integration-only'
process.env.CLOAKBROWSER_ENABLED = 'false'

const { db } = await import('../server/db.js')
const {
  configureSite,
  deleteSite,
  discardDraft,
  getDashboard,
  getHealthTargets,
  prepareManualSite,
  refreshHealthMetadata,
  saveSettings,
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

deleteSite(autoSiteId)
console.log('site service integration test passed')
