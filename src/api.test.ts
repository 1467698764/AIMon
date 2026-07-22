import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, request } from './api.js'

describe('API response validation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('rejects a successful HTML response instead of passing an empty object to React', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><title>proxy</title>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })))

    await expect(request('/api/dashboard')).rejects.toThrow('应为 JSON')
  })

  it('accepts JSON arrays used by the jobs endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[{"id":"job-1"}]', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))

    await expect(request<Array<{ id: string }>>('/api/health/jobs')).resolves.toEqual([{ id: 'job-1' }])
  })

  it('rejects an incomplete dashboard before it reaches the render tree', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))

    await expect(api.dashboard()).rejects.toThrow('数据结构不完整')
  })

  it('keeps an HTTP-specific error when an error page is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway unavailable', { status: 502 })))

    await expect(request('/api/dashboard')).rejects.toThrow('HTTP 502')
  })
})
