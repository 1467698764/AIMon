import { describe, expect, it } from 'vitest'
import { redactSensitiveText, sensitiveValues } from './privacy.js'

describe('privacy helpers', () => {
  it('redacts explicit credentials without changing ordinary diagnostics', () => {
    expect(redactSensitiveText('login failed for correct-horse-battery', ['correct-horse-battery']))
      .toBe('login failed for [已隐藏]')
    expect(redactSensitiveText('upstream returned HTTP 429')).toBe('upstream returned HTTP 429')
  })

  it('redacts common credential formats in remote errors', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghi'
    expect(redactSensitiveText('Bearer live-token-123456')).toBe('Bearer [已隐藏]')
    expect(redactSensitiveText('cookie: session=private-value')).toBe('cookie: [已隐藏]')
    expect(redactSensitiveText('api_key="private-value"')).toBe('api_key=[已隐藏]')
    expect(redactSensitiveText('failed with sk-live-private-value')).toBe('failed with [已隐藏]')
    expect(redactSensitiveText(`token ${jwt}`)).toBe('token [已隐藏]')
  })

  it('collects nested request secrets for exact redaction', () => {
    expect(sensitiveValues({
      password: 'account-password',
      groups: [{ apiKey: 'group-key' }],
      name: 'visible',
    })).toEqual(['account-password', 'group-key'])
  })
})
