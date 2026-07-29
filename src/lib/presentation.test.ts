import { describe, expect, it } from 'vitest'
import { fmtMs } from './format.js'
import {
  aggregateTone, effectiveModelStatus, latencyTone, siteHasVisibleModels, sortGroups, sortModels, statusCounts,
  summarizeHealthTargets,
} from './health.js'
import { createManualGroupClientId, resolveSiteView } from './view.js'
import { resolveTheme } from './prefs.js'
import type { GroupItem, HealthJobTarget, ModelItem, SiteItem } from '../types.js'

/** Only the fields the presentation helpers read; the rest of ModelItem is irrelevant here. */
function model(partial: Partial<ModelItem> & { id: number; name: string }): ModelItem {
  return {
    sortOrder: partial.id,
    checkedAt: null,
    successCount: null,
    attemptCount: null,
    avgTtfbMs: null,
    avgTtftMs: null,
    avgTotalMs: null,
    status: 'available',
    customPrompt: '',
    attempts: [],
    ...partial,
  }
}

function group(name: string, models: ModelItem[], standardRatio: number | null = 1): GroupItem {
  return { id: models[0]?.id ?? 0, name, ratio: 1, ratioDynamic: false, standardRatio, expanded: true, models }
}

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

describe('sortModels', () => {
  const fast = model({ id: 1, name: 'gpt-fast', avgTtftMs: 400, avgTotalMs: 900, attemptCount: 3, successCount: 2, status: 'available' })
  const slow = model({ id: 2, name: 'claude-slow', avgTtftMs: 2_600, avgTotalMs: 4_800, attemptCount: 3, successCount: 3, status: 'excellent' })
  const untested = model({ id: 3, name: 'zzz-untested', status: 'pending' })
  const models = [fast, slow, untested]

  it('keeps the persisted order untouched in manual mode', () => {
    expect(sortModels(models, 'manual', 1)).toBe(models)
  })

  it('orders by latency and pushes untested models last', () => {
    expect(sortModels(models, 'latency', 1).map((item) => item.id)).toEqual([1, 2, 3])
  })

  it('orders by success ratio before latency', () => {
    expect(sortModels(models, 'success', 1).map((item) => item.id)).toEqual([2, 1, 3])
  })

  it('orders by name without mutating the input', () => {
    expect(sortModels(models, 'name', 1).map((item) => item.name)).toEqual(['claude-slow', 'gpt-fast', 'zzz-untested'])
    expect(models.map((item) => item.id)).toEqual([1, 2, 3])
  })

  it('prefers reliable models when recommending', () => {
    expect(sortModels(models, 'recommended', 1)[0].id).toBe(2)
    expect(sortModels(models, 'recommended', 1).at(-1)?.id).toBe(3)
  })
})

describe('sortGroups', () => {
  const quick = group('quick', [model({ id: 1, name: 'a', avgTtftMs: 500, attemptCount: 2, successCount: 1 })])
  const reliable = group('reliable', [model({ id: 2, name: 'b', avgTtftMs: 3_000, attemptCount: 2, successCount: 2 })])
  const groups = [reliable, quick]

  it('keeps the persisted order untouched in manual mode', () => {
    expect(sortGroups(groups, 'manual')).toBe(groups)
  })

  it('follows the best model of each group', () => {
    expect(sortGroups(groups, 'latency').map((item) => item.name)).toEqual(['quick', 'reliable'])
    expect(sortGroups(groups, 'success').map((item) => item.name)).toEqual(['reliable', 'quick'])
    expect(sortGroups(groups, 'name').map((item) => item.name)).toEqual(['quick', 'reliable'])
  })
})

describe('aggregateTone', () => {
  it('reports the worst status first and lets an active check win', () => {
    expect(aggregateTone({ excellent: 3, available: 1, failed: 1, pending: 0 }, false)).toBe('failed')
    expect(aggregateTone({ excellent: 3, available: 1, failed: 0, pending: 0 }, false)).toBe('available')
    expect(aggregateTone({ excellent: 3, available: 0, failed: 0, pending: 0 }, false)).toBe('excellent')
    expect(aggregateTone({ excellent: 0, available: 0, failed: 0, pending: 2 }, false)).toBe('pending')
    expect(aggregateTone({ excellent: 0, available: 0, failed: 4, pending: 0 }, true)).toBe('checking')
  })
})

describe('resolveTheme', () => {
  it('keeps explicit choices and falls back to light without a system signal', () => {
    expect(resolveTheme('light')).toBe('light')
    expect(resolveTheme('dark')).toBe('dark')
    expect(resolveTheme('auto')).toBe('light')
  })
})
