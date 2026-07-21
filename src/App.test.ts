import { describe, expect, it } from 'vitest'
import { latencyTone, siteHasVisibleModels } from './App.js'
import type { SiteItem } from './types.js'

describe('latencyTone', () => {
  it('uses metric-specific green, yellow, and red thresholds', () => {
    expect(latencyTone('ttfb', 6_999)).toBe('good')
    expect(latencyTone('ttfb', 7_000)).toBe('warning')
    expect(latencyTone('ttfb', 15_000)).toBe('bad')

    expect(latencyTone('ttft', 1_999)).toBe('good')
    expect(latencyTone('ttft', 5_999)).toBe('warning')
    expect(latencyTone('ttft', 6_000)).toBe('bad')

    expect(latencyTone('total', 5_999)).toBe('good')
    expect(latencyTone('total', 19_999)).toBe('warning')
    expect(latencyTone('total', 20_000)).toBe('bad')
  })

  it('keeps missing or invalid metrics neutral', () => {
    expect(latencyTone('ttfb', null)).toBe('neutral')
    expect(latencyTone('total', Number.NaN)).toBe('neutral')
  })
})

describe('siteHasVisibleModels', () => {
  const emptySite = {
    id: 1,
    name: 'Fresh Gateway',
    baseUrl: 'https://fresh.example',
    groups: [],
  } as unknown as SiteItem

  it('keeps newly added sites visible before any models are configured', () => {
    expect(siteHasVisibleModels(emptySite, '', 'all')).toBe(true)
  })

  it('keeps an empty site visible when its name matches the search', () => {
    expect(siteHasVisibleModels(emptySite, 'fresh', 'all')).toBe(true)
    expect(siteHasVisibleModels(emptySite, 'missing', 'all')).toBe(false)
  })
})
