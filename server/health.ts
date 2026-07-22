import { createHash, randomUUID } from 'node:crypto'
import { config } from './config.js'
import { db, nowIso } from './db.js'
import { extractMessage, remoteFetch } from './http.js'
import { hasGeneratedText, sseLinesContainGeneratedText } from './health-protocol.js'
import { redactSensitiveText } from './privacy.js'
import { getHealthTargets, refreshHealthMetadata } from './site-service.js'
import type { HealthAttempt, HealthStatus } from './types.js'

interface HealthScope {
  siteId?: number
  groupId?: number
  modelId?: number
}

export interface HealthJob {
  id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  phase: 'refreshing' | 'checking'
  total: number
  completed: number
  current: string
  targets: HealthJobTarget[]
  createdAt: string
  finishedAt?: string
  error?: string
  refreshWarning?: string
  deduplicated?: boolean
}

export interface HealthJobTarget {
  siteId: number
  groupId: number
  modelId: number
  label: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  attempt: number
  attemptCount: number
}

class Semaphore {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active += 1
    try {
      return await task()
    } finally {
      this.active -= 1
      this.waiting.shift()?.()
    }
  }

  get idle(): boolean {
    return this.active === 0 && this.waiting.length === 0
  }
}

const jobs = new Map<string, HealthJob>()
const jobPromises = new Map<string, Promise<void>>()
const siteSemaphores = new Map<number, Semaphore>()
const activeModels = new Map<string, { promise: Promise<void>; checkId: number }>()
const activeTargetJobs = new Map<string, string>()

function getSiteSemaphore(siteId: number): Semaphore {
  let semaphore = siteSemaphores.get(siteId)
  if (!semaphore) {
    semaphore = new Semaphore(3)
    siteSemaphores.set(siteId, semaphore)
  }
  return semaphore
}

async function runForSite<T>(siteId: number, task: () => Promise<T>): Promise<T> {
  const semaphore = getSiteSemaphore(siteId)
  try {
    return await semaphore.run(task)
  } finally {
    if (semaphore.idle && siteSemaphores.get(siteId) === semaphore) siteSemaphores.delete(siteId)
  }
}

function average(values: Array<number | null>): number | null {
  const valid = values.filter((value): value is number => value != null && Number.isFinite(value))
  if (!valid.length) return null
  return Math.round((valid.reduce((sum, value) => sum + value, 0) / valid.length) * 10) / 10
}

function inspectProtocolBody(body: string): { hasText: boolean; error: string } {
  const trimmed = body.trim()
  try {
    const parsed = JSON.parse(trimmed)
    return { hasText: hasGeneratedText(parsed), error: parsed?.error ? extractMessage(parsed) : '' }
  } catch { /* SSE is parsed below. */ }

  let hasText = false
  let protocolError = ''
  for (const line of body.split(/\r?\n/)) {
    const data = line.match(/^data:\s*(.+)$/i)?.[1]?.trim()
    if (!data || data === '[DONE]') continue
    try {
      const event = JSON.parse(data)
      if (event?.error) protocolError ||= extractMessage(event)
      if (hasGeneratedText(event)) hasText = true
    } catch { /* A truncated diagnostic tail is not treated as generated text. */ }
  }
  return { hasText, error: protocolError }
}

