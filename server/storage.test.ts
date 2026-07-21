import { describe, expect, it } from 'vitest'
import { findDedicatedMount, parseLinuxMountPoints } from './storage.js'

const mountInfo = [
  '22 1 0:21 / / rw,relatime - overlay overlay rw',
  '35 22 8:1 /aimon /app/data rw,relatime - ext4 /dev/sda1 rw',
  '36 22 8:2 /cloak /root/.cloakbrowser rw,relatime - ext4 /dev/sda2 rw',
].join('\n')

describe('persistent data mount detection', () => {
  it('parses and decodes Linux mount points', () => {
    const info = `${mountInfo}\n37 22 8:3 /space /mnt/my\\040data rw - ext4 /dev/sda3 rw`
    expect(parseLinuxMountPoints(info)).toContain('/mnt/my data')
  })

  it('accepts the mount point itself and its descendants', () => {
    expect(findDedicatedMount('/app/data', mountInfo)).toBe('/app/data')
    expect(findDedicatedMount('/app/data/cloak-profiles', mountInfo)).toBe('/app/data')
  })

  it('rejects a directory that only lives on the container root filesystem', () => {
    expect(findDedicatedMount('/app/ephemeral-data', mountInfo)).toBeUndefined()
  })

  it('does not confuse similarly prefixed paths with the mounted directory', () => {
    expect(findDedicatedMount('/app/database', mountInfo)).toBeUndefined()
  })
})
