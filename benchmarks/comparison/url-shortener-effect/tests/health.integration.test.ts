import { expect, it } from 'vite-plus/test'

import { build } from './helpers/helper.js'

it.each(['/health', '/live'])('serves liveness at %s', async (url) => {
  const app = build()

  try {
    const response = await app.request({ url })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: expect.any(Number) })
  } finally {
    await app.close()
  }
})

it('returns 404 for the removed readiness endpoint', async () => {
  const app = build()

  try {
    const response = await app.request({ url: '/ready' })

    expect(response.status).toBe(404)
  } finally {
    await app.close()
  }
})
