import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getHealthTargets: vi.fn(),
  remoteFetch: vi.fn(),
  refreshHealthMetadata: vi.fn(async () => [] as string[]),
  insertedChecks: [] as Array<{ id: number; modelId: number }>,
  completedAttempts: new Map<number, any[]>(),
  completedStatuses: new Map<number, string>(),
  healthAttempts: 3,
  nextCheckId: 1,
}))

vi.mock('./site-service.js', () => ({
  getHealthTargets: mocks.getHealthTargets,
  refreshHealthMetadata: mocks.refreshHealthMetadata,
}))
vi.mock('./http.js', () => ({
  extractMessage: (body: any) => String(body?.message || body?.error?.message || body?.error || ''),
  remoteFetch: mocks.remoteFetch,
}))
vi.mock('./db.js', () => ({
  nowIso: () => new Date().toISOString(),
  db: {
    prepare: (sql: string) => {
      if (/INSERT INTO health_checks/i.test(sql)) {
        return {
          run: (modelId: number) => {
            const id = mocks.nextCheckId++
            mocks.insertedChecks.push({ id, modelId })
            return { lastInsertRowid: id }
          },
        }
      }
      if (/UPDATE health_checks SET checked_at = \?, success_count/i.test(sql)) {
        return {
          run: (...args: any[]) => {
            mocks.completedAttempts.set(Number(args[8]), JSON.parse(String(args[7])))
            mocks.completedStatuses.set(Number(args[8]), String(args[6]))
            return { changes: 1 }
          },
        }
      }
      if (/SELECT health_attempts FROM settings/i.test(sql)) return { get: () => ({ health_attempts: mocks.healthAttempts }) }
      if (/SELECT \* FROM health_checks/i.test(sql)) return { get: () => undefined }
      if (/SELECT h\.status, h\.attempts_json/i.test(sql)) return { all: () => [] }
      return { run: () => ({ changes: 1 }), get: () => undefined, all: () => [] }
    },
  },
}))

import { hasActiveHealthForSite, listJobs, startHealthCheck } from './health.js'

const siteId = 11
const groupId = 21
const firstModelId = 31
const secondModelId = 32

function target(modelId: number, name: string) {
  return {
    model_id: modelId,
    model_name: name,
    endpoint_types_json: JSON.stringify(['openai']),
    group_id: groupId,
    group_name: 'Default',
    site_id: siteId,
    site_name: 'Runtime Test',
    base_url: 'https://health.test',
    config_revision: 1,
    apiKey: 'sk-test',
  }
}

