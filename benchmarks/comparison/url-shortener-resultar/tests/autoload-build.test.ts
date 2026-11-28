import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vite-plus/test'

// oxlint-disable-next-line typescript/strict-void-return -- Node provides a custom promisified execFile that returns stdout and stderr.
const execute = promisify(execFile)
const cwd = fileURLToPath(new URL('../', import.meta.url))
const pack = fileURLToPath(new URL('../node_modules/vite-plus/bin/vp', import.meta.url))

describe('compiled route autoload', () => {
  it('loads all production routes in Node without a TypeScript loader', async () => {
    await execute(process.execPath, [pack, 'pack'], { cwd })
    const { stdout } = await execute(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { ResultTask } from 'resultar'
      import { createApp } from './dist/app.js'
      const successful = () => ResultTask.ok(undefined)
      const repository = {
        findActiveByIdentifier: successful,
        findRecent: () => ResultTask.ok([]),
        findPopular: () => ResultTask.ok([]),
        insert: () => ResultTask.err(new Error('Insert is not used in this smoke test')),
        markInactive: successful,
        recordAccess: successful,
      }
      const app = createApp({
        PORT: 0,
        HOST: '127.0.0.1',
        DB_URL: 'mongodb://127.0.0.1:27017',
        DB_NAME: 'benchmark',
        DB_HEALTH_TIMEOUT_MS: 2000,
        STARTUP_READINESS: false,
        REDIS_URL: 'redis://127.0.0.1:6379',
        URL_ACCESS_WORKER_CONCURRENCY: 4,
        REDIS_TTL_SECONDS: 3600,
        URL_CACHE_PREFIX: 'benchmark:',
      }, {
        overrides: {
          mongoPaprProvisioningService: { provision: successful },
          urlRepository: repository,
          urlCacheService: { cacheUrl: successful, getUrl: successful, invalidate: successful },
          urlAccessRecorder: repository,
        },
        server: { logger: false },
      })
      try {
        const health = await app.inject('/health')
        const stats = await app.inject('/api/v1/stats')
        const unknown = await app.inject('/api/v1/missing')
        assert.equal(health.statusCode, 200)
        assert.equal((await app.inject('/ready')).statusCode, 404)
        assert.equal(stats.statusCode, 200)
        assert.deepEqual(stats.json(), { success: true, data: [] })
        assert.equal(unknown.statusCode, 404)
        assert.equal(app.hasRoute({ method: 'POST', url: '/api/v1' }), true)
        assert.equal(app.hasRoute({ method: 'POST', url: '/api/v1/:shortCode/delete' }), true)
        console.log('Compiled routes loaded')
      } finally { await app.close() }
    `,
      ],
      { cwd, env: { ...process.env, NODE_OPTIONS: '' } },
    )
    expect(stdout.trim()).toBe('Compiled routes loaded')
  }, 15_000)
})
