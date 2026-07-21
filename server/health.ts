import { createHash, randomUUID } from 'node:crypto'
import { config } from './config.js'
import { db, nowIso } from './db.js'
import { extractMessage, remoteFetch } from './http.js'
import { getHealthTargets } from './site-service.js'
import type { HealthAttempt, HealthStatus } from './types.js'

interface HealthScope {
  siteId?: number
  groupId?: number
  modelId?: number
}

export interface HealthJob {
  id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  total: number
  completed: number
  current: string
  createdAt: string
  finishedAt?: string
  error?: string
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
}

const jobs = new Map<string, HealthJob>()
const jobPromises = new Map<string, Promise<void>>()
const siteSemaphores = new Map<number, Semaphore>()
const activeModels = new Map<number, { signature: string; promise: Promise<void>; checkId: number }>()

function getSiteSemaphore(siteId: number): Semaphore {
  let semaphore = siteSemaphores.get(siteId)
  if (!semaphore) {
    semaphore = new Semaphore(3)
    siteSemaphores.set(siteId, semaphore)
  }
  return semaphore
}

function average(values: Array<number | null>): number | null {
  const valid = values.filter((value): value is number => value != null && Number.isFinite(value))
  if (!valid.length) return null
  return Math.round((valid.reduce((sum, value) => sum + value, 0) / valid.length) * 10) / 10
}

