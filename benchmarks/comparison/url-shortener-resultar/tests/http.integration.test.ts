import { describe, expect, it } from 'vite-plus/test'

import { build } from './helpers/helper.js'

describe('URL service over real HTTP', () => {
  it('keeps native request services alive after receiving a JSON body', async () => {
    const app = await build()
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
    try {
      const created = await fetch(`${baseUrl}/api/v1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ originalUrl: 'https://example.com/http-regression' }),
      })
      expect(created.status).toBe(201)
      expect(await created.json()).toMatchObject({
        success: true,
        data: { originalUrl: 'https://example.com/http-regression', shortCode: expect.any(String) },
      })
      const stats = await fetch(`${baseUrl}/api/v1/stats`, { headers: { connection: 'close' } })
      expect(stats.status).toBe(200)
      expect(await stats.json()).toMatchObject({
        success: true,
        data: [{ originalUrl: 'https://example.com/http-regression', accessCount: 0 }],
      })
    } finally {
      await app.close()
    }
  })
})
