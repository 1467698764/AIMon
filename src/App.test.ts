import { describe, expect, it } from 'vitest'
import { latencyTone } from './App.js'

describe('latencyTone', () => {
  it('uses metric-specific green, yellow, and red thresholds', () => {
    expect(latencyTone('ttfb', 1_000)).toBe('good')
    expect(latencyTone('ttfb', 1_001)).toBe('warning')
    expect(latencyTone('ttfb', 3_001)).toBe('bad')

    expect(latencyTone('ttft', 2_000)).toBe('good')
    expect(latencyTone('ttft', 6_000)).toBe('warning')
    expect(latencyTone('ttft', 6_001)).toBe('bad')

    expect(latencyTone('total', 6_000)).toBe('good')
    expect(latencyTone('total', 20_000)).toBe('warning')
    expect(latencyTone('total', 20_001)).toBe('bad')
  })

  it('keeps missing or invalid metrics neutral', () => {
    expect(latencyTone('ttfb', null)).toBe('neutral')
    expect(latencyTone('total', Number.NaN)).toBe('neutral')
  })
})
