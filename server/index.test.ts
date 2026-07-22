import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./db.js', () => ({ db: {}, nowIso: () => new Date().toISOString() }))

import { config } from './config.js'
import { app } from './index.js'

describe('HTTP application boundaries', () => {
  it('maps unsupported JSON encodings to a client error instead of HTTP 500', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json; charset=madeup')
      .send('{}')

    expect(response.status).toBe(415)
    expect(response.body).toEqual({ error: 'Unsupported request body encoding' })
  })

  it('uses the configured trust proxy policy', () => {
    expect(app.get('trust proxy')).toBe(config.trustProxy)
  })
})
