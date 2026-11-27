import pino from 'pino'
import { defineAppConfig } from 'resultar-config'
import { Redis } from 'ioredis'
import { Db, MongoClient } from 'mongodb'
import { ResultTask } from 'resultar'
import { describe, expect, it, vi } from 'vite-plus/test'

import { createApp } from '../src/app.js'
import { CacheError, DatabaseError } from '../src/domain/errors/url.errors.js'
import { appConfigProperties } from '../src/infrastructure/app-config.js'
import { urlCollection } from '../src/infrastructure/papr/url.schema.js'

const bullMqCapture = vi.hoisted(() => ({
  concurrency: undefined as number | undefined,
  processor: undefined as
    | ((job: { data: { urlId: string; accessedAt: string } }) => Promise<undefined>)
    | undefined,
}))

vi.mock('bullmq', () => ({
  Queue: class {
    add = vi.fn(async () => undefined)
    on = vi.fn()
    close = vi.fn(async () => undefined)
  },
  Worker: class {
    constructor(
      _name: string,
      processor: NonNullable<typeof bullMqCapture.processor>,
      { concurrency }: { concurrency: number },
    ) {
      bullMqCapture.processor = processor
      bullMqCapture.concurrency = concurrency
    }
    on = vi.fn()
    waitUntilReady = vi.fn(async () => undefined)
    run = vi.fn(async () => undefined)
    close = vi.fn(async () => undefined)
  },
}))

const createTestAppConfig = (startupReadiness = false) =>
  defineAppConfig({
    source: {
      PORT: '0',
      STARTUP_READINESS: String(startupReadiness),
      DB_URL: 'mongodb://127.0.0.1:27999',
      DB_NAME: 'url_shortener_v2_container_test',
      DB_HEALTH_TIMEOUT_MS: '10',
      REDIS_URL: 'redis://127.0.0.1:63999',
      URL_ACCESS_WORKER_CONCURRENCY: '8',
      REDIS_TTL_SECONDS: '60',
      URL_CACHE_PREFIX: 'container-test:',
    },
    properties: appConfigProperties,
  })

describe('production Service tokens through Resultar native DI', () => {
  // oxlint-disable-next-line eslint/max-statements -- Exercise a single DI scope through startup, requests, and disposal.
  it('assembles real modules, scopes the use case, and disposes resources without connecting', async () => {
    const spies = {
      closeMongo: vi.spyOn(MongoClient.prototype, 'close'),
      disconnectRedis: vi.spyOn(Redis.prototype, 'disconnect'),
      createModel: vi.spyOn(urlCollection, 'createModel'),
    }
    const logs: string[] = []
    const logger = pino(
      { level: 'warn' },
      {
        write: (line) => {
          logs.push(line)
        },
      },
    )
    const settings = await createTestAppConfig().load().runPromise()
    const app = createApp(settings, { server: { logger: false, loggerInstance: logger } })

    try {
      await app.ready()
      const cacheGet = vi
        .spyOn(app.services.urlCacheService, 'getUrl')
        .mockReturnValue(ResultTask.err(new CacheError({ detail: 'cache unavailable' })))
      const databaseFailure = DatabaseError.query(new Error('database unavailable'))
      const repositoryFind = vi
        .spyOn(app.services.urlRepository, 'findActiveByIdentifier')
        .mockReturnValue(ResultTask.err(databaseFailure))
      expect(app.services).toMatchObject({
        urlRepository: { findActiveByIdentifier: expect.any(Function) },
        urlCacheService: { getUrl: expect.any(Function) },
      })
      const invalid = await app.inject({ method: 'POST', url: '/api/v1', payload: {} })
      expect(invalid.statusCode).toBe(400)
      expect(cacheGet).not.toHaveBeenCalled()
      expect(repositoryFind).not.toHaveBeenCalled()
      expect(spies.createModel).toHaveBeenCalledOnce()

      const shortCodes = ['request-1', 'request-2']
      const responses = await Promise.all(
        shortCodes.map((shortCode) => app.inject(`/api/v1/${shortCode}`)),
      )
      expect(responses.map((response) => response.statusCode)).toEqual([500, 500])
      for (const shortCode of shortCodes) {
        expect(cacheGet).toHaveBeenCalledWith(shortCode)
        expect(repositoryFind).toHaveBeenCalledWith(shortCode)
      }
      const cacheFailures = logs
        .map(
          (line) => JSON.parse(line) as { operation?: string; shortCode?: string; reqId?: string },
        )
        .filter((log) => log.operation === 'readCachedUrl')
      expect(cacheFailures).toHaveLength(shortCodes.length)
      expect(cacheFailures.map((log) => log.shortCode)).toEqual(expect.arrayContaining(shortCodes))
      expect(new Set(cacheFailures.map((log) => log.reqId)).size).toBe(2)
      expect(spies.createModel).toHaveBeenCalledOnce()
      expect(spies.createModel.mock.calls[0]?.[0].papr.db?.databaseName).toBe(
        'url_shortener_v2_container_test',
      )
      expect(spies.createModel.mock.results[0]?.value.collection.collectionName).toBe('urls')
    } finally {
      await app.close()
    }

    expect(spies.closeMongo).toHaveBeenCalledOnce()
    expect(spies.disconnectRedis).toHaveBeenCalledTimes(2)
    vi.restoreAllMocks()
  })

  it('runs the production startup adapters before serving with controlled database operations', async () => {
    const ping = vi.spyOn(Db.prototype, 'command').mockResolvedValue({ ok: 1 })
    const migrate = vi.spyOn(urlCollection, 'migrate').mockReturnValue(ResultTask.ok(undefined))
    const closeMongo = vi.spyOn(MongoClient.prototype, 'close')
    const settings = await createTestAppConfig(true).load().runPromise()
    const app = createApp(settings, { server: { logger: false } })
    try {
      await app.ready()
      expect(ping).toHaveBeenCalledExactlyOnceWith({ ping: 1 }, { signal: expect.any(AbortSignal) })
      expect(migrate).toHaveBeenCalledOnce()
      expect(bullMqCapture.concurrency).toBe(8)
      const recordAccess = vi
        .spyOn(app.services.urlRepository, 'recordAccess')
        .mockReturnValue(ResultTask.ok(undefined))
      const accessedAt = '2026-01-01T00:00:00.000Z'
      await bullMqCapture.processor?.({ data: { urlId: 'url-1', accessedAt } })
      expect(recordAccess).toHaveBeenCalledWith('url-1', new Date(accessedAt))
      expect((await app.inject('/health')).statusCode).toBe(200)
    } finally {
      await app.close()
    }
    expect(closeMongo).toHaveBeenCalledOnce()
    vi.restoreAllMocks()
  })

  it('closes the real native Mongo resource when the startup MongoDB ping fails', async () => {
    vi.spyOn(Db.prototype, 'command').mockRejectedValue(new Error('database unavailable'))
    const migrate = vi.spyOn(urlCollection, 'migrate')
    const closeMongo = vi.spyOn(MongoClient.prototype, 'close')
    const settings = await createTestAppConfig(true).load().runPromise()
    const app = createApp(settings, { server: { logger: false } })
    try {
      await expect(app.ready()).rejects.toThrow()
      expect(migrate).not.toHaveBeenCalled()
      expect(closeMongo).toHaveBeenCalledOnce()
    } finally {
      await app.close()
      vi.restoreAllMocks()
    }
  })
})
