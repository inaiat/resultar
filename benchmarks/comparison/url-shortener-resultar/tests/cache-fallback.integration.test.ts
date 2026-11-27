import { describe, expect, it } from 'vite-plus/test'

import { build } from './helpers/helper.js'

describe('optional cache degradation', () => {
  it('resolves through the in-memory repository after a cache miss', async () => {
    const app = await build({ cacheReadMode: 'miss' })

    try {
      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/v1',
        payload: { originalUrl: 'https://cache-miss.example', customAlias: 'cache-miss-alias' },
      })
      expect(createResponse.statusCode).toBe(201)

      const redirectResponse = await app.inject({ method: 'GET', url: '/api/v1/cache-miss-alias' })
      expect(redirectResponse.statusCode).toBe(302)
      expect(redirectResponse.headers.location).toBe('https://cache-miss.example')
    } finally {
      await app.close()
    }
  })

  it('resolves through the in-memory repository after a cache read failure', async () => {
    const app = await build({ cacheReadMode: 'error' })

    try {
      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/v1',
        payload: { originalUrl: 'https://cache-error.example' },
      })
      const { shortCode } = createResponse.json<{ data: { shortCode: string } }>().data

      const redirectResponse = await app.inject({ method: 'GET', url: `/api/v1/${shortCode}` })

      expect(redirectResponse.statusCode).toBe(302)
      expect(redirectResponse.headers.location).toBe('https://cache-error.example')
    } finally {
      await app.close()
    }
  })
})
