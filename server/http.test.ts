import { afterEach, describe, expect, it, vi } from 'vitest'
import { authHeaders, normalizeBaseUrl, remoteFetch, unwrap } from './http.js'

afterEach(() => vi.unstubAllGlobals())

describe('HTTP helpers', () => {
  it('normalizes common API base URL variants', () => {
    expect(normalizeBaseUrl('example.com/v1/')).toBe('https://example.com')
    expect(normalizeBaseUrl('https://example.com/api/v1')).toBe('https://example.com')
    expect(normalizeBaseUrl('http://localhost:3000/')).toBe('http://localhost:3000')
  })

  it('rejects non HTTP protocols', () => {
    expect(() => normalizeBaseUrl('file:///tmp/key')).toThrow('HTTP')
  })

  it('builds compatible New API authentication headers', () => {
    expect(authHeaders({ accessToken: 'token', cookie: 'session=1', userId: '7' })).toMatchObject({
      Authorization: 'Bearer token', Cookie: 'session=1', 'New-Api-User': '7',
    })
  })

  it('unwraps both supported API envelopes', () => {
    expect(unwrap({ success: true, data: { value: 1 } })).toEqual({ value: 1 })
    expect(unwrap({ code: 0, data: { value: 2 } })).toEqual({ value: 2 })
    expect(() => unwrap({ code: 400, message: 'bad' })).toThrow('bad')
  })

  it('rejects remote redirects instead of forwarding credentials', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://other.example' } })))
    await expect(remoteFetch('https://example.com', '/api/user/login')).rejects.toThrow('重定向')
  })
})
