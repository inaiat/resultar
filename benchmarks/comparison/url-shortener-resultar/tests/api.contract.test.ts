import type { FastifyInstance } from 'fastify'
import type { Static } from 'typebox'

import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

import type { UrlResponse } from '../src/application/routes/url.schemas.js'

import { build } from './helpers/helper.js'

const javaScriptUrl = ['javascript', 'alert(1)'].join(':')
type UrlResponseBody = Static<typeof UrlResponse>

describe('URL API contract', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await build()
  })

  afterAll(async () => {
    await app.close()
  })

  it('supports the create, redirect, and delete lifecycle', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1',
      payload: { originalUrl: 'https://lifecycle.example/path' },
    })

    expect(createResponse.statusCode).toBe(201)
    const created = createResponse.json<{ success: boolean; data: UrlResponseBody }>()
    expect(created).toMatchObject({
      success: true,
      data: { originalUrl: 'https://lifecycle.example/path', accessCount: 0, isActive: true },
    })
    expect(created.data.id).toEqual(expect.any(String))
    expect(created.data.shortCode).toEqual(expect.any(String))
    expect(created.data.createdAt).toEqual(expect.any(String))

    const redirectResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/${created.data.shortCode}`,
    })
    expect(redirectResponse.statusCode).toBe(302)
    expect(redirectResponse.headers.location).toBe('https://lifecycle.example/path')
    expect(redirectResponse.headers['content-length']).toBe('0')

    const deleteResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/${created.data.shortCode}/delete`,
    })
    expect(deleteResponse.statusCode).toBe(200)
    expect(deleteResponse.json()).toEqual({
      success: true,
      message: `URL '${created.data.shortCode}' deleted successfully`,
    })

    const deletedResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/${created.data.shortCode}`,
    })
    expect(deletedResponse.statusCode).toBe(404)
    expect(deletedResponse.json()).toMatchObject({
      error: expect.stringContaining('URL not found'),
    })
  })

  it('uses a custom alias as the public short code and rejects collisions', async () => {
    const customAlias = 'contract-alias'
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1',
      payload: { originalUrl: 'https://alias.example', customAlias },
    })

    expect(createResponse.statusCode).toBe(201)
    expect(createResponse.json()).toMatchObject({
      success: true,
      data: { shortCode: customAlias, customAlias },
    })

    const collisionResponse = await app.inject({
      method: 'POST',
      url: '/api/v1',
      payload: { originalUrl: 'https://collision.example', customAlias },
    })
    expect(collisionResponse.statusCode).toBe(409)
    expect(collisionResponse.json()).toMatchObject({
      error: expect.stringContaining('Custom alias already exists'),
    })
  })

  it.each([
    ['malformed URL', { originalUrl: 'not-a-url' }],
    ['JavaScript URL', { originalUrl: javaScriptUrl }],
    ['FTP URL', { originalUrl: 'ftp://files.example/archive' }],
    ['reserved alias', { originalUrl: 'https://example.com', customAlias: 'stats' }],
    ['invalid expiration', { originalUrl: 'https://example.com', expiresAt: 'not-a-date' }],
  ])('rejects a %s', async (_label, payload) => {
    const response = await app.inject({ method: 'POST', url: '/api/v1', payload })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toHaveProperty('error')
  })

  it('normalizes malformed request errors', async () => {
    const missingBody = await app.inject({ method: 'POST', url: '/api/v1' })
    const invalidJson = await app.inject({
      method: 'POST',
      url: '/api/v1',
      payload: 'invalid json',
      headers: { 'content-type': 'application/json' },
    })

    for (const response of [missingBody, invalidJson]) {
      expect(response.statusCode).toBe(400)
      expect(response.json()).toHaveProperty('error')
      expect(response.json()).not.toHaveProperty('statusCode')
    }
  })

  it('returns recent and popular URL statistics', async () => {
    const expiredResponse = await app.inject({
      method: 'POST',
      url: '/api/v1',
      payload: {
        originalUrl: 'https://expired.example',
        customAlias: 'expired-stats-entry',
        expiresAt: '2020-01-01T00:00:00.000Z',
      },
    })
    expect(expiredResponse.statusCode).toBe(201)

    const recentResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/stats?type=recent&limit=5',
    })
    const popularResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/stats?type=popular&limit=3',
    })

    for (const [response, limit] of [
      [recentResponse, 5],
      [popularResponse, 3],
    ] as const) {
      expect(response.statusCode).toBe(200)
      const result = response.json<{ success: boolean; data: UrlResponseBody[] }>()
      expect(result.success).toBe(true)
      expect(result.data.length).toBeLessThanOrEqual(limit)
      expect(result.data).not.toContainEqual(
        expect.objectContaining({ shortCode: 'expired-stats-entry' }),
      )
      for (const url of result.data) {
        expect(url).toMatchObject({
          id: expect.any(String),
          shortCode: expect.any(String),
          originalUrl: expect.any(String),
          accessCount: expect.any(Number),
          createdAt: expect.any(String),
          isActive: true,
        })
      }
    }
  })

  it('uses stats defaults and rejects invalid query parameters', async () => {
    const defaultResponse = await app.inject({ method: 'GET', url: '/api/v1/stats' })
    expect(defaultResponse.statusCode).toBe(200)
    expect(defaultResponse.json<{ data: UrlResponseBody[] }>().data.length).toBeLessThanOrEqual(10)

    for (const url of ['/api/v1/stats?type=invalid&limit=999', '/api/v1/stats?limit=1.5']) {
      const invalidResponse = await app.inject({ method: 'GET', url })
      expect(invalidResponse.statusCode).toBe(400)
      expect(invalidResponse.json()).toEqual({ error: expect.any(String) })
    }
  })

  it('returns not found for unknown identifiers', async () => {
    const redirectResponse = await app.inject({ method: 'GET', url: '/api/v1/unknown-code' })
    const deleteResponse = await app.inject({ method: 'POST', url: '/api/v1/unknown-code/delete' })

    expect(redirectResponse.statusCode).toBe(404)
    expect(deleteResponse.statusCode).toBe(404)
  })
})
