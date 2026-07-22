import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { Request, RequestHandler, Response } from 'express'
import { db, nowIso } from './db.js'
import { config } from './config.js'

const cookieName = 'aimon_session'
const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000
const failureWindowMs = 15 * 60 * 1000
const failures = new Map<string, { count: number; blockedUntil: number; lastFailureAt: number }>()

export class AuthError extends Error {
  constructor(message: string, public readonly status = 401) {
    super(message)
  }
}

function passwordRow(): { admin_password_hash: string | null; admin_password_version: number } {
  return db.prepare('SELECT admin_password_hash, admin_password_version FROM settings WHERE id = 1').get() as {
    admin_password_hash: string | null; admin_password_version: number
  }
}

function validatePassword(password: string): void {
  if (password.length < 8) throw new AuthError('管理密码至少需要 8 个字符', 400)
  if (password.length > 200) throw new AuthError('管理密码不能超过 200 个字符', 400)
}

function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 })
  return `scrypt$16384$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

function applyBootstrapPassword(): void {
  if (!config.bootstrapPassword) return
  validatePassword(config.bootstrapPassword)
  const row = passwordRow()
  if (row.admin_password_hash) return
  const version = Number(row.admin_password_version || 0) + 1
  db.prepare('UPDATE settings SET admin_password_hash = ?, admin_password_version = ?, updated_at = ? WHERE id = 1')
    .run(hashPassword(config.bootstrapPassword), version, nowIso())
}

applyBootstrapPassword()

function verifyPassword(password: string, encoded: string): boolean {
  const [kind, cost, saltValue, hashValue] = encoded.split('$')
  if (kind !== 'scrypt' || cost !== '16384' || !saltValue || !hashValue) return false
  try {
    const expected = Buffer.from(hashValue, 'base64url')
    const actual = scryptSync(password, Buffer.from(saltValue, 'base64url'), expected.length, {
      N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024,
    })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

function sign(value: string): string {
  return createHmac('sha256', config.secret).update(value).digest('base64url')
}

function cookieValue(request: Request): string | undefined {
  const header = request.headers.cookie || ''
  return header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
}

function readSession(request: Request): boolean {
  const raw = cookieValue(request)
  if (!raw) return false
  const separator = raw.lastIndexOf('.')
  if (separator <= 0) return false
  const value = raw.slice(0, separator)
  const signature = raw.slice(separator + 1)
  const expected = sign(value)
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { expiresAt: number; version: number }
    const row = passwordRow()
    return Boolean(row.admin_password_hash)
      && Number.isFinite(payload.expiresAt)
      && payload.expiresAt > Date.now()
      && payload.version === Number(row.admin_password_version || 0)
  } catch {
    return false
  }
}

function secureCookie(request: Request): boolean {
  return request.secure || request.headers['x-forwarded-proto'] === 'https'
}

function issueSession(response: Response, request: Request, version: number): void {
  const value = Buffer.from(JSON.stringify({ expiresAt: Date.now() + sessionLifetimeMs, version })).toString('base64url')
  response.cookie(cookieName, `${value}.${sign(value)}`, {
    httpOnly: true,
    sameSite: 'strict',
    secure: secureCookie(request),
    maxAge: sessionLifetimeMs,
    path: '/',
  })
}

function clearSession(response: Response, request: Request): void {
  response.clearCookie(cookieName, { httpOnly: true, sameSite: 'strict', secure: secureCookie(request), path: '/' })
}

function rateKey(request: Request): string {
  return request.ip || request.socket.remoteAddress || 'unknown'
}

function assertRateLimit(request: Request): void {
  const now = Date.now()
  for (const [key, state] of failures) {
    if (state.blockedUntil <= now && now - state.lastFailureAt >= failureWindowMs) failures.delete(key)
  }
  const state = failures.get(rateKey(request))
  if (state?.blockedUntil && state.blockedUntil > Date.now()) {
    throw new AuthError('登录失败次数过多，请 15 分钟后重试', 429)
  }
}

function recordFailure(request: Request): void {
  const key = rateKey(request)
  const now = Date.now()
  const stored = failures.get(key)
  const current = stored && now - stored.lastFailureAt < failureWindowMs
    ? stored
    : { count: 0, blockedUntil: 0, lastFailureAt: now }
  current.count += 1
  current.lastFailureAt = now
  if (current.count >= 5) {
    current.count = 0
    current.blockedUntil = now + failureWindowMs
  }
  failures.set(key, current)
}

function clearFailures(request: Request): void {
  failures.delete(rateKey(request))
}

export function authStatus(request: Request): { configured: boolean; authenticated: boolean } {
  const configured = Boolean(passwordRow().admin_password_hash)
  return { configured, authenticated: configured && readSession(request) }
}

export function setupPassword(request: Request, response: Response, password: string): void {
  validatePassword(password)
  assertRateLimit(request)
  const row = passwordRow()
  if (row.admin_password_hash) throw new AuthError('管理密码已设置，请直接登录', 409)
  const version = Number(row.admin_password_version || 0) + 1
  db.prepare('UPDATE settings SET admin_password_hash = ?, admin_password_version = ?, updated_at = ? WHERE id = 1')
    .run(hashPassword(password), version, nowIso())
  clearFailures(request)
  issueSession(response, request, version)
}

export function login(request: Request, response: Response, password: string): void {
  assertRateLimit(request)
  const row = passwordRow()
  if (!row.admin_password_hash) throw new AuthError('请先设置管理密码', 409)
  if (!verifyPassword(password, row.admin_password_hash)) {
    recordFailure(request)
    throw new AuthError('管理密码不正确')
  }
  clearFailures(request)
  issueSession(response, request, Number(row.admin_password_version || 0))
}

export function changePassword(request: Request, response: Response, currentPassword: string, newPassword: string): void {
  validatePassword(newPassword)
  const row = passwordRow()
  if (!row.admin_password_hash || !verifyPassword(currentPassword, row.admin_password_hash)) {
    throw new AuthError('当前管理密码不正确')
  }
  const version = Number(row.admin_password_version || 0) + 1
  db.prepare('UPDATE settings SET admin_password_hash = ?, admin_password_version = ?, updated_at = ? WHERE id = 1')
    .run(hashPassword(newPassword), version, nowIso())
  issueSession(response, request, version)
}

export function logout(request: Request, response: Response): void {
  clearSession(response, request)
}

export const requireAppAuth: RequestHandler = (request, response, next) => {
  const row = passwordRow()
  if (!row.admin_password_hash) {
    response.status(428).json({ error: '请先设置管理密码' })
    return
  }
  if (!readSession(request)) {
    response.status(401).json({ error: '需要登录后才能访问监控数据' })
    return
  }
  next()
}
