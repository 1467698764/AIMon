import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  configureSite: vi.fn(() => 77),
  getDashboard: vi.fn(() => ({ sites: [{ id: 77 }] })),
  startHealthCheck: vi.fn(() => ({ id: 'job-1', status: 'queued' })),
}))

vi.mock('./site-service.js', () => ({
  configureSite: mocks.configureSite,
  deleteSite: vi.fn(),
  discardDraft: vi.fn(),
  discoverSite: vi.fn(),
  getDashboard: mocks.getDashboard,
  getSettings: vi.fn(),
  getSiteEditor: vi.fn(),
  prepareManualSite: vi.fn(),
  prepareGroups: vi.fn(),
  reorder: vi.fn(),
  saveSettings: vi.fn(),
  updateExpanded: vi.fn(),
}))
vi.mock('./health.js', () => ({
  listActiveJobs: vi.fn(() => []),
  startHealthCheck: mocks.startHealthCheck,
}))

import routes from './routes.js'

const app = express().use(express.json()).use('/api', routes)
const selections = [{ groupId: 4, modelIds: [8, 9] }]

afterEach(() => {
  mocks.configureSite.mockClear()
  mocks.startHealthCheck.mockClear()
})

describe('site configuration route', () => {
  it('saves without starting health checks when runHealth is false', async () => {
    const response = await request(app)
      .post('/api/drafts/12/configure')
      .send({ selections, runHealth: false })
      .expect(200)

    expect(mocks.configureSite).toHaveBeenCalledWith(12, selections)
    expect(mocks.startHealthCheck).not.toHaveBeenCalled()
    expect(response.body).toEqual({ ok: true, siteId: 77, dashboard: { sites: [{ id: 77 }] } })
  })

  it('keeps the previous save-and-check behavior when runHealth is omitted', async () => {
    const response = await request(app)
      .post('/api/drafts/12/configure')
      .send({ selections })
      .expect(200)

    expect(mocks.startHealthCheck).toHaveBeenCalledWith({ siteId: 77 })
    expect(response.body).toMatchObject({
      ok: true,
      siteId: 77,
      dashboard: { sites: [{ id: 77 }] },
      job: { id: 'job-1' },
    })
  })

  it('reports a health-start warning without turning a successful save into HTTP 500', async () => {
    mocks.startHealthCheck.mockImplementationOnce(() => { throw new Error('no targets') })

    const response = await request(app)
      .post('/api/drafts/12/configure')
      .send({ selections })
      .expect(200)

    expect(response.body).toMatchObject({
      ok: true,
      siteId: 77,
      dashboard: { sites: [{ id: 77 }] },
      healthStartError: 'no targets',
    })
  })
})
