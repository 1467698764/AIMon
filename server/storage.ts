import fs from 'node:fs'
import path from 'node:path'

function decodeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => (
    String.fromCharCode(Number.parseInt(octal, 8))
  ))
}

export function parseLinuxMountPoints(mountInfo: string): string[] {
  const points = new Set<string>()
  for (const line of mountInfo.split(/\r?\n/)) {
    if (!line.trim()) continue
    const fields = line.split(' ')
    if (fields.length < 5) continue
    points.add(path.posix.normalize(decodeMountPath(fields[4])))
  }
  return [...points]
}

export function findDedicatedMount(dataDir: string, mountInfo: string): string | undefined {
  const target = path.posix.resolve(dataDir.replaceAll('\\', '/'))
  return parseLinuxMountPoints(mountInfo)
    .filter((mountPoint) => mountPoint !== '/')
    .filter((mountPoint) => target === mountPoint || target.startsWith(`${mountPoint}/`))
    .sort((left, right) => right.length - left.length)[0]
}

function assertWritable(dataDir: string): void {
  const probe = path.join(dataDir, `.aimon-write-test-${process.pid}-${Date.now()}`)
  try {
    fs.writeFileSync(probe, 'ok', { flag: 'wx', mode: 0o600 })
    fs.rmSync(probe)
  } catch (error) {
    try { fs.rmSync(probe, { force: true }) } catch {}
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`DATA_DIR 不可写：${dataDir}（${reason}）`)
  }
}

export function prepareDataDirectory(dataDir: string, requirePersistentMount: boolean): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  assertWritable(dataDir)

  if (!requirePersistentMount) return
  if (process.platform !== 'linux') {
    throw new Error('REQUIRE_PERSISTENT_DATA=true 仅支持在 Linux 容器中校验挂载点')
  }

  let mountInfo: string
  try {
    mountInfo = fs.readFileSync('/proc/self/mountinfo', 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`无法验证 DATA_DIR 的持久卷挂载状态：${reason}`)
  }

  if (!findDedicatedMount(dataDir, mountInfo)) {
    throw new Error(
      `DATA_DIR（${dataDir}）未位于独立挂载卷中，拒绝使用容器临时文件系统启动。`
      + ` Zeabur 请在服务的 Volumes 页面创建持久卷并将 Mount Directory 设为 ${dataDir}，然后重新部署。`
      + ' 首次挂载会清空目标目录，请先导出现有临时数据。仅在确认宿主机目录本身会持久化时，才设置 REQUIRE_PERSISTENT_DATA=false。',
    )
  }
}
