import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectAndLoad } from './index.js'
import { NewApiAdapter } from './newapi.js'
import { Sub2ApiAdapter } from './sub2api.js'

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init })
}

afterEach(() => vi.unstubAllGlobals())

describe('New API adapter', () => {
  it.each([
    'https://new.example',
    'https://new.example/v1/',
    'https://new.example/api/v1',
  ])('normalizes %s before probing the status endpoint', async (baseUrl) => {
    const fetchMock = vi.fn(async () => json({ success: true, data: { system_name: 'New API' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(new NewApiAdapter().probe(baseUrl)).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('https://new.example/api/status', expect.any(Object))
  })

  it('treats a successful HTML shell as an inconclusive probe', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<!doctype html><meta name="generator" content="new-api"><title>New API</title>',
      { status: 200, headers: { 'Content-Type': 'text/html', Server: 'cloudflare' } },
    )))

    await expect(new NewApiAdapter().probe('https://new.example')).resolves.toBe(false)
  })

  it('does not identify an unrelated success envelope as New API', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ success: true, data: { service: 'another-dashboard' } })))

    await expect(new NewApiAdapter().probe('https://other.example')).resolves.toBe(false)
  })

  it('logs in and loads balance with usable group ratios', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/api/user/login')) return json({ success: true, data: { access_token: 'access', user: { id: 8 } } }, { headers: { 'Set-Cookie': 'session=abc; Path=/; HttpOnly' } })
      if (url.endsWith('/api/status')) return json({ success: true, data: { quota_per_unit: 500_000 } })
      if (url.endsWith('/api/user/self')) return json({ success: true, data: { quota: 6_250_000 } })
      if (url.endsWith('/api/user/self/groups')) return json({ success: true, data: { default: { ratio: 1 }, vip: { ratio: 0.8 } } })
      throw new Error(`unexpected ${url}`)
    }))
    const adapter = new NewApiAdapter()
    const auth = await adapter.login('https://new.example', { username: 'u', password: 'p' })
    const snapshot = await adapter.snapshot('https://new.example', auth)
    expect(auth).toMatchObject({ accessToken: 'access', userId: '8' })
    expect(snapshot.balance).toBe(12.5)
    expect(snapshot.groups).toEqual([
      { externalId: 'default', name: 'default', ratio: 1, ratioDynamic: false },
      { externalId: 'vip', name: 'vip', ratio: 0.8, ratioDynamic: false },
    ])
  })

  it('supports the legacy cookie-only login response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(
      { success: true, data: { id: 18, username: 'legacy-user' } },
      { headers: { 'Set-Cookie': 'session=legacy; Path=/; HttpOnly' } },
    )))

    await expect(new NewApiAdapter().login('https://new.example', { username: 'u', password: 'p' }))
      .resolves.toMatchObject({ cookie: 'session=legacy', userId: '18' })
  })

  it('keeps the auto group ratio dynamic instead of treating it as x1', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/api/user/self')) return json({ success: true, data: { quota: 0 } })
      if (url.endsWith('/api/status')) return json({ success: true, data: { quota_per_unit: 500_000 } })
      if (url.endsWith('/api/user/self/groups')) return json({ success: true, data: { auto: { ratio: '自动' } } })
      throw new Error(`unexpected ${url}`)
    }))
    const snapshot = await new NewApiAdapter().snapshot('https://new.example', { accessToken: 'token' })
    expect(snapshot.groups[0]).toEqual({ externalId: 'auto', name: 'auto', ratio: 1, ratioDynamic: true })
  })

  it('accepts numeric group ratios returned as strings by modified sites', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/api/user/self')) return json({ success: true, data: { quota: 0 } })
      if (url.endsWith('/api/status')) return json({ success: true, data: { quota_per_unit: 500_000 } })
      if (url.endsWith('/api/user/self/groups')) return json({ success: true, data: { vip: { ratio: '0.8' } } })
      throw new Error(`unexpected ${url}`)
    }))
    const snapshot = await new NewApiAdapter().snapshot('https://new.example', { accessToken: 'token' })
    expect(snapshot.groups[0]).toEqual({ externalId: 'vip', name: 'vip', ratio: 0.8, ratioDynamic: false })
  })

  it('reads OpenAI-compatible model lists', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ object: 'list', data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] })))
    await expect(new NewApiAdapter().listModels('https://new.example', 'sk-test'))
      .resolves.toEqual([
        { name: 'gpt-4o', endpointTypes: ['openai'] },
        { name: 'gpt-4o-mini', endpointTypes: ['openai'] },
      ])
  })
})

