import { Effect, Layer } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'

import { RedisClient } from '../../src/infrastructure/cache/redis-client.js'
import { UrlCacheService } from '../../src/infrastructure/cache/url-cache.service.js'
import { TestAppConfigLive } from '../helpers/test-layers.js'

describe('UrlCacheService', () => {
  const mockRedis = { get: vi.fn(), set: vi.fn(), del: vi.fn() }

  const RedisMockLayer = Layer.succeed(RedisClient, {
    redis: mockRedis as unknown as (typeof RedisClient.Service)['redis'],
    disconnect: () => Effect.void,
  }).pipe(Layer.merge(TestAppConfigLive({ REDIS_TTL_SECONDS: 60, URL_CACHE_PREFIX: 'test:' })))

  it('getUrl returns data', async () => {
    mockRedis.get.mockResolvedValueOnce(
      JSON.stringify({
        id: '507f1f77bcf86cd799439011',
        shortCode: 'abc',
        originalUrl: 'http://a.com',
      }),
    )

    const program = Effect.gen(function* () {
      const cache = yield* UrlCacheService
      const result = yield* cache.getUrl('abc')
      expect(result).toBeDefined()
    })

    await Effect.runPromise(
      program.pipe(Effect.provide(UrlCacheService.Default), Effect.provide(RedisMockLayer)),
    )
  })

  it('getUrl returns undefined if missing', async () => {
    // oxlint-disable-next-line eslint-plugin-unicorn/no-null
    mockRedis.get.mockResolvedValueOnce(null)

    const program = Effect.gen(function* () {
      const cache = yield* UrlCacheService
      const result = yield* cache.getUrl('abc')
      expect(result).toBeUndefined()
    })

    await Effect.runPromise(
      program.pipe(Effect.provide(UrlCacheService.Default), Effect.provide(RedisMockLayer)),
    )
  })

  it('cacheUrl works', async () => {
    mockRedis.set.mockResolvedValueOnce('OK')

    const program = Effect.gen(function* () {
      const cache = yield* UrlCacheService
      yield* cache.cacheUrl('abc', {
        id: '507f1f77bcf86cd799439011',
        shortCode: 'abc',
        originalUrl: 'http://a.com',
      })
    })

    await Effect.runPromise(
      program.pipe(Effect.provide(UrlCacheService.Default), Effect.provide(RedisMockLayer)),
    )
    expect(mockRedis.set).toHaveBeenCalledWith('test:abc', expect.any(String), 'EX', 60)
  })

  it('invalidate works', async () => {
    mockRedis.del.mockResolvedValueOnce(1)

    const program = Effect.gen(function* () {
      const cache = yield* UrlCacheService
      yield* cache.invalidate('abc')
    })

    await Effect.runPromise(
      program.pipe(Effect.provide(UrlCacheService.Default), Effect.provide(RedisMockLayer)),
    )
    expect(mockRedis.del).toHaveBeenCalledWith('test:abc')
  })

  it('getUrl rejects invalid cached payloads', async () => {
    mockRedis.get.mockResolvedValueOnce(
      JSON.stringify({ id: 'not-an-object-id', shortCode: 'abc', originalUrl: 'http://a.com' }),
    )

    const program = Effect.gen(function* () {
      const cache = yield* UrlCacheService
      return yield* cache.getUrl('abc')
    })

    const exit = await Effect.runPromiseExit(
      program.pipe(Effect.provide(UrlCacheService.Default), Effect.provide(RedisMockLayer)),
    )
    expect(exit._tag).toBe('Failure')
  })
})
