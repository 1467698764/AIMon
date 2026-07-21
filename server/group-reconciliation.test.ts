import { describe, expect, it } from 'vitest'
import { reconcileSourceGroups } from './group-reconciliation.js'
import type { RemoteGroup } from './types.js'

interface StoredGroup {
  id: number
  external_id: string
  ratio: number
  ratio_dynamic: number
}

function stored(id: number, externalId: string, ratio: number, ratioDynamic = false): StoredGroup {
  return { id, external_id: externalId, ratio, ratio_dynamic: Number(ratioDynamic) }
}

function remote(externalId: string, ratio: number, ratioDynamic = false): RemoteGroup {
  return { externalId, name: externalId, ratio, ratioDynamic }
}

describe('reconcileSourceGroups', () => {
  it('matches external IDs before attempting rename inference', () => {
    const sources = [stored(1, 'default', 1), stored(2, 'vip', 2)]
    const remotes = [remote('vip', 1), remote('renamed-default', 2)]

    expect(reconcileSourceGroups(sources, remotes, true).map((item) => item?.id)).toEqual([2, 1])
  })

  it('inherits identity when exactly one old and one new group remain', () => {
    const sources = [stored(1, 'old-name', 1)]
    const remotes = [remote('new-name', 8)]

    expect(reconcileSourceGroups(sources, remotes, true)[0]?.id).toBe(1)
  })

  it('matches multiple renames only when ratio identity is unique on both sides', () => {
    const sources = [
      stored(1, 'old-basic', 1),
      stored(2, 'old-auto', 1, true),
      stored(3, 'old-pro', 2),
    ]
    const remotes = [
      remote('new-pro', 2),
      remote('new-auto', 1, true),
      remote('new-basic', 1),
    ]

    expect(reconcileSourceGroups(sources, remotes, true).map((item) => item?.id)).toEqual([3, 2, 1])
  })

  it('tolerates harmless floating-point differences in stored ratios', () => {
    const sources = [stored(1, 'old-basic', 0.1 + 0.2), stored(2, 'old-pro', 2)]
    const remotes = [remote('new-basic', 0.3), remote('new-pro', 2)]

    expect(reconcileSourceGroups(sources, remotes, true).map((item) => item?.id)).toEqual([1, 2])
  })

  it('does not guess when equal ratios make a rename ambiguous', () => {
    const sources = [stored(1, 'old-a', 1), stored(2, 'old-b', 1)]
    const remotes = [remote('new-a', 1), remote('new-b', 1)]

    expect(reconcileSourceGroups(sources, remotes, true)).toEqual([undefined, undefined])
  })

  it('does not infer renames for adapters with stable group IDs', () => {
    const sources = [stored(1, '9', 1)]
    const remotes = [remote('10', 1)]

    expect(reconcileSourceGroups(sources, remotes, false)).toEqual([undefined])
  })
})
