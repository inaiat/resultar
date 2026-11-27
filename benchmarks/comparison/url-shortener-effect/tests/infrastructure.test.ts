import { ConfigProvider, Effect } from 'effect'
import { Db } from 'mongodb'
import { describe, expect, it, vi } from 'vite-plus/test'

import { AppConfigLive, AppConfigTag } from '../src/infrastructure/app-config.js'
import { RedisClient } from '../src/infrastructure/cache/redis-client.js'
import { MongoClientService } from '../src/infrastructure/database/mongo-client.js'
import { MongoDatabaseService } from '../src/infrastructure/database/mongo-database.js'
import { makeBullMqClient } from '../src/infrastructure/queue/bullmq-client.js'
import { TestAppConfigLive } from './helpers/test-layers.js'

const bull = vi.hoisted(() => ({
  closeQueue: vi.fn(async () => undefined),
  closeWorker: vi.fn(async () => undefined),
  queue: vi.fn(),
  worker: vi.fn(),
}))
vi.mock('bullmq', () => ({
  Queue: class {
    constructor(name: string, options: unknown) {
      bull.queue(name, options)
    }
    on = vi.fn()
    close = bull.closeQueue
  },
  Worker: class {
    constructor(name: string, _processor: unknown, options: unknown) {
      bull.worker(name, options)
    }
    waitUntilReady = vi.fn(async () => undefined)
    run = vi.fn(async () => undefined)
    on = vi.fn()
    close = bull.closeWorker
  },
}))

const ConfigLayer = TestAppConfigLive()

describe('Infrastructure', () => {
  it.each(['0', '1.5'])('rejects worker concurrency %s from the environment', async (value) => {
    const provider = ConfigProvider.fromUnknown({ URL_ACCESS_WORKER_CONCURRENCY: value })
    const result = await Effect.runPromiseExit(
      AppConfigTag.pipe(
        Effect.provide(AppConfigLive),
        Effect.provideService(ConfigProvider.ConfigProvider, provider),
      ),
    )
    expect(result._tag).toBe('Failure')
  })

  it('RedisClient initializes', async () => {
    const program = Effect.gen(function* () {
      const client = yield* RedisClient
      expect(client.redis.status).toBe('wait')
      expect(client.redis.options).toMatchObject({
        connectTimeout: 1000,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      })
      yield* client.disconnect()
    })
    await Effect.runPromise(
      program.pipe(Effect.provide(RedisClient.Default), Effect.provide(ConfigLayer)),
    )
  })

  it('pings MongoDB before provisioning with the configured timeout', async () => {
    const ping = vi.spyOn(Db.prototype, 'command').mockResolvedValue({ ok: 1 })
    const config = TestAppConfigLive({ DB_HEALTH_TIMEOUT_MS: 37 })
    const program = Effect.gen(function* () {
      const client = yield* MongoClientService
      const database = yield* MongoDatabaseService
      expect(client.options.serverSelectionTimeoutMS).toBe(37)
      expect(database.databaseName).toBe('test-urlshortener')
    })
    try {
      await Effect.runPromise(
        program.pipe(
          Effect.provide(MongoDatabaseService.Default),
          Effect.provide(MongoClientService.Default),
          Effect.provide(config),
        ),
      )
      expect(ping).toHaveBeenCalledExactlyOnceWith({ ping: 1 }, { signal: expect.any(AbortSignal) })
    } finally {
      ping.mockRestore()
    }
  })

  it('BullMQClient initializes', async () => {
    const program = Effect.gen(function* () {
      const client = yield* makeBullMqClient({
        concurrency: 8,
        onError: () => undefined,
        onFailed: () => undefined,
        processor: () => undefined,
        queueName: 'test',
        redisUrl: 'redis://localhost:6379',
      })
      expect(client.queue).toBeDefined()
      yield* Effect.promise(async () => client.close())
      expect(bull.closeQueue).toHaveBeenCalledOnce()
      expect(bull.closeWorker).toHaveBeenCalledOnce()
      expect(bull.worker).toHaveBeenCalledWith(
        'test',
        expect.objectContaining({ autorun: false, concurrency: 8 }),
      )
      expect(bull.queue).toHaveBeenCalledWith(
        'test',
        expect.objectContaining({
          defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
        }),
      )
    })
    await Effect.runPromise(program)
  })
})
