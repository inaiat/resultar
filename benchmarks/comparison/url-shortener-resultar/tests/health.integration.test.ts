import { expect, it } from 'vite-plus/test'

import { build } from './helpers/helper.js'

it('health check endpoint', async () => {
  const app = await build()

  try {
    const res = await app.inject({ url: '/health' })
    expect(res.statusCode).toBe(200)

    const result = JSON.parse(res.payload) as { ok: number }
    expect(result.ok).toEqual(expect.any(Number))
    expect(result.ok).toBeGreaterThan(0)
  } finally {
    await app.close()
  }
})
