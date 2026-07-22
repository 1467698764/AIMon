import { afterEach, describe, expect, it, vi } from 'vitest'
import { authHeaders, isPrivateNetworkAddress, normalizeBaseUrl, remoteFetch, unwrap } from './http.js'
import { isCloudflareChallenge } from './cloak.js'

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

  it('rejects credentials embedded in a Base URL', () => {
    expect(() => normalizeBaseUrl('https://user:secret@example.com')).toThrow('username or password')
  })

  it('classifies private, loopback, link-local, and public network addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.169.254', '172.31.0.1', '192.168.1.1', '::1', '::ffff:7f00:1', 'fd00::1', 'fe80::1']) {
      expect(isPrivateNetworkAddress(address), address).toBe(true)
    }
    for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) {
      expect(isPrivateNetworkAddress(address), address).toBe(false)
    }
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

  it('detects Cloudflare challenges returned with HTTP 200', async () => {
    const response = new Response('<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x.js"></script>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })
    await expect(isCloudflareChallenge(response)).resolves.toBe(true)
  })

  it('does not mistake JavaScript Detection injected into a normal page for a challenge', async () => {
    const response = new Response(`
      <!doctype html><title>VSLLM</title><main>Dashboard</main>
      <script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>
    `, {
      status: 200,
      headers: { 'Content-Type': 'text/html', Server: 'cloudflare' },
    })
    await expect(isCloudflareChallenge(response)).resolves.toBe(false)
  })

  it('does not mistake ordinary JSON errors behind Cloudflare for a challenge', async () => {
    const response = new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', Server: 'cloudflare' },
    })
    await expect(isCloudflareChallenge(response)).resolves.toBe(false)
  })

  it('keeps the timeout active while the response body is being read', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => {
          controller.error(new DOMException('aborted', 'AbortError'))
        }, { once: true })
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const response = await remoteFetch('https://example.com', '/slow', {}, 20)
    await expect(response.text()).rejects.toThrow('timed out')
  })

  it('holds the three-request origin limit until response bodies finish', async () => {
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({ start() {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const active = await Promise.all([
      remoteFetch('https://example.com', '/one'),
      remoteFetch('https://example.com', '/two'),
      remoteFetch('https://example.com', '/three'),
    ])
    const controller = new AbortController()
    const queued = remoteFetch('https://example.com', '/four', { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetchMock).toHaveBeenCalledTimes(3)

    controller.abort()
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await Promise.all(active.map((response) => response.body?.cancel()))
  })

  it('stops oversized remote responses before they can consume unbounded memory', async () => {
    const oversized = new Uint8Array(8 * 1024 * 1024 + 1)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(oversized, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    })))

    const response = await remoteFetch('https://example.com', '/oversized')
    await expect(response.arrayBuffer()).rejects.toThrow('8 MiB')
  })
})
