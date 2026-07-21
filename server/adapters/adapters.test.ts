import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewApiAdapter } from './newapi.js'
import { Sub2ApiAdapter } from './sub2api.js'

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init })
}

afterEach(() => vi.unstubAllGlobals())

describe('New API adapter', () => {
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

  it('reads OpenAI-compatible model lists', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ object: 'list', data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] })))
    await expect(new NewApiAdapter().listModels('https://new.example', 'sk-test'))
      .resolves.toEqual([
        { name: 'gpt-4o', endpointTypes: [] },
        { name: 'gpt-4o-mini', endpointTypes: [] },
      ])
  })
})

describe('Sub2API adapter', () => {
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
