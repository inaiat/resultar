import { RedisCommandError, type RedisClient } from '../src/infrastructure/cache/redis-client.js'
import { ResultTask } from 'resultar'
import { describe, expect, it, vi } from 'vite-plus/test'

import type { CachedUrl } from '../src/domain/model/url.model.js'

import { CacheError } from '../src/domain/errors/url.errors.js'
import { RedisUrlCacheService } from '../src/infrastructure/cache/url-cache.service.js'

const cachedUrl: CachedUrl = {
  id: '507f1f77bcf86cd799439011',
  shortCode: 'flash',
  originalUrl: 'https://flashapp.com.br',
}

const cacheMiss: null = JSON.parse('null')

const createRedisClient = (overrides: Partial<RedisClient> = {}): RedisClient => ({
  del: vi.fn(() => ResultTask.ok(0)),
  get: vi.fn(() => ResultTask.ok(cacheMiss)),
  set: vi.fn(() => ResultTask.ok(undefined)),
  ...overrides,
})

const createService = (redisClient: RedisClient) =>
  ResultTask.runPromise(
    RedisUrlCacheService.make.provideServices({
      appConfig: { REDIS_TTL_SECONDS: 3600, URL_CACHE_PREFIX: 'url:' },
      redisClient,
    }),
  )

describe('URL cache adapter', () => {
  it('writes one cache identity with the configured TTL', async () => {
    const set = vi.fn(() => ResultTask.ok(undefined))
    const service = await createService(createRedisClient({ set }))

    const result = await service.cacheUrl('flash', cachedUrl).runResult()

    expect(result.isOk()).toBe(true)
    expect(set).toHaveBeenCalledWith('url:flash', JSON.stringify(cachedUrl), { ttlSeconds: 3600 })
  })

  it('parses a cache hit and normalizes a miss to undefined', async () => {
    const get = vi
      .fn()
      .mockReturnValueOnce(ResultTask.ok(JSON.stringify(cachedUrl)))
      .mockReturnValueOnce(ResultTask.ok(cacheMiss))
    const service = await createService(createRedisClient({ get }))

    const hit = await service.getUrl('flash').runResult()
    const miss = await service.getUrl('missing').runResult()

    expect(hit.isOk() && hit.value).toEqual(cachedUrl)
    expect(miss.isOk() && miss.value).toBeUndefined()
    expect(get).toHaveBeenNthCalledWith(1, 'url:flash')
    expect(get).toHaveBeenNthCalledWith(2, 'url:missing')
  })

  it.each([
    ['malformed JSON', '{'],
    ['invalid payload', JSON.stringify({ id: 'not-an-object-id', shortCode: 'flash' })],
  ])('returns CacheError for %s', async (_label, payload) => {
    const service = await createService(createRedisClient({ get: () => ResultTask.ok(payload) }))

    const result = await service.getUrl('flash').runResult()

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(CacheError)
    }
  })

  it('maps Redis command and non-Error serialization failures without throwing', async () => {
    const cause = new RedisCommandError({ cause: new Error('ECONNREFUSED'), operation: 'get' })
    const service = await createService(createRedisClient({ get: () => ResultTask.err(cause) }))

    const result = await service.getUrl('flash').runResult()

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(CacheError)
      expect(result.error.cause).toBe(cause)
    }

    const nonErrorCause = 'non-error redis failure' as unknown as RedisCommandError
    const nonErrorService = await createService(
      createRedisClient({ get: () => ResultTask.err(nonErrorCause) }),
    )
    const nonErrorResult = await nonErrorService.getUrl('flash').runResult()
    expect(nonErrorResult.isErr()).toBe(true)
    if (nonErrorResult.isErr()) {
      expect(nonErrorResult.error).toBeInstanceOf(CacheError)
      expect(nonErrorResult.error.message).toContain('non-error redis failure')
    }
  })

  it('invalidates the single cache key', async () => {
    const del = vi.fn(() => ResultTask.ok(1))
    const service = await createService(createRedisClient({ del }))

    const result = await service.invalidate('flash').runResult()

    expect(result.isOk()).toBe(true)
    expect(del).toHaveBeenCalledWith('url:flash')
  })
})
