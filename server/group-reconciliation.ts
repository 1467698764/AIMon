import type { RemoteGroup } from './types.js'

export interface StoredGroupIdentity {
  external_id: unknown
  ratio: unknown
  ratio_dynamic?: unknown
}

function hasSameRatio(source: StoredGroupIdentity, remote: RemoteGroup): boolean {
  if (Boolean(source.ratio_dynamic) !== Boolean(remote.ratioDynamic)) return false
  if (remote.ratioDynamic) return true
  const sourceRatio = Number(source.ratio)
  const remoteRatio = Number(remote.ratio)
  if (!Number.isFinite(sourceRatio) || !Number.isFinite(remoteRatio)) return false
  return Math.abs(sourceRatio - remoteRatio) <= Number.EPSILON * Math.max(1, Math.abs(sourceRatio), Math.abs(remoteRatio)) * 8
}

export function reconcileSourceGroups<T extends StoredGroupIdentity>(
  sourceGroups: T[],
  remoteGroups: RemoteGroup[],
  inferRenames: boolean,
): Array<T | undefined> {
  const matches: Array<T | undefined> = new Array(remoteGroups.length)
  const usedSources = new Set<T>()

  for (const [remoteIndex, remote] of remoteGroups.entries()) {
    const source = sourceGroups.find((candidate) => (
      !usedSources.has(candidate) && String(candidate.external_id) === remote.externalId
    ))
    if (source) {
      matches[remoteIndex] = source
      usedSources.add(source)
    }
  }

  if (!inferRenames) return matches

  const unmatchedSources = sourceGroups.filter((source) => !usedSources.has(source))
  const unmatchedRemoteIndexes = remoteGroups
    .map((_, index) => index)
    .filter((index) => !matches[index])

  if (unmatchedSources.length === 1 && unmatchedRemoteIndexes.length === 1) {
    matches[unmatchedRemoteIndexes[0]] = unmatchedSources[0]
    return matches
  }

  for (const remoteIndex of unmatchedRemoteIndexes) {
    const remote = remoteGroups[remoteIndex]
    const sourceCandidates = unmatchedSources.filter((source) => hasSameRatio(source, remote))
    if (sourceCandidates.length !== 1) continue

    const source = sourceCandidates[0]
    const remoteCandidates = unmatchedRemoteIndexes.filter((index) => (
      hasSameRatio(source, remoteGroups[index])
    ))
    if (remoteCandidates.length === 1) matches[remoteIndex] = source
  }

  return matches
}
