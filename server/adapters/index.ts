import { NewApiAdapter } from './newapi.js'
import { Sub2ApiAdapter } from './sub2api.js'
import type { Credentials, RemoteSiteSnapshot, SiteAdapter, SiteType } from '../types.js'

const adapters: SiteAdapter[] = [new NewApiAdapter(), new Sub2ApiAdapter()]

export function getAdapter(type: SiteType): SiteAdapter {
  const adapter = adapters.find((item) => item.type === type)
  if (!adapter) throw new Error(`不支持的站点类型：${type}`)
  return adapter
}

export async function detectAndLoad(baseUrl: string, credentials: Credentials): Promise<RemoteSiteSnapshot> {
  const probeResults = await Promise.all(adapters.map(async (adapter) => ({
    adapter,
    matched: await adapter.probe(baseUrl),
  })))
  const ordered = [
    ...probeResults.filter((item) => item.matched).map((item) => item.adapter),
    ...probeResults.filter((item) => !item.matched).map((item) => item.adapter),
  ]
  const errors: string[] = []
  for (const adapter of ordered) {
    try {
      const auth = await adapter.login(baseUrl, credentials)
      const snapshot = await adapter.snapshot(baseUrl, auth)
      return { type: adapter.type, auth, ...snapshot }
    } catch (error) {
      errors.push(`${adapter.type}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`无法识别或登录该站点。${errors.join('；')}`)
}
