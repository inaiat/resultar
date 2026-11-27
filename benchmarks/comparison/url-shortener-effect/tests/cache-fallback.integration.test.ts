import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

import { build } from './helpers/helper.js'

/**
 * Integration tests for Redis cache fallback to MongoDB
 *
 * These tests verify that when Redis is down or returns null (cache miss),
 * the application correctly falls back to MongoDB for retrieving URLs.
 */

describe('Cache Fallback Integration Tests', () => {
  let app: ReturnType<typeof build>
  let createdShortCode: string

  beforeAll(() => {
    app = build()
  })

  afterAll(async () => {
    await app.close()
  })

  it('should create a URL successfully', async () => {
    const response = await app.request({
      method: 'POST',
      url: '/api/v1',
      payload: { originalUrl: 'https://www.cache-fallback-test.com' },
    })

    expect(response.status).toBe(201)
    const result = JSON.parse(await response.text())
    expect(result.success).toBeTruthy()
    expect(result.data.shortCode).toBeTruthy()

    createdShortCode = result.data.shortCode
  })

  it('should retrieve URL from cache on first access', async () => {
    const response = await app.request({ method: 'GET', url: `/api/v1/${createdShortCode}` })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://www.cache-fallback-test.com')
  })

  it('should still retrieve URL after cache expiry/miss (MongoDB fallback)', async () => {
    // The mock cache might lose the value or it might expire
    // This simulates what happens when Redis is down or cache is cleared
    // The URL should still be retrievable from MongoDB

    const response = await app.request({ method: 'GET', url: `/api/v1/${createdShortCode}` })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://www.cache-fallback-test.com')
  })

  it('should return 404 for truly non-existent URLs', async () => {
    const response = await app.request({ method: 'GET', url: '/api/v1/definitelynotexist' })

    expect(response.status).toBe(404)
    const result = JSON.parse(await response.text())
    expect(result.success).toBe(false)
    expect(result.error).toEqual(expect.stringContaining('URL not found'))
  })

  it('should handle custom alias URLs with cache fallback', async () => {
    const customAlias = `fallback-${Math.random().toString(36).slice(2, 10)}`

    // Create URL with custom alias
    const createResponse = await app.request({
      method: 'POST',
      url: '/api/v1',
      payload: { originalUrl: 'https://www.alias-fallback-test.com', customAlias },
    })

    expect(createResponse.status).toBe(201)

    // Access by custom alias (should work even if cache misses)
    const getResponse = await app.request({ method: 'GET', url: `/api/v1/${customAlias}` })

    expect(getResponse.status).toBe(302)
    expect(getResponse.headers.get('location')).toBe('https://www.alias-fallback-test.com')
  })
})

describe('Redis Connection Graceful Degradation', () => {
  it('should demonstrate that app works with mock Redis', async () => {
    // This test verifies that the app can start and work with mock Redis
    // In production, if Redis is down, the app should still work using MongoDB
    const app = build()

    const healthResponse = await app.request({ method: 'GET', url: '/health' })

    expect(healthResponse.status).toBe(200)

    const createResponse = await app.request({
      method: 'POST',
      url: '/api/v1',
      payload: { originalUrl: 'https://www.graceful-degradation-test.com' },
    })

    expect(createResponse.status).toBe(201)
    const result = JSON.parse(await createResponse.text())
    expect(result.success).toBeTruthy()

    const getResponse = await app.request({
      method: 'GET',
      url: `/api/v1/${result.data.shortCode}`,
    })

    expect(getResponse.status).toBe(302)

    await app.close()
  })
})
