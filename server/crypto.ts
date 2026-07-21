import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { config } from './config.js'

const key = scryptSync(config.secret, 'aimon:v1', 32)

export function encrypt(value: string | null | undefined): string | null {
  if (!value) return null
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`
}

export function decrypt(value: string | null | undefined): string {
  if (!value) return ''
  const [version, iv, tag, payload] = value.split('.')
  if (version !== 'v1' || !iv || !tag || !payload) throw new Error('无法解密已保存的敏感配置')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(payload, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}