describe('Sub2API adapter', () => {
  it('recognizes both standard public-settings envelopes', async () => {
    const responses = [
      json({ code: 0, data: {} }),
      json({ data: { registration_enabled: true } }),
    ]
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift()!))
    const adapter = new Sub2ApiAdapter()

    await expect(adapter.probe('https://sub.example')).resolves.toBe(true)
    await expect(adapter.probe('https://sub.example/api/v1')).resolves.toBe(true)
  })

  it('logs in and applies per-user group rate overrides', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/api/v1/auth/login')) return json({ code: 0, data: { access_token: 'jwt', user: { id: 3 } } })
      if (url.endsWith('/api/v1/auth/me')) return json({ code: 0, data: { balance: 42.25 } })
      if (url.endsWith('/api/v1/groups/available')) return json({ code: 0, data: [{ id: 9, name: 'OpenAI', platform: 'openai', rate_multiplier: 1.5 }] })
      if (url.endsWith('/api/v1/groups/rates')) return json({ code: 0, data: { 9: 1.2 } })
      throw new Error(`unexpected ${url}`)
    }))
    const adapter = new Sub2ApiAdapter()
    const auth = await adapter.login('https://sub.example', { username: 'a@b.com', password: 'p' })
    const snapshot = await adapter.snapshot('https://sub.example', auth)
    expect(auth.accessToken).toBe('jwt')
    expect(snapshot.balance).toBe(42.25)
    expect(snapshot.groups[0]).toMatchObject({ externalId: '9', name: 'OpenAI', ratio: 1.2, platform: 'openai' })
  })
})

describe('site detection', () => {
  it('only attempts the explicitly matched adapter and reports login separately from recognition', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      if (url.endsWith('/api/status')) return json({ success: true, data: { system_name: 'VSLLM', quota_per_unit: 500_000 } })
      if (url.endsWith('/api/v1/settings/public')) return json({ error: 'not found' }, { status: 404 })
      if (url.endsWith('/api/user/login')) return json({ success: false, message: 'incorrect password' })
      throw new Error(`unexpected ${url}`)
    }))

    await expect(detectAndLoad('https://new.example/v1', { username: 'u', password: 'bad' }))
      .rejects.toThrow('已识别为New API，但登录或读取站点信息失败')
    expect(calls).not.toContain('https://new.example/api/v1/auth/login')
  })

  it('falls back to adapter logins only when all probes are inconclusive', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      if (url.endsWith('/api/status') || url.endsWith('/api/v1/settings/public')) {
        return new Response('<!doctype html><title>Gateway</title>', {
          status: 200,
          headers: { 'Content-Type': 'text/html', Server: 'cloudflare' },
        })
      }
      if (url.endsWith('/api/user/login')) return json({ success: false, message: 'not a New API login' }, { status: 404 })
      if (url.endsWith('/api/v1/auth/login')) return json({ code: 0, data: { access_token: 'jwt', user: { id: 3 } } })
      if (url.endsWith('/api/v1/auth/me')) return json({ code: 0, data: { balance: 9 } })
      if (url.endsWith('/api/v1/groups/available')) return json({ code: 0, data: [] })
      if (url.endsWith('/api/v1/groups/rates')) return json({ code: 0, data: {} })
      throw new Error(`unexpected ${url}`)
    }))

    await expect(detectAndLoad('https://sub.example/api/v1', { username: 'u', password: 'p' }))
      .resolves.toMatchObject({ type: 'sub2api', balance: 9 })
    expect(calls).toContain('https://sub.example/api/user/login')
    expect(calls).toContain('https://sub.example/api/v1/auth/login')
  })
})
