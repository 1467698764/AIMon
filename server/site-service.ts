import { randomUUID } from 'node:crypto'
import { db, nowIso, transaction } from './db.js'
import { decrypt, encrypt } from './crypto.js'
import { detectAndLoad, getAdapter } from './adapters/index.js'
import { reconcileSourceGroups } from './group-reconciliation.js'
import type { StoredGroupIdentity } from './group-reconciliation.js'
import { normalizeBaseUrl } from './http.js'
import type { Credentials, ExistingRemoteKey, RemoteGroup, RemoteModel } from './types.js'

type Row = Record<string, any>

export interface DiscoverInput {
  id?: number
  name: string
  baseUrl: string
  username?: string
  password?: string
  rechargeRatio?: number
}

export interface ManualGroupInput {
  id?: number
  name: string
  ratio: number
  apiKey?: string
}

function one(sql: string, ...params: any[]): Row | undefined {
  return db.prepare(sql).get(...params) as Row | undefined
}

function all(sql: string, ...params: any[]): Row[] {
  return db.prepare(sql).all(...params) as Row[]
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

function defaultCredentials(): Credentials {
  const row = one('SELECT username_enc, password_enc FROM settings WHERE id = 1')
  return { username: decrypt(row?.username_enc), password: decrypt(row?.password_enc) }
}

function effectiveCredentials(site: Row | undefined, input?: { username?: string; password?: string }): Credentials {
  const defaults = defaultCredentials()
  const storedUsername = site ? decrypt(site.username_enc) : ''
  const storedPassword = site ? decrypt(site.password_enc) : ''
  const username = input?.username !== undefined ? input.username.trim() : storedUsername
  const password = input?.password !== undefined ? input.password : storedPassword
  const resolved = {
    username: username || defaults.username,
    password: password || defaults.password,
  }
  if (!resolved.username || !resolved.password) {
    throw new Error('缺少登录凭据：请填写站点账号密码，或先在默认配置中设置统一账号密码')
  }
  return resolved
}

export async function discoverSite(input: DiscoverInput & { draftId?: number }) {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const existing = input.id
    ? one('SELECT * FROM sites WHERE id = ?', input.id)
    : undefined
  if (input.id && !existing) throw new Error('站点不存在')
  const credentials = effectiveCredentials(existing, input)
  const snapshot = await detectAndLoad(baseUrl, credentials)
  const rechargeRatio = Math.max(0.000001, Number(input.rechargeRatio || existing?.recharge_ratio || 1))

  const draftId = transaction(() => {
    if (input.draftId) {
      const previousDraft = one('SELECT site_id FROM site_drafts WHERE id = ?', input.draftId)
      if (!previousDraft || Number(previousDraft.site_id || 0) !== Number(existing?.id || 0)) {
        throw new Error('配置草稿与当前站点不匹配')
      }
      db.prepare('DELETE FROM site_drafts WHERE id = ?').run(input.draftId)
    }
    const stamp = nowIso()
    const result = db.prepare(`
      INSERT INTO site_drafts
        (site_id, name, base_url, type, username_enc, password_enc, balance, currency, recharge_ratio, connection_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?)
    `).run(
      existing?.id || null, input.name.trim(), baseUrl, snapshot.type,
      input.username !== undefined ? encrypt(input.username.trim()) : existing?.username_enc,
      input.password !== undefined ? encrypt(input.password) : existing?.password_enc,
      snapshot.balance, snapshot.currency, rechargeRatio, stamp, stamp,
    )
    const id = Number(result.lastInsertRowid)
    const sameOrigin = Boolean(existing && normalizeBaseUrl(existing.base_url) === baseUrl)
    const sourceGroups = (sameOrigin
      ? all('SELECT * FROM site_groups WHERE site_id = ? ORDER BY sort_order, id', existing!.id)
      : []) as Array<Row & StoredGroupIdentity>
    const reconciledSources = reconcileSourceGroups(sourceGroups, snapshot.groups, snapshot.type === 'newapi')
    const nextOrder = Number(sourceGroups.at(-1)?.sort_order ?? -1) + 1
    let newOffset = 0
    for (const [remoteIndex, remote] of snapshot.groups.entries()) {
      const source = reconciledSources[remoteIndex]
      db.prepare(`
        INSERT INTO draft_groups
          (draft_id, source_group_id, external_id, name, ratio, ratio_dynamic, platform, api_key_enc,
           api_key_external_id, selected, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, source?.id || null, remote.externalId, remote.name, remote.ratio, Number(remote.ratioDynamic || false), remote.platform || null,
        source?.api_key_enc || null, source?.api_key_external_id || null, Number(source?.selected || 0),
        source ? source.sort_order : nextOrder + newOffset++,
      )
    }
    return id
  })

  return getDraftEditor(draftId)
}

export function getSiteEditor(siteId: number) {
  const site = one('SELECT * FROM sites WHERE id = ?', siteId)
  if (!site) throw new Error('站点不存在')
  const groups = all(`
    SELECT id, external_id AS externalId, name, ratio, ratio_dynamic AS ratioDynamic, platform, selected, available, sort_order AS sortOrder,
      CASE WHEN api_key_enc IS NOT NULL THEN 1 ELSE 0 END AS hasKey
    FROM site_groups WHERE site_id = ? ORDER BY sort_order, id
  `, siteId).map((group) => ({ ...group, ratioDynamic: Boolean(group.ratioDynamic), selected: Boolean(group.selected), available: Boolean(group.available), hasKey: Boolean(group.hasKey) }))
  return {
    id: site.id,
    draftId: null,
    name: site.name,
    baseUrl: site.base_url,
    type: site.type,
    username: decrypt(site.username_enc),
    hasPassword: Boolean(site.password_enc),
    balance: site.balance,
    currency: site.currency,
    rechargeRatio: site.recharge_ratio,
    connectionMode: site.connection_mode || 'auto',
    balanceKnown: (site.connection_mode || 'auto') === 'auto',
    groups,
  }
}

export function getDraftEditor(draftId: number) {
  const draft = one('SELECT * FROM site_drafts WHERE id = ?', draftId)
  if (!draft) throw new Error('配置草稿不存在或已过期')
  const groups = all(`
    SELECT id, external_id AS externalId, name, ratio, ratio_dynamic AS ratioDynamic, platform, selected, sort_order AS sortOrder,
      CASE WHEN api_key_enc IS NOT NULL THEN 1 ELSE 0 END AS hasKey
    FROM draft_groups WHERE draft_id = ? ORDER BY sort_order, id
  `, draftId).map((group) => ({ ...group, ratioDynamic: Boolean(group.ratioDynamic), selected: Boolean(group.selected), available: true, hasKey: Boolean(group.hasKey) }))
  return {
    id: draft.site_id || 0,
    draftId: draft.id,
    name: draft.name,
    baseUrl: draft.base_url,
    type: draft.type,
    username: decrypt(draft.username_enc),
    hasPassword: Boolean(draft.password_enc),
    balance: draft.balance,
    currency: draft.currency,
    rechargeRatio: draft.recharge_ratio,
    connectionMode: draft.connection_mode || 'auto',
    balanceKnown: (draft.connection_mode || 'auto') === 'auto',
    groups,
  }
}

function draftCredentials(draft: Row): Credentials {
  const defaults = defaultCredentials()
  const resolved = {
    username: decrypt(draft.username_enc) || defaults.username,
    password: decrypt(draft.password_enc) || defaults.password,
  }
  if (!resolved.username || !resolved.password) throw new Error('缺少可用的登录凭据')
  return resolved
}

export async function prepareGroups(draftId: number, groupIds: number[]) {
  const draft = one('SELECT * FROM site_drafts WHERE id = ?', draftId)
  if (!draft?.type) throw new Error('配置草稿不存在或尚未完成识别')
  const adapter = getAdapter(draft.type)
  const auth = await adapter.login(draft.base_url, draftCredentials(draft))
  const groups = all(`
    SELECT * FROM draft_groups WHERE draft_id = ? AND id IN (${groupIds.map(() => '?').join(',') || 'NULL'})
    ORDER BY sort_order, id
  `, draftId, ...groupIds)
  if (groups.length !== groupIds.length) throw new Error('选择中包含已失效的分组，请重新获取站点信息')

  const prepared = await mapLimit(groups, 3, async (group) => {
    const source = group.source_group_id
      ? one('SELECT * FROM site_groups WHERE id = ? AND site_id = ?', group.source_group_id, draft.site_id)
      : undefined
    const existing: ExistingRemoteKey | undefined = source?.api_key_enc && source?.api_key_external_id
      ? {
          externalId: String(source.api_key_external_id),
          value: decrypt(source.api_key_enc),
          name: `${source.name}_Monitor`,
          previousGroupName: source.name,
        }
      : undefined
    const remoteGroup: RemoteGroup = {
      externalId: group.external_id,
      name: group.name,
      ratio: group.ratio,
      ratioDynamic: Boolean(group.ratio_dynamic),
      platform: group.platform || undefined,
    }
    const key = await adapter.ensureKey(draft.base_url, auth, remoteGroup, existing)
    const models = await adapter.listModels(draft.base_url, key.value)
    if (!models.length) throw new Error(`分组「${group.name}」没有返回任何可用模型`)

    transaction(() => {
      db.prepare(`UPDATE draft_groups SET api_key_enc = ?, api_key_external_id = ?, selected = 1 WHERE id = ?`)
        .run(encrypt(key.value), key.externalId, group.id)
      const sourceModels = source
        ? all('SELECT id, name, selected FROM models WHERE group_id = ?', source.id)
        : []
      const selectedByName = new Map(sourceModels.map((item) => [item.name, Boolean(item.selected)]))
      const sourceIdByName = new Map(sourceModels.map((item) => [item.name, item.id]))
      db.prepare('DELETE FROM draft_models WHERE draft_group_id = ?').run(group.id)
      for (const [index, model] of models.entries()) {
        db.prepare(`
          INSERT INTO draft_models (draft_group_id, source_model_id, name, endpoint_types_json, selected, sort_order)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(group.id, sourceIdByName.get(model.name) || null, model.name, JSON.stringify(model.endpointTypes),
          selectedByName.has(model.name) ? Number(selectedByName.get(model.name)) : 1, index)
      }
    })

    return {
      id: group.id,
      name: group.name,
      ratio: group.ratio,
      standardRatio: group.ratio_dynamic ? null : Number(group.ratio) / Number(draft.recharge_ratio || 1),
      models: all('SELECT id, name, selected FROM draft_models WHERE draft_group_id = ? ORDER BY sort_order, id', group.id)
        .map((model) => ({ ...model, selected: Boolean(model.selected) })),
    }
  })
  return { draftId, groups: prepared }
}