function hasGeneratedText(value: any): boolean {
  if (!value || typeof value !== 'object') return false
  const candidates = [
    value.output_text,
    value.delta,
    value.text,
    value.content,
    value.choices?.[0]?.delta?.content,
    value.choices?.[0]?.message?.content,
  ]
  if (candidates.some((item) => typeof item === 'string' && item.trim())) return true
  if (!Array.isArray(value.output)) return false
  return value.output.some((item: any) => Array.isArray(item?.content)
    && item.content.some((content: any) => {
      const text = content?.text || content?.output_text
      return typeof text === 'string' && text.trim()
    }))
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
        if (firstToken == null && lines.some((line) => {
          const data = line.match(/^data:\s*(.+)$/i)?.[1]?.trim()
          if (!data || data === '[DONE]') return false
          try { return hasGeneratedText(JSON.parse(data)) } catch { return false }
        })) firstToken = elapsed
      }
      const tail = decoder.decode()
      if (responseBody.length < 16_384) responseBody += tail.slice(0, 16_384 - responseBody.length)
    } else {
      responseBody = await response.text()
      firstByte = performance.now() - started
    }

    const total = performance.now() - started
    const inspected = inspectProtocolBody(responseBody)
    if (firstToken == null && inspected.hasText) firstToken = total
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
    const ttfb = performance.now() - started
    const text = await response.text()
    const total = performance.now() - started
    let parsed: any = null
    try { parsed = JSON.parse(text) } catch { /* Report invalid JSON below. */ }
    const redirected = response.status >= 300 && response.status < 400
    const ok = response.ok && !redirected && !parsed?.error && validate(parsed)
    return {
      ok,
      ttfbMs: Math.round(ttfb * 10) / 10,
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
  const canFallback = [404, 405].includes(chat.httpStatus || 0)
    || ([400, 422].includes(chat.httpStatus || 0)
      && /responses|not supported|unsupported|chat.?completions|endpoint/i.test(`${chat.error || ''} ${chat.responseBody || ''}`))
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

async function runTarget(target: Record<string, any>, checkId: number): Promise<void> {
  const attempts: HealthAttempt[] = []
  for (let index = 0; index < config.healthAttempts; index += 1) {
    let endpointTypes: string[] = []
    try { endpointTypes = JSON.parse(target.endpoint_types_json || '[]') } catch { /* Use compatibility probing. */ }
    attempts.push(await testOnce(target.base_url, target.apiKey, target.model_name, endpointTypes))
  }
  const successes = attempts.filter((attempt) => attempt.ok)
  const status: HealthStatus = successes.length === config.healthAttempts
    ? 'excellent'
    : successes.length >= 2
      ? 'available'
      : 'failed'
  db.prepare(`
    UPDATE health_checks SET checked_at = ?, success_count = ?, attempt_count = ?, avg_ttfb_ms = ?,
      avg_ttft_ms = ?, avg_total_ms = ?, status = ?, attempts_json = ? WHERE id = ?
  `).run(
    nowIso(), successes.length, config.healthAttempts,
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

function targetSignature(target: Record<string, any>): string {
  const fingerprint = createHash('sha256').update(String(target.apiKey)).digest('hex').slice(0, 16)
  return `${target.model_id}|${target.base_url}|${fingerprint}|${target.model_name}`
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

function runModelOnce(target: Record<string, any>, checkId: number): Promise<void> {
  const existing = activeModels.get(target.model_id)
  const signature = targetSignature(target)
  if (existing?.signature === signature) return existing.promise.then(() => copyCheck(existing.checkId, checkId))

  const task = () => getSiteSemaphore(target.site_id).run(() => runTarget(target, checkId))
  const promise = (existing ? existing.promise.catch(() => undefined).then(task) : task())
    .catch((error) => {
      db.prepare(`UPDATE health_checks SET checked_at = ?, status = 'failed', attempts_json = ? WHERE id = ?`)
        .run(nowIso(), JSON.stringify([{ ok: false, error: error instanceof Error ? error.message : String(error) }]), checkId)
      throw error
    })
    .finally(() => {
      if (activeModels.get(target.model_id)?.checkId === checkId) activeModels.delete(target.model_id)
    })
  activeModels.set(target.model_id, { signature, promise, checkId })
  return promise
}

function updateSiteResults(targets: Array<Record<string, any>>): void {
  const siteIds = [...new Set(targets.map((target) => Number(target.site_id)))]
  for (const siteId of siteIds) {
    const latest = db.prepare(`
      SELECT h.status, h.attempts_json, h.checked_at FROM health_checks h
      JOIN models m ON m.id = h.model_id JOIN site_groups g ON g.id = m.group_id
      WHERE g.site_id = ? AND h.id = (
        SELECT id FROM health_checks WHERE model_id = m.id ORDER BY checked_at DESC, id DESC LIMIT 1
      ) ORDER BY h.checked_at DESC
    `).all(siteId) as Array<Record<string, any>>
    const failed = latest.find((row) => row.status === 'failed')
    let message: string | null = null
    if (failed) {
      try {
        message = JSON.parse(failed.attempts_json)?.find((attempt: any) => attempt.error)?.error || '部分模型测活失败'
      } catch {
        message = '部分模型测活失败'
      }
    }
    db.prepare('UPDATE sites SET last_check_at = ?, last_error = ? WHERE id = ?')
      .run(latest[0]?.checked_at || nowIso(), message, siteId)
  }
}

export function startHealthCheck(scope: HealthScope = {}): HealthJob {
  const targets: Array<Record<string, any>> = getHealthTargets(scope)
  if (!targets.length) throw new Error('当前范围内没有已选择的模型')
  const job: HealthJob = {
    id: randomUUID(),
    status: 'queued',
    total: targets.length,
    completed: 0,
    current: '',
    createdAt: nowIso(),
  }
  jobs.set(job.id, job)
  const checkIds = targets.map((target) => Number(db.prepare(`
    INSERT INTO health_checks (model_id, checked_at, attempt_count, status) VALUES (?, ?, ?, 'pending')
  `).run(target.model_id, nowIso(), config.healthAttempts).lastInsertRowid))

  const promise = (async () => {
    job.status = 'running'
    try {
      const results = await Promise.allSettled(targets.map(async (target, index) => {
        job.current = `${target.site_name} / ${target.group_name} / ${target.model_name}`
        try {
          await runModelOnce(target, checkIds[index])
        } finally {
          job.completed += 1
        }
      }))
      const failedCount = results.filter((result) => result.status === 'rejected').length
      job.status = failedCount ? 'failed' : 'completed'
      if (failedCount) job.error = `${failedCount} 个模型测活任务执行异常`
      job.current = ''
    } catch (error) {
      job.status = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
    } finally {
      updateSiteResults(targets)
      job.finishedAt = nowIso()
      pruneJobs()
      jobPromises.delete(job.id)
    }
  })()
  jobPromises.set(job.id, promise)
  void promise
  return job
}

function pruneJobs(): void {
  const ordered = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  for (const job of ordered.slice(50)) jobs.delete(job.id)
}

export function listJobs(): HealthJob[] {
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20)
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
