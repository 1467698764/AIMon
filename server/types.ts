export type SiteType = 'newapi' | 'sub2api'

export interface Credentials {
  username: string
  password: string
}

export interface RemoteGroup {
  externalId: string
  name: string
  ratio: number
  ratioDynamic?: boolean
  platform?: string
}

export interface RemoteSiteSnapshot {
  type: SiteType
  balance: number
  currency: string
  groups: RemoteGroup[]
  auth: RemoteAuth
}

export interface RemoteAuth {
  accessToken?: string
  cookie?: string
  userId?: string
}

export interface RemoteKey {
  externalId: string
  value: string
  name: string
}

export interface RemoteModel {
  name: string
  endpointTypes: string[]
}

export interface ExistingRemoteKey extends RemoteKey {
  previousGroupName: string
}

export interface SiteAdapter {
  readonly type: SiteType
  probe(baseUrl: string): Promise<boolean>
  login(baseUrl: string, credentials: Credentials): Promise<RemoteAuth>
  snapshot(baseUrl: string, auth: RemoteAuth): Promise<Omit<RemoteSiteSnapshot, 'type' | 'auth'>>
  ensureKey(baseUrl: string, auth: RemoteAuth, group: RemoteGroup, existing?: ExistingRemoteKey): Promise<RemoteKey>
  listModels(baseUrl: string, key: string): Promise<RemoteModel[]>
}

export interface HealthAttempt {
  ok: boolean
  ttfbMs: number | null
  ttftMs: number | null
  totalMs: number
  httpStatus: number | null
  error?: string
}

export type HealthStatus = 'excellent' | 'available' | 'failed' | 'pending'
