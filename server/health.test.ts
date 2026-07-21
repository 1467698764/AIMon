import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getHealthTargets: vi.fn(),
  remoteFetch: vi.fn(),
  insertedChecks: [] as Array<{ id: number; modelId: number }>,
  completedAttempts: new Map<number, any[]>(),
  nextCheckId: 1,
}))

vi.mock('./site-service.js', () => ({ getHealthTargets: mocks.getHealthTargets }))
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
            return { changes: 1 }
          },
        }
      }
      if (/SELECT \* FROM health_checks/i.test(sql)) return { get: () => undefined }
      if (/SELECT h\.status, h\.attempts_json/i.test(sql)) return { all: () => [] }
      return { run: () => ({ changes: 1 }), get: () => undefined, all: () => [] }
    },
  },
}))

import { listJobs, startHealthCheck } from './health.js'

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
  mocks.insertedChecks.length = 0
  mocks.completedAttempts.clear()
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
})
