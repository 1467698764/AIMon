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

deleteSite(siteId)
console.log('manual site integration test passed')
