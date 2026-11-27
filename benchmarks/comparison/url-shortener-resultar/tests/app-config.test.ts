import { defineAppConfig } from 'resultar-config'
import { describe, expect, it } from 'vite-plus/test'
import { appConfigProperties } from '../src/infrastructure/app-config.js'
describe('application configuration', () => {
  it.each(['0', '1.5'])('rejects worker concurrency %s', async (value) => {
    const config = defineAppConfig({
      properties: appConfigProperties,
      source: { URL_ACCESS_WORKER_CONCURRENCY: value },
    })
    expect((await config.load().runResult()).isErr()).toBe(true)
  })

  it('rejects fractional MongoDB readiness timeouts', async () => {
    const config = defineAppConfig({
      properties: appConfigProperties,
      source: { DB_HEALTH_TIMEOUT_MS: '1.5' },
    })
    expect((await config.load().runResult()).isErr()).toBe(true)
  })
})
