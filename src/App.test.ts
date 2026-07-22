import { describe, expect, it } from 'vitest'
import {
  createManualGroupClientId, effectiveModelStatus, fmtMs, latencyTone, resolveSiteView, siteHasVisibleModels,
  statusCounts, summarizeHealthTargets,
} from './App.js'
import type { HealthJobTarget, ModelItem, SiteItem } from './types.js'

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

  it('keeps displayed TTFB values distinct across color boundaries', () => {
    expect(fmtMs(6_999)).toBe('6.999s')
    expect(fmtMs(7_000)).toBe('7.00s')
    expect(fmtMs(14_999)).toBe('14.999s')
    expect(fmtMs(15_000)).toBe('15.00s')
    expect(latencyTone('ttfb', 14_999)).toBe('warning')
    expect(latencyTone('ttfb', 15_000)).toBe('bad')
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

describe('resolveSiteView', () => {
  it('uses focused navigation for large dashboards and keeps an explicit preference', () => {
    expect(resolveSiteView(6, null)).toBe('all')
    expect(resolveSiteView(7, null)).toBe('focus')
    expect(resolveSiteView(30, 'all')).toBe('all')
    expect(resolveSiteView(2, 'focus')).toBe('focus')
  })
})

describe('active health presentation', () => {
  const models = [
    { id: 11, status: 'excellent' },
    { id: 12, status: 'failed' },
    { id: 13, status: 'available' },
  ] as ModelItem[]

  it('uses pending consistently for models in an active job', () => {
    const active = new Set([11, 12])
    expect(effectiveModelStatus(models[0], active)).toBe('pending')
    expect(statusCounts(models, active)).toEqual({ excellent: 0, available: 1, failed: 0, pending: 2 })
  })

  it('applies the effective status to site filtering', () => {
    const site = { id: 1, name: 'Gateway', baseUrl: 'https://example.test', groups: [{ name: 'default', models }] } as SiteItem
    expect(siteHasVisibleModels(site, '', 'pending', new Set([12]))).toBe(true)
    expect(siteHasVisibleModels(site, '', 'failed', new Set([12]))).toBe(false)
  })
})

describe('bounded labels and local ids', () => {
  it('bounds the health job title instead of rendering every target', () => {
    const targets = Array.from({ length: 8 }, (_, index) => ({ label: `target-${index}` })) as HealthJobTarget[]
    expect(summarizeHealthTargets(targets)).toBe('target-0；target-1；target-2；另有 5 个目标')
  })

  it('creates distinct manual group ids', () => {
    expect(createManualGroupClientId()).not.toBe(createManualGroupClientId())
  })
})
