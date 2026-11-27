import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

import { build } from './helpers/helper.js'

describe('API Contract Tests', () => {
  let app: ReturnType<typeof build>

  beforeAll(() => {
    app = build()
  })

  afterAll(async () => {
    await app.close()
  })

  describe('POST /api/v1 - Create Short URL', () => {
    it('should create a short URL successfully and validate response contract', async () => {
      const res = await app.request({
        method: 'POST',
        url: '/api/v1',
        payload: { originalUrl: 'https://www.contract-test.com' },
      })

      expect(res.status).toBe(201)
      const result = JSON.parse(await res.text())

      // Validate response contract
      expect(typeof result.success === 'boolean').toBeTruthy()
      expect(result.success).toBe(true)

      expect(result.data).toBeTruthy()
      expect(typeof result.data.id === 'string').toBeTruthy()
      expect(typeof result.data.shortCode === 'string').toBeTruthy()
      expect(result.data.originalUrl).toBe('https://www.contract-test.com')
      expect(result.data.accessCount).toBe(0)
      expect(result.data.isActive).toBe(true)
      expect(typeof result.data.createdAt === 'string').toBeTruthy()
      expect(
        result.data.lastAccessedAt === undefined || typeof result.data.lastAccessedAt === 'string',
      ).toBeTruthy()
    })

    it('should handle custom alias creation', async () => {
      const res = await app.request({
        method: 'POST',
        url: '/api/v1',
        payload: {
          originalUrl: 'https://www.custom-alias-test.com',
          customAlias: `custom-alias-${Math.random().toString(36).slice(2, 15)}`,
        },
      })

      expect(res.status).toBe(201)
      const result = JSON.parse(await res.text())

      expect(result.success).toBe(true)
      expect(result.data.customAlias).toBe(result.data.shortCode)
    })

    it('returns the absolute expiration in UTC', async () => {
      const res = await app.request({
        method: 'POST',
        url: '/api/v1',
        payload: {
          originalUrl: 'https://example.com/expiring',
          expiresAt: '2030-01-01T01:00:00+01:00',
        },
      })

      expect(res.status).toBe(201)
      expect(await res.json()).toMatchObject({ data: { expiresAt: '2030-01-01T00:00:00.000Z' } })
    })

    it.each(['not-a-date', '2030-01-01', '2030-01-01T00:00:00', '2030-02-30T00:00:00Z', 3600])(
      'rejects %s as an expiration timestamp',
      async (expiresAt) => {
        const res = await app.request({
          method: 'POST',
          url: '/api/v1',
          payload: { originalUrl: 'https://example.com/expiring', expiresAt },
        })

        expect(res.status).toBe(400)
      },
    )

    it('should return proper error response for invalid URL', async () => {
      const res = await app.request({
        method: 'POST',
        url: '/api/v1',
        payload: { originalUrl: 'not-a-valid-url' },
      })

      expect(res.status).toBe(400)
      const result = JSON.parse(await res.text())

      expect(result.success).toBe(false)
      expect(typeof result.error === 'string').toBeTruthy()
      expect(result.error).toEqual(expect.stringContaining('Invalid URL'))
    })

    it.each([
      ['malformed URL', { originalUrl: 'not-a-url' }],
      ['JavaScript URL', { originalUrl: ['javascript', 'alert(1)'].join(':') }],
      ['FTP URL', { originalUrl: 'ftp://files.example/archive' }],
      ['reserved alias', { originalUrl: 'https://example.com', customAlias: 'stats' }],
      ['reserved uppercase alias', { originalUrl: 'https://example.com', customAlias: 'STATS' }],
      ['invalid expiration', { originalUrl: 'https://example.com', expiresAt: 'not-a-date' }],
    ])('rejects a %s', async (_label, payload) => {
      const response = await app.request({ method: 'POST', url: '/api/v1', payload })

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ success: false, statusCode: 400 })
    })

    it('keeps /api/v1/stats working and redirects a valid HTTPS custom alias', async () => {
      const statsRes = await app.request({ method: 'GET', url: '/api/v1/stats' })
      expect(statsRes.status).toBe(200)

      const customAlias = `https-alias-${Math.random().toString(36).slice(2, 10)}`
      const createRes = await app.request({
        method: 'POST',
        url: '/api/v1',
        payload: { originalUrl: 'https://secure.example/target', customAlias },
      })
      expect(createRes.status).toBe(201)

      const redirectRes = await app.request({ method: 'GET', url: `/api/v1/${customAlias}` })
      expect(redirectRes.status).toBe(302)
      expect(redirectRes.headers.get('location')).toBe('https://secure.example/target')
    })

    it('returns one 201 and one 409 for simultaneous requests with the same custom alias', async () => {
      const customAlias = `race-alias-${Math.random().toString(36).slice(2, 10)}`
      const [first, second] = await Promise.all([
        app.request({
          method: 'POST',
          url: '/api/v1',
          payload: { originalUrl: 'https://race-one.example', customAlias },
        }),
        app.request({
          method: 'POST',
          url: '/api/v1',
          payload: { originalUrl: 'https://race-two.example', customAlias },
        }),
      ])

      expect([first.status, second.status].sort((a, b) => a - b)).toEqual([201, 409])
    })
  })

  describe('GET /api/v1/:shortCode - Redirect to Original URL', () => {
    it('should redirect to original URL with proper headers', async () => {
      // First create a URL to test redirect
      const createRes = await app.request({
        method: 'POST',
        url: '/api/v1',
        payload: { originalUrl: 'https://www.redirect-test.com' },
      })

      expect(createRes.status).toBe(201)
      const createResult = (await createRes.json()) as {
        success: boolean
        data: { shortCode: string }
      }
      expect(createResult.success).toBe(true)
      const testShortCode = createResult.data.shortCode

      // Now test redirect
      const res = await app.request({ method: 'GET', url: `/api/v1/${testShortCode}` })

      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('https://www.redirect-test.com')
      expect(res.headers.get('content-length')).toBe('0')
    })

    it('should handle custom alias redirect', async () => {
      // First create a URL with custom alias
      const customAlias = `redirect-alias-${Math.random().toString(36).slice(2, 15)}`
      const createRes = await app.request({
        method: 'POST',
        url: '/api/v1',
        payload: { originalUrl: 'https://www.custom-alias-redirect-test.com', customAlias },
      })

      expect(createRes.status).toBe(201)
      const createResult = (await createRes.json()) as {
        success: boolean
        data: { shortCode: string }
      }
      expect(createResult.success).toBe(true)
      expect(createResult.data.shortCode).toBe(customAlias)

      // Now test redirect
      const res = await app.request({ method: 'GET', url: `/api/v1/${customAlias}` })

      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('https://www.custom-alias-redirect-test.com')
    })

    it('should return proper 404 error for non-existent URL', async () => {
      const res = await app.request({ method: 'GET', url: '/api/v1/nonexistent123' })

      expect(res.status).toBe(404)
      const result = JSON.parse(await res.text())

      expect(result.success).toBe(false)
      expect(typeof result.error === 'string').toBeTruthy()
      expect(result.error).toEqual(expect.stringContaining('URL not found'))
    })
  })

  describe('POST /api/v1/:shortCode/delete - Soft Delete URL', () => {
    it('should soft delete URL and return success message', async () => {
      // First create a URL to delete
      const createRes = await app.request({
        method: 'POST',
        url: '/api/v1',
        payload: { originalUrl: 'https://www.delete-test.com' },
      })

      expect(createRes.status).toBe(201)
      const createResult = (await createRes.json()) as {
        success: boolean
        data: { shortCode: string }
      }
      expect(createResult.success).toBe(true)
      const testShortCode = createResult.data.shortCode

      // Now test delete
      const res = await app.request({ method: 'POST', url: `/api/v1/${testShortCode}/delete` })

      expect(res.status).toBe(200)
      const result = JSON.parse(await res.text())

      expect(result.success).toBe(true)
      expect(typeof result.message === 'string').toBeTruthy()
      expect(result.message).toEqual(expect.stringContaining('deleted successfully'))
      expect(result.message).toEqual(expect.stringContaining(testShortCode))
    })

    it('should return 404 for non-existent URL deletion', async () => {
      const res = await app.request({ method: 'POST', url: '/api/v1/nonexistent456/delete' })

      expect(res.status).toBe(404)
      const result = JSON.parse(await res.text())

      expect(result.success).toBe(false)
      expect(typeof result.message === 'string').toBeTruthy()
    })

    it('should prevent access to soft deleted URL', async () => {
      // Create a URL and delete it first
      const createRes = await app.request({
        method: 'POST',
        url: '/api/v1',
        payload: { originalUrl: 'https://www.deleted-access-test.com' },
      })

      expect(createRes.status).toBe(201)
      const createResult = (await createRes.json()) as {
        success: boolean
        data: { shortCode: string }
      }
      expect(createResult.success).toBe(true)
      const testShortCode = createResult.data.shortCode

      // Delete the URL
      const deleteRes = await app.request({
        method: 'POST',
        url: `/api/v1/${testShortCode}/delete`,
      })

      expect(deleteRes.status).toBe(200)

      // Now test that access is prevented
      const res = await app.request({ method: 'GET', url: `/api/v1/${testShortCode}` })

      expect(res.status).toBe(404)
      const result = JSON.parse(await res.text())

      expect(result.success).toBe(false)
      expect(result.error).toEqual(expect.stringContaining('URL not found'))
    })
  })

  describe('GET /api/v1/stats', () => {
    it('lists recent URLs by default and honors the limit', async () => {
      const response = await app.request({ url: '/api/v1/stats' })
      const limited = await app.request({ url: '/api/v1/stats?type=recent&limit=1' })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ success: true, data: expect.any(Array) })
      expect(limited.status).toBe(200)
      expect(await limited.json()).toEqual({
        success: true,
        data: [expect.objectContaining({ shortCode: expect.any(String) })],
      })
    })

    it('excludes URLs with no accesses from popular stats', async () => {
      const response = await app.request({ url: '/api/v1/stats?type=popular' })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ success: true, data: [] })
    })

    it.each(['type=unknown', 'limit=0', 'limit=101', 'limit=1.5', 'limit=abc'])(
      'rejects %s',
      async (query) => {
        const response = await app.request({ url: `/api/v1/stats?${query}` })

        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ success: false, statusCode: 400 })
      },
    )
  })
})
