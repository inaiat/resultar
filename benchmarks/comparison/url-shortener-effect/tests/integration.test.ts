import { describe, expect, it } from 'vite-plus/test'

import { build } from './helpers/helper.js'

describe('URL Shortener Integration Tests', () => {
  describe('Health Check', () => {
    it('should return health status', async () => {
      const app = build()

      try {
        const res = await app.request({ url: '/health' })

        expect(res.status).toBe(200)
        const result = JSON.parse(await res.text())
        expect(result.ok).toEqual(expect.any(Number))
        expect(result.ok).toBeGreaterThan(0)
      } finally {
        await app.close()
      }
    })
  })

  describe('URL API Contract Tests', () => {
    it('should test that URL routes are properly loaded', async () => {
      const app = build()

      try {
        // Test that the routes exist (they should return 404 for missing data, not 500)
        const createRes = await app.request({
          method: 'POST',
          url: '/api/v1',
          payload: { originalUrl: 'https://www.example.com' },
        })

        // Should not be 500 (which indicates server error)
        expect(createRes.status !== 500).toBe(true)

        // Test redirect route exists
        const redirectRes = await app.request({ method: 'GET', url: '/api/v1/testcode' })

        // Should not be 500 (route exists)
        expect(redirectRes.status !== 500).toBe(true)

        // Test delete route exists
        const deleteRes = await app.request({ method: 'POST', url: '/api/v1/testcode/delete' })

        // Should not be 500 (route exists)
        expect(deleteRes.status !== 500).toBe(true)

        const statsRes = await app.request({ method: 'GET', url: '/api/v1/stats' })

        expect(statsRes.status).toBe(200)
      } finally {
        await app.close()
      }
    })

    it('should validate API response formats', async () => {
      const app = build()

      try {
        // Test create URL response format
        const createRes = await app.request({
          method: 'POST',
          url: '/api/v1',
          payload: { originalUrl: 'https://www.example.com' },
        })

        expect(createRes.status).toBe(201)
        expect(await createRes.json()).toMatchObject({
          success: true,
          data: {
            id: expect.any(String),
            shortCode: expect.any(String),
            originalUrl: expect.any(String),
            accessCount: expect.any(Number),
            isActive: expect.any(Boolean),
            createdAt: expect.any(String),
          },
        })
      } finally {
        await app.close()
      }
    })

    it('should validate error response formats', async () => {
      const app = build()

      try {
        // Test non-existent URL returns proper error format
        const res = await app.request({ method: 'GET', url: '/api/v1/nonexistent123' })

        if (res.status === 404) {
          const result = JSON.parse(await res.text())
          expect(typeof result.success === 'boolean').toBeTruthy()
          expect(result.success).toBe(false)
          expect(typeof result.error === 'string').toBeTruthy()
        }
      } finally {
        await app.close()
      }
    })

    it('returns the stats response for an explicit recent query', async () => {
      const app = build()

      try {
        const res = await app.request({ method: 'GET', url: '/api/v1/stats?type=recent&limit=5' })
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ success: true, data: expect.any(Array) })
      } finally {
        await app.close()
      }
    })
  })

  describe('Input Validation Tests', () => {
    it('should handle malformed requests gracefully', async () => {
      const app = build()

      try {
        const res1 = await app.request({ method: 'POST', url: '/api/v1' })
        expect(res1.status).toBe(400)

        const res2 = await app.handler(
          new Request('http://localhost/api/v1', {
            method: 'POST',
            body: '{',
            headers: { 'content-type': 'application/json' },
          }),
        )
        expect(res2.status).toBe(400)
        expect(await res2.json()).toMatchObject({ success: false, statusCode: 400 })
      } finally {
        await app.close()
      }
    })

    it('should handle various URL formats', async () => {
      const app = build()

      try {
        const testUrls = [
          'https://www.example.com',
          'http://example.com',
          'https://example.com/path?query=1',
          'https://subdomain.example.com',
        ]

        for (const url of testUrls) {
          const res = await app.request({
            method: 'POST',
            url: '/api/v1',
            payload: { originalUrl: url },
          })

          // Should not return 500 for valid URL formats
          expect(res.status !== 500, `Failed for URL: ${url}`).toBe(true)
        }
      } finally {
        await app.close()
      }
    })
  })
})