export async function prepareManualSite(input: DiscoverInput & { draftId?: number; groups: ManualGroupInput[] }) {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const existing = input.id ? one('SELECT * FROM sites WHERE id = ?', input.id) : undefined
  if (input.id && !existing) throw new Error('站点不存在')
  if (!input.groups.length) throw new Error('至少填写一个分组')
  const names = input.groups.map((group) => group.name.trim())
  if (new Set(names).size !== names.length) throw new Error('手动分组名称不能重复')
  const sameOrigin = Boolean(existing && normalizeBaseUrl(existing.base_url) === baseUrl)
  const sourceGroups = sameOrigin ? all('SELECT * FROM site_groups WHERE site_id = ?', existing!.id) : []
  const adapter = getAdapter('newapi')
  const loaded = await mapLimit(input.groups, 3, async (group, index): Promise<{
    input: ManualGroupInput
    source?: Row
    apiKey: string
    models: RemoteModel[]
    index: number
  }> => {
    const source = group.id ? sourceGroups.find((item) => item.id === group.id) : undefined
    if (group.id && !source) throw new Error(`分组「${group.name}」无法沿用：Base URL 已变化或分组不属于此站点`)
    const apiKey = group.apiKey?.trim() || decrypt(source?.api_key_enc)
    if (!apiKey) throw new Error(`请填写分组「${group.name}」的 API Key`)
    const models = await adapter.listModels(baseUrl, apiKey)
    if (!models.length) throw new Error(`分组「${group.name}」没有返回任何可用模型`)
    return { input: group, source, apiKey, models, index }
  })

  const rechargeRatio = Math.max(0.000001, Number(input.rechargeRatio || existing?.recharge_ratio || 1))
  const draftId = transaction(() => {
    if (input.draftId) {
      const previous = one('SELECT site_id FROM site_drafts WHERE id = ?', input.draftId)
      if (!previous || Number(previous.site_id || 0) !== Number(existing?.id || 0)) throw new Error('配置草稿与当前站点不匹配')
      db.prepare('DELETE FROM site_drafts WHERE id = ?').run(input.draftId)
    }
    const stamp = nowIso()
    const result = db.prepare(`
      INSERT INTO site_drafts
        (site_id, name, base_url, type, balance, currency, recharge_ratio, connection_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 'USD', ?, 'manual', ?, ?)
    `).run(existing?.id || null, input.name.trim(), baseUrl, existing?.type || 'newapi', rechargeRatio, stamp, stamp)
    const id = Number(result.lastInsertRowid)
    for (const item of loaded) {
      const groupResult = db.prepare(`
        INSERT INTO draft_groups
          (draft_id, source_group_id, external_id, name, ratio, ratio_dynamic, platform, api_key_enc,
           api_key_external_id, selected, sort_order)
        VALUES (?, ?, ?, ?, ?, 0, 'manual', ?, NULL, 1, ?)
      `).run(id, item.source?.id || null, item.source?.external_id || randomUUID(), item.input.name.trim(),
        item.input.ratio, encrypt(item.apiKey), item.source?.sort_order ?? item.index)
      const draftGroupId = Number(groupResult.lastInsertRowid)
      const previousModels = item.source ? all('SELECT name, selected FROM models WHERE group_id = ?', item.source.id) : []
      const selected = new Map(previousModels.map((model) => [model.name, Boolean(model.selected)]))
      for (const [modelIndex, model] of item.models.entries()) {
        db.prepare(`
          INSERT INTO draft_models (draft_group_id, name, endpoint_types_json, selected, sort_order)
          VALUES (?, ?, ?, ?, ?)
        `).run(draftGroupId, model.name, JSON.stringify(model.endpointTypes), selected.has(model.name) ? Number(selected.get(model.name)) : 1, modelIndex)
      }
    }
    return id
  })
  const editor = getDraftEditor(draftId)
  const prepared = all('SELECT * FROM draft_groups WHERE draft_id = ? ORDER BY sort_order, id', draftId).map((group) => ({
    id: group.id,
    name: group.name,
    ratio: group.ratio,
    standardRatio: Number(group.ratio) / rechargeRatio,
    models: all('SELECT id, name, selected FROM draft_models WHERE draft_group_id = ? ORDER BY sort_order, id', group.id)
      .map((model) => ({ ...model, selected: Boolean(model.selected) })),
  }))
  return { editor, draftId, groups: prepared }
}