async function streamingAttempt(
  baseUrl: string,
  key: string,
  pathname: string,
  body: Record<string, unknown>,
): Promise<HealthAttempt & { responseBody?: string }> {
  const started = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs)
  try {
    const response = await remoteFetch(baseUrl, pathname, {
      method: 'POST',
      signal: controller.signal,
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
        'User-Agent': 'AIMon/1.0',
      },
      body: JSON.stringify(body),
    }, config.requestTimeoutMs)
    const browserFallback = response.headers.get('x-aimon-browser-fallback') === '1'
    const browserTtfb = Number(response.headers.get('x-aimon-browser-ttfb-ms'))
    const browserTtft = Number(response.headers.get('x-aimon-browser-ttft-ms'))
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let firstByte: number | null = null
    let firstToken: number | null = null
    let responseBody = ''
    let scanBuffer = ''
    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const elapsed = performance.now() - started
        if (firstByte == null) firstByte = elapsed
        const chunk = decoder.decode(value, { stream: true })
        if (responseBody.length < 16_384) responseBody += chunk.slice(0, 16_384 - responseBody.length)
        scanBuffer += chunk
        const lines = scanBuffer.split(/\r?\n/)
        scanBuffer = lines.pop() || ''
        if (scanBuffer.length > 32_768) scanBuffer = scanBuffer.slice(-32_768)
        if (firstToken == null && sseLinesContainGeneratedText(lines)) firstToken = elapsed
      }
      const tail = decoder.decode()
      if (responseBody.length < 16_384) responseBody += tail.slice(0, 16_384 - responseBody.length)
    } else {
      responseBody = await response.text()
      firstByte = performance.now() - started
    }

    const total = performance.now() - started
    if (browserFallback) {
      firstByte = Number.isFinite(browserTtfb) ? browserTtfb : null
      firstToken = Number.isFinite(browserTtft) && browserTtft > 0 ? browserTtft : null
    }
    const inspected = inspectProtocolBody(responseBody)
    if (!browserFallback && firstToken == null && inspected.hasText) firstToken = total
    const redirected = response.status >= 300 && response.status < 400
    const contentType = response.headers.get('content-type') || ''
    const looksHtml = /text\/html/i.test(contentType) || /^\s*(?:<!doctype|<html)/i.test(responseBody)
    const ok = response.ok && !redirected && !looksHtml && !inspected.error && inspected.hasText
    return {
      ok,
      ttfbMs: firstByte == null ? null : Math.round(firstByte * 10) / 10,
      ttftMs: firstToken == null ? null : Math.round(firstToken * 10) / 10,
      totalMs: Math.round(total * 10) / 10,
      httpStatus: response.status,
      error: ok ? undefined : inspected.error
        || (redirected ? '远端请求发生重定向，已拒绝跟随' : '')
        || (looksHtml ? '远端返回了 HTML 页面而不是模型响应' : '')
        || responseBody.slice(0, 300)
        || `HTTP ${response.status}：未返回有效文本`,
      responseBody,
    }
  } catch (error) {
    const total = performance.now() - started
    return {
      ok: false,
      ttfbMs: null,
      ttftMs: null,
      totalMs: Math.round(total * 10) / 10,
      httpStatus: null,
      error: error instanceof Error && error.name === 'AbortError'
        ? `请求超时（${config.requestTimeoutMs}ms）`
        : (error instanceof Error ? error.message : String(error)),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function jsonAttempt(
  baseUrl: string,
  key: string,
  pathname: string,
  body: Record<string, unknown>,
  validate: (body: any) => boolean,
  extraHeaders: Record<string, string> = {},
): Promise<HealthAttempt> {
  const started = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs)
  try {
    const response = await remoteFetch(baseUrl, pathname, {
      method: 'POST',
      signal: controller.signal,
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'AIMon/1.0',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    }, config.requestTimeoutMs)
    const browserFallback = response.headers.get('x-aimon-browser-fallback') === '1'
    const reportedTtfb = Number(response.headers.get('x-aimon-browser-ttfb-ms'))
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let firstByte: number | null = null
    let text = ''
    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (firstByte == null) firstByte = performance.now() - started
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
    } else {
      text = await response.text()
      firstByte = performance.now() - started
    }
    const ttfb = browserFallback && Number.isFinite(reportedTtfb) ? reportedTtfb : firstByte
    const total = performance.now() - started
    let parsed: any = null
    try { parsed = JSON.parse(text) } catch { /* Report invalid JSON below. */ }
    const redirected = response.status >= 300 && response.status < 400
    const ok = response.ok && !redirected && !parsed?.error && validate(parsed)
    return {
      ok,
      ttfbMs: ttfb == null ? null : Math.round(ttfb * 10) / 10,
      ttftMs: null,
      totalMs: Math.round(total * 10) / 10,
      httpStatus: response.status,
      error: ok ? undefined : extractMessage(parsed)
        || (redirected ? '远端请求发生重定向，已拒绝跟随' : '')
        || text.slice(0, 300)
        || `HTTP ${response.status}：未返回有效结果`,
    }
  } catch (error) {
    const total = performance.now() - started
    return {
      ok: false,
      ttfbMs: null,
      ttftMs: null,
      totalMs: Math.round(total * 10) / 10,
      httpStatus: null,
      error: error instanceof Error && error.name === 'AbortError'
        ? `请求超时（${config.requestTimeoutMs}ms）`
        : (error instanceof Error ? error.message : String(error)),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function testOnce(baseUrl: string, key: string, model: string, endpointTypes: string[]): Promise<HealthAttempt> {
  const types = new Set(endpointTypes)
  if (!types.has('openai') && types.has('openai-response')) {
    const responses = await streamingAttempt(baseUrl, key, '/v1/responses', {
      model, input: 'Reply with OK.', stream: true, max_output_tokens: 16,
    })
    const { responseBody: _, ...result } = responses
    return result
  }
  if (!types.has('openai') && types.has('embeddings')) {
    return jsonAttempt(baseUrl, key, '/v1/embeddings', { model, input: 'hi' },
      (body) => Array.isArray(body?.data?.[0]?.embedding) && body.data[0].embedding.length > 0)
  }
  if (!types.has('openai') && types.has('image-generation')) {
    return jsonAttempt(baseUrl, key, '/v1/images/generations', { model, prompt: 'A small green circle', n: 1 },
      (body) => Boolean(body?.data?.[0]?.url || body?.data?.[0]?.b64_json))
  }
  if (!types.has('openai') && types.has('jina-rerank')) {
    return jsonAttempt(baseUrl, key, '/v1/rerank', { model, query: 'hello', documents: ['hello world', 'goodbye'] },
      (body) => Array.isArray(body?.results || body?.data))
  }
  if (!types.has('openai') && types.has('anthropic')) {
    return jsonAttempt(baseUrl, key, '/v1/messages', {
      model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with OK.' }],
    }, (body) => Array.isArray(body?.content) && body.content.some((item: any) => typeof item?.text === 'string' && item.text.trim()), {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    })
  }
  if (!types.has('openai') && types.has('gemini')) {
    return jsonAttempt(baseUrl, key, `/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }],
      generationConfig: { maxOutputTokens: 16 },
    }, (body) => Array.isArray(body?.candidates)
      && body.candidates.some((candidate: any) => candidate?.content?.parts?.some((part: any) => typeof part?.text === 'string' && part.text.trim())))
  }
  if (types.size && !types.has('openai')) {
    return {
      ok: false,
      ttfbMs: null,
      ttftMs: null,
      totalMs: 0,
      httpStatus: null,
      error: `暂不支持自动探测端点类型：${[...types].join(', ')}`,
    }
  }
  const chat = await streamingAttempt(baseUrl, key, '/v1/chat/completions', {
    model,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    stream: true,
  })
  if (chat.ok) {
    const { responseBody: _, ...result } = chat
    return result
  }
  const chatDiagnostic = `${chat.error || ''} ${chat.responseBody || ''}`
  const canRetryWithoutStreaming = [400, 405, 415, 422].includes(chat.httpStatus || 0)
    && /stream|streaming|text\/event-stream/i.test(chatDiagnostic)
  if (canRetryWithoutStreaming) {
    const nonStreaming = await jsonAttempt(baseUrl, key, '/v1/chat/completions', {
      model,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      stream: false,
    }, (body) => hasGeneratedText(body))
    if (nonStreaming.ok) return nonStreaming
  }
  const canFallback = [404, 405].includes(chat.httpStatus || 0)
    || ([400, 422].includes(chat.httpStatus || 0)
      && /responses|not supported|unsupported|chat.?completions|endpoint/i.test(chatDiagnostic))
  if (!canFallback) {
    const { responseBody: _, ...result } = chat
    return result
  }
  const responses = await streamingAttempt(baseUrl, key, '/v1/responses', {
    model,
    input: 'Reply with OK.',
    stream: true,
    max_output_tokens: 16,
  })
  const { responseBody: _, ...result } = responses
  return result
}

async function runTarget(
  target: Record<string, any>,
  checkId: number,
  attemptCount: number,
  onAttempt?: (attempt: number) => void,
): Promise<void> {
  const attempts: HealthAttempt[] = []
  for (let index = 0; index < attemptCount; index += 1) {
    onAttempt?.(index + 1)
    let endpointTypes: string[] = []
    try { endpointTypes = JSON.parse(target.endpoint_types_json || '[]') } catch { /* Use compatibility probing. */ }
    const attempt = await testOnce(target.base_url, target.apiKey, target.model_name, endpointTypes)
    if (attempt.error) attempt.error = redactSensitiveText(attempt.error, [target.apiKey])
    attempts.push(attempt)
  }
  const successes = attempts.filter((attempt) => attempt.ok)
  const status: HealthStatus = successes.length === attemptCount
    ? 'excellent'
    : successes.length >= Math.ceil(attemptCount * 2 / 3)
      ? 'available'
      : 'failed'
  db.prepare(`
    UPDATE health_checks SET checked_at = ?, success_count = ?, attempt_count = ?, avg_ttfb_ms = ?,
      avg_ttft_ms = ?, avg_total_ms = ?, status = ?, attempts_json = ? WHERE id = ?
  `).run(
    nowIso(), successes.length, attemptCount,
    average(successes.map((attempt) => attempt.ttfbMs)),
    average(successes.map((attempt) => attempt.ttftMs)),
    average(successes.map((attempt) => attempt.totalMs)),
    status, JSON.stringify(attempts), checkId,
  )
  db.prepare(`
    DELETE FROM health_checks WHERE model_id = ? AND id NOT IN (
      SELECT id FROM health_checks WHERE model_id = ? ORDER BY checked_at DESC, id DESC LIMIT 20
    )
  `).run(target.model_id, target.model_id)
}

function targetSignature(target: Record<string, any>, attemptCount: number): string {
  const fingerprint = createHash('sha256').update(String(target.apiKey)).digest('hex').slice(0, 16)
  return `${target.model_id}|${target.config_revision}|${target.base_url}|${fingerprint}|${target.model_name}|${attemptCount}`
}

function copyCheck(fromId: number, toId: number): void {
  const source = db.prepare(`SELECT * FROM health_checks WHERE id = ? AND status <> 'pending'`).get(fromId) as Record<string, any> | undefined
  if (!source) throw new Error('并行测活未生成可复用结果')
  db.prepare(`
    UPDATE health_checks SET checked_at = ?, success_count = ?, attempt_count = ?, avg_ttfb_ms = ?,
      avg_ttft_ms = ?, avg_total_ms = ?, status = ?, attempts_json = ? WHERE id = ?
  `).run(nowIso(), source.success_count, source.attempt_count, source.avg_ttfb_ms,
    source.avg_ttft_ms, source.avg_total_ms, source.status, source.attempts_json, toId)
}

function runModelOnce(
  target: Record<string, any>,
  checkId: number,
  attemptCount: number,
  onStart?: () => void,
  onAttempt?: (attempt: number) => void,
): Promise<void> {
  const signature = targetSignature(target, attemptCount)
  const existing = activeModels.get(signature)
  if (existing) return existing.promise.then(() => copyCheck(existing.checkId, checkId))

  const task = () => runForSite(Number(target.site_id), async () => {
    onStart?.()
    await runTarget(target, checkId, attemptCount, onAttempt)
  })
  const promise = task()
    .catch((error) => {
      const message = redactSensitiveText(error, [target.apiKey])
      db.prepare(`UPDATE health_checks SET checked_at = ?, status = 'failed', attempts_json = ? WHERE id = ?`)
        .run(nowIso(), JSON.stringify([{ ok: false, error: message }]), checkId)
      throw new Error(message)
    })
    .finally(() => {
      if (activeModels.get(signature)?.checkId === checkId) activeModels.delete(signature)
    })
  activeModels.set(signature, { promise, checkId })
  return promise
}

function targetActivityKey(target: Record<string, any>): string {
  return `${target.model_id}:${target.config_revision}`
}

function updateSiteResults(targets: Array<Record<string, any>>): void {
  const scopes = new Map<string, { siteId: number; configRevision: number }>()
  for (const target of targets) {
    const siteId = Number(target.site_id)
    const configRevision = Number(target.config_revision)
    scopes.set(`${siteId}:${configRevision}`, { siteId, configRevision })
  }
  for (const { siteId, configRevision } of scopes.values()) {
    const latest = db.prepare(`
      SELECT h.status, h.attempts_json, h.checked_at FROM health_checks h
      JOIN models m ON m.id = h.model_id JOIN site_groups g ON g.id = m.group_id
      WHERE g.site_id = ? AND h.id = (
        SELECT id FROM health_checks
        WHERE model_id = m.id AND config_revision = ?
        ORDER BY checked_at DESC, id DESC LIMIT 1
      ) ORDER BY h.checked_at DESC
    `).all(siteId, configRevision) as Array<Record<string, any>>
    if (!latest.length) continue
    const failed = latest.find((row) => row.status === 'failed')
    let message: string | null = null
    if (failed) {
      try {
        message = JSON.parse(failed.attempts_json)?.find((attempt: any) => attempt.error)?.error || '部分模型测活失败'
      } catch {
        message = '部分模型测活失败'
      }
    }
    db.prepare('UPDATE sites SET last_check_at = ?, last_error = ? WHERE id = ? AND config_revision = ?')
      .run(latest[0]?.checked_at || nowIso(), message, siteId, configRevision)
  }
}

export function startHealthCheck(scope: HealthScope = {}): HealthJob {
  const requestedTargets: Array<Record<string, any>> = getHealthTargets(scope)
  if (!requestedTargets.length) throw new Error('当前范围内没有已选择的模型')
  const targets = requestedTargets.filter((target) => !activeTargetJobs.has(targetActivityKey(target)))
  if (!targets.length) {
    const existing = requestedTargets
      .map((target) => jobs.get(activeTargetJobs.get(targetActivityKey(target)) || ''))
      .find((job): job is HealthJob => Boolean(job && (job.status === 'queued' || job.status === 'running')))
    if (existing) {
      if (!scope.modelId) {
        void refreshHealthMetadata(scope).then((warnings) => {
          if (warnings.length) existing.refreshWarning = [existing.refreshWarning, ...warnings].filter(Boolean).join('；')
        }).catch((error) => {
          existing.refreshWarning = [existing.refreshWarning, `站点信息同步失败：${redactSensitiveText(error)}`]
            .filter(Boolean).join('；')
        })
      }
      return { ...existing, deduplicated: true }
    }
  }
  if (!targets.length) throw new Error('当前范围内的模型已在测活')
  const settings = db.prepare('SELECT health_attempts FROM settings WHERE id = 1').get() as Record<string, any> | undefined
  const attemptCount = Math.max(1, Math.min(10, Math.floor(Number(settings?.health_attempts || 3))))
  const job: HealthJob = {
    id: randomUUID(),
    status: 'queued',
    phase: scope.modelId ? 'checking' : 'refreshing',
    total: targets.length,
    completed: 0,
    current: '',
    targets: targets.map((target) => ({
      siteId: Number(target.site_id),
      groupId: Number(target.group_id),
      modelId: Number(target.model_id),
      label: `${target.site_name} / ${target.group_name} / ${target.model_name}`,
      status: 'queued',
      attempt: 0,
      attemptCount,
    })),
    createdAt: nowIso(),
    deduplicated: targets.length < requestedTargets.length || undefined,
  }
  jobs.set(job.id, job)
  const checkIds = targets.map((target) => Number(db.prepare(`
    INSERT INTO health_checks (model_id, checked_at, attempt_count, config_revision, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(target.model_id, nowIso(), attemptCount, target.config_revision).lastInsertRowid))
  for (const target of targets) activeTargetJobs.set(targetActivityKey(target), job.id)

  const promise = new Promise<void>((resolve) => {
    setImmediate(() => {
      void executeHealthJob(job, scope, targets, checkIds, attemptCount).finally(resolve)
    })
  })
  jobPromises.set(job.id, promise)
  return job
}

async function executeHealthJob(
  job: HealthJob,
  scope: HealthScope,
  targets: Array<Record<string, any>>,
  checkIds: number[],
  attemptCount: number,
): Promise<void> {
    job.status = 'running'
    try {
      const metadataBySite = new Map<number, Promise<void>>()
      if (!scope.modelId) {
        for (const target of targets) {
          const siteId = Number(target.site_id)
          if (metadataBySite.has(siteId)) continue
          const metadataScope = scope.groupId ? { groupId: scope.groupId } : { siteId }
          metadataBySite.set(siteId, refreshHealthMetadata(metadataScope)
            .then((warnings) => {
              if (warnings.length) {
                job.refreshWarning = [job.refreshWarning, ...warnings].filter(Boolean).join('；')
              }
            })
            .catch((error) => {
              job.refreshWarning = [job.refreshWarning, `站点信息同步失败：${redactSensitiveText(error)}`]
                .filter(Boolean).join('；')
            }))
        }
      }
      const results = await Promise.allSettled(targets.map(async (target, index) => {
        const jobTarget = job.targets[index]
        try {
          await metadataBySite.get(Number(target.site_id))
          job.phase = 'checking'
          await runModelOnce(target, checkIds[index], attemptCount, () => {
            jobTarget.status = 'running'
            job.current = jobTarget.label
          }, (attempt) => {
            jobTarget.attempt = attempt
          })
          jobTarget.status = 'completed'
        } catch (error) {
          jobTarget.status = 'failed'
          throw error
        } finally {
          job.completed += 1
          const activityKey = targetActivityKey(target)
          if (activeTargetJobs.get(activityKey) === job.id) activeTargetJobs.delete(activityKey)
        }
      }))
      const failedCount = results.filter((result) => result.status === 'rejected').length
      job.status = failedCount ? 'failed' : 'completed'
      if (failedCount) job.error = `${failedCount} 个模型测活任务执行异常`
      job.current = ''
    } catch (error) {
      job.status = 'failed'
      job.error = redactSensitiveText(error)
      const failure = JSON.stringify([{ ok: false, error: job.error }])
      for (const [index, checkId] of checkIds.entries()) {
        db.prepare(`
          UPDATE health_checks SET checked_at = ?, status = 'failed', attempts_json = ?
          WHERE id = ? AND status = 'pending'
        `).run(nowIso(), failure, checkId)
        if (job.targets[index]?.status === 'queued' || job.targets[index]?.status === 'running') {
          job.targets[index].status = 'failed'
        }
      }
      job.completed = job.total
    } finally {
      for (const target of targets) {
        const activityKey = targetActivityKey(target)
        if (activeTargetJobs.get(activityKey) === job.id) activeTargetJobs.delete(activityKey)
      }
      updateSiteResults(targets)
      job.finishedAt = nowIso()
      pruneJobs()
      jobPromises.delete(job.id)
    }
}

function pruneJobs(): void {
  const completed = [...jobs.values()]
    .filter((job) => job.status !== 'queued' && job.status !== 'running')
    .sort((a, b) => (b.finishedAt || b.createdAt).localeCompare(a.finishedAt || a.createdAt))
  for (const job of completed.slice(50)) jobs.delete(job.id)
}

export function listJobs(): HealthJob[] {
  const active = [...jobs.values()]
    .filter((job) => job.status === 'queued' || job.status === 'running')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const recent = [...jobs.values()]
    .filter((job) => job.status !== 'queued' && job.status !== 'running')
    .sort((a, b) => (b.finishedAt || b.createdAt).localeCompare(a.finishedAt || a.createdAt))
    .slice(0, 20)
  return [...active, ...recent]
}

export function listActiveJobs(): HealthJob[] {
  return [...jobs.values()]
    .filter((job) => job.status === 'queued' || job.status === 'running')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function hasActiveHealthForSite(siteId: number): boolean {
  return [...jobs.values()].some((job) => (
    (job.status === 'queued' || job.status === 'running')
    && job.targets.some((target) => target.siteId === siteId)
  ))
}

export function startAutoHealthScheduler(): NodeJS.Timeout {
  let autoRunning = false
  return setInterval(() => {
    if (autoRunning) return
    const row = db.prepare('SELECT auto_check_minutes, last_auto_check_at FROM settings WHERE id = 1').get() as Record<string, any>
    const minutes = Number(row?.auto_check_minutes || 0)
    if (minutes <= 0) return
    const last = row?.last_auto_check_at ? new Date(row.last_auto_check_at).getTime() : 0
    if (Date.now() - last < minutes * 60_000) return
    try {
      const job = startHealthCheck()
      autoRunning = true
      void jobPromises.get(job.id)?.finally(() => {
        db.prepare('UPDATE settings SET last_auto_check_at = ? WHERE id = 1').run(nowIso())
        autoRunning = false
      })
    } catch {
      db.prepare('UPDATE settings SET last_auto_check_at = ? WHERE id = 1').run(nowIso())
    }
  }, 15_000)
}
