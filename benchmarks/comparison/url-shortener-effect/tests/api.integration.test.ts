import { Effect, Layer, Logger } from 'effect'
import { HttpRouter, HttpServer } from 'effect/http'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

import { HttpAppLive } from '../src/app.js'
import { DatabaseError } from '../src/domain/errors/url.errors.js'
import { UrlService } from '../src/domain/usecase/url.usecase.js'
import { build } from './helpers/helper.js'

describe('API Integration Tests', () => {
  let app: ReturnType<typeof build>
  let createdShortCode: string

  beforeAll(() => {
    // Use the same mock infrastructure as contract tests
    app = build()
  })

  afterAll(async () => {
    await app.close()
  })

  describe('POST /api/v1 - Create Short URL', () => {
    it('should create a short URL successfully', async () => {
      const response = await app.request({
        method: 'POST',
        url: '/api/v1',
        payload: { originalUrl: 'https://www.integration-test.com' },
      })

      expect(response.status).toBe(201)
      const result = JSON.parse(await response.text())

      expect(result.success).toBeTruthy()
      expect(result.data).toBeTruthy()
      expect(result.data.originalUrl).toEqual('https://www.integration-test.com')
      expect(result.data.shortCode).toBeTruthy()
      expect(result.data.accessCount).toBe(0)
      expect(result.data.isActive).toBeTruthy()
      expect(result.data.createdAt).toBeTruthy()

      // Store for subsequent tests
      createdShortCode = result.data.shortCode
    })

    it('should reject custom alias that collides with an existing short code', async () => {
      const response = await app.request({
        method: 'POST',
        url: '/api/v1',
        payload: { originalUrl: 'https://www.collision-test.com', customAlias: createdShortCode },
      })

      expect(response.status).toBe(409)
      const result = JSON.parse(await response.text())
      expect(result.error).toEqual(expect.stringContaining('Custom alias already exists'))
    })

    it('should create a short URL with custom alias', async () => {
      const customAlias = `test-alias-${Math.random().toString(36).slice(2, 15)}`
      const response = await app.request({
        method: 'POST',
        url: '/api/v1',
        payload: { originalUrl: 'https://www.custom-alias-test.com', customAlias },
      })

      expect(response.status).toBe(201)
      const result = JSON.parse(await response.text())

      expect(result.success).toBeTruthy()
      expect(result.data.customAlias).toEqual(customAlias)
    })

    it('should return error for invalid URL', async () => {
      const response = await app.request({
        method: 'POST',
        url: '/api/v1',
        payload: { originalUrl: 'invalid-url' },
      })

      expect(response.status).toBe(400)
      const result = JSON.parse(await response.text())
      expect(result.success).toBe(false)
      expect(result.error).toBeTruthy()
      expect(result.error).toEqual(expect.stringContaining('Invalid URL'))
    })
  })

  describe('GET /api/v1/:shortCode - Redirect to Original URL', () => {
    it('should redirect to original URL for active short code', async () => {
      const response = await app.request({ method: 'GET', url: `/api/v1/${createdShortCode}` })

      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe('https://www.integration-test.com')
    })

    it('should return 404 for non-existent short code', async () => {
      const response = await app.request({ method: 'GET', url: '/api/v1/nonexistentcode' })

      expect(response.status).toBe(404)
      const result = JSON.parse(await response.text())
      expect(result.success).toBe(false)
      expect(result.error).toEqual(expect.stringContaining('URL not found'))
    })
  })

  describe('POST /api/v1/:shortCode/delete - Soft Delete URL', () => {
    it('should soft delete an active URL', async () => {
      const response = await app.request({
        method: 'POST',
        url: `/api/v1/${createdShortCode}/delete`,
      })

      expect(response.status).toBe(200)
      const result = JSON.parse(await response.text())
      expect(result.success).toBeTruthy()
      expect(result.message).toEqual(expect.stringContaining('deleted successfully'))
    })

    it('should return 404 when trying to access deleted URL', async () => {
      const response = await app.request({ method: 'GET', url: `/api/v1/${createdShortCode}` })

      expect(response.status).toBe(404)
      const result = JSON.parse(await response.text())
      expect(result.success).toBe(false)
      expect(result.error).toEqual(expect.stringContaining('URL not found'))
    })

    it('should return 404 when trying to delete non-existent URL', async () => {
      const response = await app.request({ method: 'POST', url: '/api/v1/nonexistent/delete' })

      expect(response.status).toBe(404)
      const result = JSON.parse(await response.text())
      expect(result.success).toBe(false)
    })
  })

  describe('GET /api/v1/stats', () => {
    it('excludes expired URLs from recent stats', async () => {
      const originalUrl = 'https://example.com/expired-stats-fixture'
      const created = await app.request({
        method: 'POST',
        url: '/api/v1',
        payload: { originalUrl, expiresAt: '2000-01-01T00:00:00Z' },
      })
      expect(created.status).toBe(201)

      const response = await app.request({ url: '/api/v1/stats?limit=100' })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        success: true,
        data: expect.not.arrayContaining([expect.objectContaining({ originalUrl })]),
      })
    })
  })

  describe('GET /health - Health Check', () => {
    it('should return health status', async () => {
      const response = await app.request({ method: 'GET', url: '/health' })

      expect(response.status).toBe(200)
      const result = JSON.parse(await response.text())

      expect(result.ok).toEqual(expect.any(Number))
      expect(result.ok).toBeGreaterThan(0)
    })
  })

  describe('5xx error sanitization', () => {
    it('logs full DatabaseError server-side and returns a generic message for 500 responses', async () => {
      const logged: unknown[] = []
      const failingError = DatabaseError.query(new Error('connect ECONNREFUSED 10.0.0.42:27017'))
      const failingService = Layer.succeed(UrlService, {
        createShortUrl: () => Effect.fail(failingError),
        getOriginalUrl: () => Effect.fail(failingError),
        listUrlStats: () => Effect.fail(failingError),
        deleteUrl: () => Effect.fail(failingError),
      })
      const captureLogger = Logger.layer([
        Logger.make(({ message }) => {
          logged.push(message)
        }),
      ])
      const { handler, dispose } = HttpRouter.toWebHandler(
        HttpAppLive.pipe(
          Layer.provideMerge(failingService),
          Layer.provide(captureLogger),
          Layer.provide(HttpServer.layerServices),
        ),
      )

      try {
        const response = await handler(new Request('http://localhost/api/v1/abc'))
        expect(response.status).toBe(500)
        const body = (await response.json()) as {
          success: boolean
          error: string
          message: string
          statusCode: number
        }
        expect(body).toEqual({
          success: false,
          error: 'Internal Server Error',
          message: 'Internal Server Error',
          statusCode: 500,
        })
        expect(JSON.stringify(body)).not.toContain('10.0.0.42')
        expect(JSON.stringify(body)).not.toContain('ECONNREFUSED')
        expect(JSON.stringify(logged)).toContain('10.0.0.42')
      } finally {
        await dispose()
      }
    })
  })
})