export function configureSite(draftId: number, selections: Array<{ groupId: number; modelIds: number[] }>): number {
  return transaction(() => {
    const draft = one('SELECT * FROM site_drafts WHERE id = ?', draftId)
    if (!draft) throw new Error('配置草稿不存在或已过期')
    const selectedGroupIds = new Set(selections.map((item) => item.groupId))
    const draftGroups = all('SELECT * FROM draft_groups WHERE draft_id = ? ORDER BY sort_order, id', draftId)
    if (selections.some((selection) => !draftGroups.some((group) => group.id === selection.groupId))) {
      throw new Error('配置中包含不属于此草稿的分组')
    }
    let siteId = Number(draft.site_id || 0)
    if (siteId) {
      const formal = one('SELECT base_url FROM sites WHERE id = ?', siteId)
      if (!formal) throw new Error('原站点已不存在')
      if (normalizeBaseUrl(formal.base_url) !== normalizeBaseUrl(draft.base_url)) {
        db.prepare('DELETE FROM site_groups WHERE site_id = ?').run(siteId)
      }
      db.prepare(`
        UPDATE sites SET name = ?, base_url = ?, type = ?, username_enc = ?, password_enc = ?, balance = ?,
          currency = ?, recharge_ratio = ?, connection_mode = ?, config_revision = config_revision + 1,
          configured = 1, last_sync_at = ?, last_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(draft.name, draft.base_url, draft.type, draft.username_enc, draft.password_enc, draft.balance,
        draft.currency, draft.recharge_ratio, draft.connection_mode || 'auto', nowIso(), nowIso(), siteId)
    } else {
      const order = Number(one('SELECT COALESCE(MAX(sort_order), -1) AS value FROM sites')?.value) + 1
      siteId = Number(db.prepare(`
        INSERT INTO sites
          (name, base_url, type, username_enc, password_enc, balance, currency, recharge_ratio, connection_mode,
           configured, sort_order, last_sync_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(draft.name, draft.base_url, draft.type, draft.username_enc, draft.password_enc, draft.balance,
        draft.currency, draft.recharge_ratio, draft.connection_mode || 'auto', order, nowIso(), nowIso()).lastInsertRowid)
    }

    db.prepare('UPDATE site_groups SET selected = 0, available = 0 WHERE site_id = ?').run(siteId)
    const finalGroupIds = new Map<number, number>()
    for (const group of draftGroups) {
      const source = group.source_group_id
        ? one('SELECT id FROM site_groups WHERE id = ? AND site_id = ?', group.source_group_id, siteId)
        : undefined
      let finalGroupId: number
      if (source) {
        finalGroupId = source.id
        db.prepare(`
          UPDATE site_groups SET external_id = ?, name = ?, ratio = ?, ratio_dynamic = ?, platform = ?, api_key_enc = ?,
            api_key_external_id = ?, selected = ?, available = 1, sort_order = ?, updated_at = ? WHERE id = ?
        `).run(group.external_id, group.name, group.ratio, group.ratio_dynamic, group.platform, group.api_key_enc,
          group.api_key_external_id, Number(selectedGroupIds.has(group.id)), group.sort_order, nowIso(), finalGroupId)
      } else {
        finalGroupId = Number(db.prepare(`
          INSERT INTO site_groups
            (site_id, external_id, name, ratio, ratio_dynamic, platform, api_key_enc, api_key_external_id,
             selected, available, sort_order, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(siteId, group.external_id, group.name, group.ratio, group.ratio_dynamic, group.platform, group.api_key_enc,
          group.api_key_external_id, Number(selectedGroupIds.has(group.id)), group.sort_order, nowIso()).lastInsertRowid)
      }
      finalGroupIds.set(group.id, finalGroupId)
    }

    for (const selection of selections) {
      const finalGroupId = finalGroupIds.get(selection.groupId)
      if (!finalGroupId) throw new Error('配置中包含不存在的分组')
      const draftModels = all('SELECT * FROM draft_models WHERE draft_group_id = ? ORDER BY sort_order, id', selection.groupId)
      const selectedModelIds = new Set(selection.modelIds)
      if (selection.modelIds.some((id) => !draftModels.some((model) => model.id === id))) {
        throw new Error('配置中包含不属于此分组的模型')
      }
      const finalModels = all('SELECT id, name FROM models WHERE group_id = ?', finalGroupId)
      const draftNames = new Set(draftModels.map((model) => model.name))
      for (const model of draftModels) {
        const finalModel = finalModels.find((item) => item.name === model.name)
        if (finalModel) {
          db.prepare('UPDATE models SET endpoint_types_json = ?, selected = ?, sort_order = ? WHERE id = ?')
            .run(model.endpoint_types_json, Number(selectedModelIds.has(model.id)), model.sort_order, finalModel.id)
        } else {
          db.prepare('INSERT INTO models (group_id, name, endpoint_types_json, selected, sort_order) VALUES (?, ?, ?, ?, ?)')
            .run(finalGroupId, model.name, model.endpoint_types_json, Number(selectedModelIds.has(model.id)), model.sort_order)
        }
      }
      for (const model of finalModels) {
        if (!draftNames.has(model.name)) db.prepare('DELETE FROM models WHERE id = ?').run(model.id)
      }
    }
    db.prepare('DELETE FROM site_drafts WHERE id = ?').run(draftId)
    return siteId
  })
}

export function discardDraft(draftId: number): void {
  db.prepare('DELETE FROM site_drafts WHERE id = ?').run(draftId)
}

export function deleteSite(siteId: number): void {
  db.prepare('DELETE FROM sites WHERE id = ?').run(siteId)
}

export function updateExpanded(kind: 'site' | 'group', id: number, expanded: boolean): void {
  const table = kind === 'site' ? 'sites' : 'site_groups'
  db.prepare(`UPDATE ${table} SET expanded = ? WHERE id = ?`).run(Number(expanded), id)
}

export function reorder(kind: 'site' | 'group', ids: number[]): void {
  if (new Set(ids).size !== ids.length) throw new Error('排序列表包含重复项')
  const table = kind === 'site' ? 'sites' : 'site_groups'
  if (kind === 'site') {
    const expected = all('SELECT id FROM sites WHERE configured = 1').map((row) => Number(row.id)).sort((a, b) => a - b)
    const received = [...ids].sort((a, b) => a - b)
    if (expected.length !== received.length || expected.some((id, index) => id !== received[index])) {
      throw new Error('站点排序列表不完整或包含无效站点')
    }
  } else if (ids.length) {
    const rows = all(`SELECT id, site_id FROM site_groups WHERE selected = 1 AND id IN (${ids.map(() => '?').join(',')})`, ...ids)
    if (rows.length !== ids.length || new Set(rows.map((row) => row.site_id)).size !== 1) {
      throw new Error('分组排序只能包含同一站点下的已选分组')
    }
    const expected = all('SELECT id FROM site_groups WHERE site_id = ? AND selected = 1', rows[0].site_id)
      .map((row) => Number(row.id)).sort((a, b) => a - b)
    const received = [...ids].sort((a, b) => a - b)
    if (expected.length !== received.length || expected.some((id, index) => id !== received[index])) {
      throw new Error('分组排序列表不完整')
    }
  }
  transaction(() => ids.forEach((id, index) => db.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`).run(index, id)))
}

export function getSettings() {
  const row = one('SELECT * FROM settings WHERE id = 1')!
  return {
    username: decrypt(row.username_enc),
    hasPassword: Boolean(row.password_enc),
    autoCheckMinutes: Number(row.auto_check_minutes || 0),
  }
}

export function saveSettings(input: { username?: string; password?: string; autoCheckMinutes?: number }) {
  const current = one('SELECT * FROM settings WHERE id = 1')!
  const minutes = Math.max(0, Math.floor(Number(input.autoCheckMinutes ?? current.auto_check_minutes ?? 0)))
  db.prepare(`
    UPDATE settings SET username_enc = ?, password_enc = ?, auto_check_minutes = ?, updated_at = ? WHERE id = 1
  `).run(
    input.username !== undefined ? encrypt(input.username.trim()) : current.username_enc,
    input.password !== undefined ? encrypt(input.password) : current.password_enc,
    minutes,
    nowIso(),
  )
  return getSettings()
}

export function getDashboard() {
  const sites: any[] = all('SELECT * FROM sites WHERE configured = 1 ORDER BY sort_order, id').map((site) => {
    const groups = all(`
      SELECT * FROM site_groups WHERE site_id = ? AND selected = 1 ORDER BY sort_order, id
    `, site.id).map((group) => {
      const models = all(`
        SELECT m.id, m.name, m.sort_order AS sortOrder,
          h.checked_at AS checkedAt, h.success_count AS successCount, h.attempt_count AS attemptCount,
          h.avg_ttfb_ms AS avgTtfbMs, h.avg_ttft_ms AS avgTtftMs, h.avg_total_ms AS avgTotalMs,
          COALESCE(h.status, 'pending') AS status, h.attempts_json AS attemptsJson
        FROM models m
        LEFT JOIN health_checks h ON h.id = (
          SELECT id FROM health_checks
          WHERE model_id = m.id AND status <> 'pending' AND config_revision = ?
          ORDER BY checked_at DESC, id DESC LIMIT 1
        )
        WHERE m.group_id = ? AND m.selected = 1
        ORDER BY m.sort_order, m.id
      `, site.config_revision, group.id).map((model) => {
        const { attemptsJson, ...visible } = model
        return { ...visible, attempts: attemptsJson ? JSON.parse(attemptsJson) : [] }
      })
      return {
        id: group.id,
        name: group.name,
        ratio: group.ratio,
        ratioDynamic: Boolean(group.ratio_dynamic),
        standardRatio: group.ratio_dynamic ? null : Number(group.ratio) / Number(site.recharge_ratio || 1),
        platform: group.platform,
        expanded: Boolean(group.expanded),
        models,
      }
    })
    return {
      id: site.id,
      name: site.name,
      baseUrl: site.base_url,
      type: site.type,
      balance: site.balance,
      currency: site.currency,
      rechargeRatio: site.recharge_ratio,
      connectionMode: site.connection_mode || 'auto',
      balanceKnown: (site.connection_mode || 'auto') === 'auto',
      expanded: Boolean(site.expanded),
      lastSyncAt: site.last_sync_at,
      lastCheckAt: site.last_check_at,
      lastError: site.last_error,
      groups,
    }
  })
  const models: any[] = sites.flatMap((site: any) => site.groups.flatMap((group: any) => group.models))
  return {
    settings: getSettings(),
    summary: {
      sites: sites.length,
      groups: sites.reduce((sum: number, site: any) => sum + site.groups.length, 0),
      models: models.length,
      excellent: models.filter((model: any) => model.status === 'excellent').length,
      checking: models.filter((model: any) => model.status === 'pending').length,
    },
    sites,
    requestId: randomUUID(),
  }
}

export function getHealthTargets(scope: { siteId?: number; groupId?: number; modelId?: number }) {
  const clauses = ['g.selected = 1', 'm.selected = 1', 'g.available = 1']
  const params: any[] = []
  if (scope.siteId) { clauses.push('s.id = ?'); params.push(scope.siteId) }
  if (scope.groupId) { clauses.push('g.id = ?'); params.push(scope.groupId) }
  if (scope.modelId) { clauses.push('m.id = ?'); params.push(scope.modelId) }
  return all(`
    SELECT m.id AS model_id, m.name AS model_name, m.endpoint_types_json, g.id AS group_id, g.name AS group_name,
      g.api_key_enc, s.id AS site_id, s.name AS site_name, s.base_url, s.config_revision
    FROM models m
    JOIN site_groups g ON g.id = m.group_id
    JOIN sites s ON s.id = g.site_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY s.sort_order, g.sort_order, m.sort_order, m.id
  `, ...params).map((row) => ({ ...row, apiKey: decrypt(row.api_key_enc) }))
}