function successResponse(): Response {
  return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

async function waitForJob(id: string): Promise<void> {
  await vi.waitFor(() => {
    expect(listJobs().find((job) => job.id === id)?.status).toMatch(/completed|failed/)
  })
}

afterEach(() => {
  mocks.getHealthTargets.mockReset()
  mocks.remoteFetch.mockReset()
  mocks.refreshHealthMetadata.mockReset()
  mocks.refreshHealthMetadata.mockResolvedValue([])
  mocks.insertedChecks.length = 0
  mocks.completedAttempts.clear()
  mocks.completedStatuses.clear()
  mocks.healthAttempts = 3
})

describe('health job runtime state', () => {
  it('deduplicates an already-running model and exposes its current attempt', async () => {
    mocks.getHealthTargets.mockReturnValue([target(firstModelId, 'model-a')])
    let releaseFirst!: () => void
    const firstRequest = new Promise<void>((resolve) => { releaseFirst = resolve })
    mocks.remoteFetch.mockImplementation(async () => {
      if (mocks.remoteFetch.mock.calls.length === 1) await firstRequest
      return successResponse()
    })
    const job = startHealthCheck({ modelId: firstModelId })
    await vi.waitFor(() => {
      expect(job.targets[0]).toMatchObject({ status: 'running', attempt: 1, attemptCount: 3 })
    })
    const duplicate = startHealthCheck({ modelId: firstModelId })

    expect(duplicate.id).toBe(job.id)
    expect(duplicate.deduplicated).toBe(true)
    expect(mocks.insertedChecks.filter((row) => row.modelId === firstModelId)).toHaveLength(1)

    releaseFirst()
    await waitForJob(job.id)
    expect(mocks.remoteFetch).toHaveBeenCalledTimes(3)
    expect(job.targets[0]).toMatchObject({ status: 'completed', attempt: 3 })
  })

  it('keeps the first, second, and third attempt errors in execution order', async () => {
    mocks.getHealthTargets.mockReturnValue([target(secondModelId, 'model-b')])
    const responses = [
      new Response('{"error":{"message":"first failure"}}', { status: 500, headers: { 'Content-Type': 'application/json' } }),
      new Response('{"error":{"message":"second failure"}}', { status: 500, headers: { 'Content-Type': 'application/json' } }),
      successResponse(),
    ]
    mocks.remoteFetch.mockImplementation(async () => responses.shift()!)

    const job = startHealthCheck({ modelId: secondModelId })
    await waitForJob(job.id)
    const check = mocks.insertedChecks.find((row) => row.modelId === secondModelId)!
    const attempts = mocks.completedAttempts.get(check.id)!

    expect(attempts).toHaveLength(3)
    expect(attempts.map((attempt: any) => attempt.error || '')).toEqual([
      'first failure',
      'second failure',
      '',
    ])
  })

  it('snapshots the configured attempt count and applies proportional status thresholds', async () => {
    mocks.healthAttempts = 4
    mocks.getHealthTargets.mockReturnValue([target(firstModelId, 'model-four')])
    const responses = [
      successResponse(),
      successResponse(),
      successResponse(),
      new Response('{"error":{"message":"fourth failure"}}', { status: 500, headers: { 'Content-Type': 'application/json' } }),
    ]
    mocks.remoteFetch.mockImplementation(async () => responses.shift()!)

    const job = startHealthCheck({ modelId: firstModelId })
    expect(job.targets[0].attemptCount).toBe(4)
    await waitForJob(job.id)

    const check = mocks.insertedChecks.find((row) => row.modelId === firstModelId)!
    expect(mocks.remoteFetch).toHaveBeenCalledTimes(4)
    expect(mocks.completedAttempts.get(check.id)).toHaveLength(4)
    expect(mocks.completedStatuses.get(check.id)).toBe('available')
  })

  it('returns a visible refreshing job before group metadata synchronization finishes', async () => {
    mocks.getHealthTargets.mockReturnValue([target(secondModelId, 'model-sync')])
    let releaseRefresh!: () => void
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve })
    mocks.refreshHealthMetadata.mockImplementationOnce(async () => {
      await refreshGate
      return []
    })
    mocks.remoteFetch.mockResolvedValue(successResponse())

    const job = startHealthCheck({ groupId })
    expect(job).toMatchObject({ status: 'queued', phase: 'refreshing', total: 1 })
    await vi.waitFor(() => expect(mocks.refreshHealthMetadata).toHaveBeenCalledWith({ groupId }))
    expect(job.targets[0].status).toBe('queued')

    releaseRefresh()
    await waitForJob(job.id)
    expect(job.phase).toBe('checking')
  })

  it('falls back to a non-streaming chat request when streaming is unsupported', async () => {
    mocks.healthAttempts = 1
    mocks.getHealthTargets.mockReturnValue([target(firstModelId, 'model-no-stream')])
    mocks.remoteFetch
      .mockResolvedValueOnce(new Response('{"error":{"message":"streaming is not supported"}}', {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('{"choices":[{"message":{"content":"OK"}}]}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const job = startHealthCheck({ modelId: firstModelId })
    await waitForJob(job.id)

    const check = mocks.insertedChecks.find((row) => row.modelId === firstModelId)!
    expect(mocks.remoteFetch).toHaveBeenCalledTimes(2)
    expect(mocks.completedStatuses.get(check.id)).toBe('excellent')
    expect(mocks.completedAttempts.get(check.id)?.[0]).toMatchObject({ ok: true })
  })

  it('never prunes a slow active job while many newer jobs complete', async () => {
    mocks.healthAttempts = 1
    let releaseSlow!: () => void
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve })
    let firstRequest = true
    mocks.remoteFetch.mockImplementation(async () => {
      if (firstRequest) {
        firstRequest = false
        await slowGate
      }
      return successResponse()
    })

    mocks.getHealthTargets.mockReturnValueOnce([target(10_000, 'slow-model')])
    const slowJob = startHealthCheck({ modelId: 10_000 })
    await vi.waitFor(() => expect(slowJob.targets[0].status).toBe('running'))

    const quickJobs = []
    for (let index = 0; index < 55; index += 1) {
      const modelId = 20_000 + index
      mocks.getHealthTargets.mockReturnValueOnce([target(modelId, `quick-${index}`)])
      quickJobs.push(startHealthCheck({ modelId }))
    }
    await vi.waitFor(() => {
      expect(quickJobs.every((job) => job.status === 'completed')).toBe(true)
    }, { timeout: 5_000 })

    expect(hasActiveHealthForSite(siteId)).toBe(true)
    expect(listJobs().find((job) => job.id === slowJob.id)?.status).toBe('running')

    releaseSlow()
    await waitForJob(slowJob.id)
  })
})
