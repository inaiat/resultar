import type { FastifyBaseLogger as Logger } from 'fastify'
import { RedisCommandError, type RedisClient } from '../src/infrastructure/cache/redis-client.js'
import { ResultTask } from 'resultar'
import { describe, expect, it, vi } from 'vite-plus/test'

import type { CachedUrl, Url } from '../src/domain/model/url.model.js'

import {
  CacheError as UrlCacheError,
  type CacheError,
  DatabaseError,
  UrlExpiredError,
  UrlNotFoundError,
} from '../src/domain/errors/url.errors.js'
import { UrlUseCase } from '../src/domain/usecase/url.usecase.js'
import { RedisUrlCacheService } from '../src/infrastructure/cache/url-cache.service.js'
import {
  createBestEffortLogger,
  createCachedUrl,
  createCacheService,
  createRepository,
  createUrl,
} from './helpers/url-usecase-fixtures.js'

const bestEffortFailureMessage = 'Best-effort URL operation failed'

type CreateUseCaseOptions = Parameters<typeof UrlUseCase.make.provideServices>[0] & {
  readonly logger: Logger
}

const createUseCase = async (
  options: Omit<CreateUseCaseOptions, 'logger' | 'urlAccessRecorder'> &
    Partial<Pick<CreateUseCaseOptions, 'logger' | 'urlAccessRecorder'>>,
) => {
  const logger = options.logger ?? createBestEffortLogger().logger
  const useCase = await ResultTask.runPromise(
    UrlUseCase.make.provideServices({
      urlCacheService: options.urlCacheService,
      urlRepository: options.urlRepository,
      urlAccessRecorder: options.urlAccessRecorder ?? options.urlRepository,
    }),
  )
  return { getOriginalUrl: (shortCode: string) => useCase.getOriginalUrl(shortCode, logger) }
}

describe('url.usecase getOriginalUrl', () => {
  const waitForDetachedTasks = async () =>
    new Promise((resolve) => {
      setTimeout(resolve, 0)
    })

  it('returns a cached URL and records access without querying the repository', async () => {
    const cachedUrl = createCachedUrl({ id: 'cache-url', originalUrl: 'https://cached.example' })
    const urlRepository = createRepository()
    const urlCacheService = createCacheService({
      getUrl: vi.fn(() => ResultTask.ok<CachedUrl, CacheError>(cachedUrl)),
    })
    const useCase = await createUseCase({ urlCacheService, urlRepository })

    const dateSpy = vi.spyOn(globalThis, 'Date')
    try {
      const result = await useCase.getOriginalUrl('short-code').runResult()

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toBe('https://cached.example')
      }
      expect(dateSpy).not.toHaveBeenCalledWith(undefined)
      expect(urlCacheService.getUrl).toHaveBeenCalledWith('short-code')
      expect(urlRepository.findActiveByIdentifier).not.toHaveBeenCalled()
      expect(urlRepository.recordAccess).toHaveBeenCalledWith('cache-url', expect.any(Date))
    } finally {
      dateSpy.mockRestore()
    }
  })

  it('returns cached URLs that have not reached their expiration time', async () => {
    const now = new Date('2025-01-01T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      const cachedUrl = createCachedUrl({
        id: 'future-cache-url',
        originalUrl: 'https://future-cache.example',
        expiresAt: new Date('2025-01-02T00:00:00.000Z').toISOString(),
      })
      const urlRepository = createRepository()
      const urlCacheService = createCacheService({
        getUrl: vi.fn(() => ResultTask.ok<CachedUrl, CacheError>(cachedUrl)),
      })
      const useCase = await createUseCase({ urlCacheService, urlRepository })

      const result = await useCase.getOriginalUrl('future-cache-code').runResult()

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toBe('https://future-cache.example')
      }
      expect(urlRepository.findActiveByIdentifier).not.toHaveBeenCalled()
      expect(urlRepository.markInactive).not.toHaveBeenCalled()
      expect(urlRepository.recordAccess).toHaveBeenCalledWith('future-cache-url', expect.any(Date))
    } finally {
      vi.useRealTimers()
    }
  })

  it('logs access count failures without failing cached redirects', async () => {
    const cachedUrl = createCachedUrl({ id: 'cache-url', originalUrl: 'https://cached.example' })
    const error = DatabaseError.update(new Error('record failed'))
    const { logger, warn } = createBestEffortLogger()
    const urlRepository = createRepository({
      recordAccess: vi.fn(() => ResultTask.err<undefined, DatabaseError>(error)),
    })
    const urlCacheService = createCacheService({
      getUrl: vi.fn(() => ResultTask.ok<CachedUrl, CacheError>(cachedUrl)),
    })
    const useCase = await createUseCase({ logger, urlCacheService, urlRepository })

    const result = await useCase.getOriginalUrl('short-code').runResult()

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe('https://cached.example')
    }
    await waitForDetachedTasks()
    expect(warn).toHaveBeenCalledWith(
      { operation: 'recordAccess', urlId: 'cache-url', err: error },
      bestEffortFailureMessage,
    )
  })

  it('returns UrlExpiredError for expired cached URLs', async () => {
    const expiredCachedUrl = createCachedUrl({ expiresAt: '2020-01-01T00:00:00.000Z' })
    const urlRepository = createRepository()
    const urlCacheService = createCacheService({
      getUrl: vi.fn(() => ResultTask.ok<CachedUrl, CacheError>(expiredCachedUrl)),
    })
    const useCase = await createUseCase({ urlCacheService, urlRepository })

    const result = await useCase.getOriginalUrl('expired-code').runResult()

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UrlExpiredError)
      expect(result.error.message).toBe('URL has expired: expired-code')
    }
    expect(urlRepository.findActiveByIdentifier).not.toHaveBeenCalled()
    expect(urlRepository.recordAccess).not.toHaveBeenCalled()
    expect(urlRepository.markInactive).toHaveBeenCalledWith('url-1', expect.any(Date))
  })

  it('logs cached expired URL soft-delete failures without changing expired behavior', async () => {
    const expiresAt = '2020-01-01T00:00:00.000Z'
    const error = DatabaseError.update(new Error('cached soft delete failed'))
    const { logger, warn } = createBestEffortLogger()
    const expiredCachedUrl = createCachedUrl({ id: 'cached-expired-url', expiresAt })
    const urlRepository = createRepository({
      markInactive: vi.fn(() => ResultTask.err<undefined, DatabaseError>(error)),
    })
    const urlCacheService = createCacheService({
      getUrl: vi.fn(() => ResultTask.ok<CachedUrl, CacheError>(expiredCachedUrl)),
    })
    const useCase = await createUseCase({ logger, urlCacheService, urlRepository })

    const result = await useCase.getOriginalUrl('expired-code').runResult()

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UrlExpiredError)
    }
    await waitForDetachedTasks()
    expect(urlRepository.findActiveByIdentifier).not.toHaveBeenCalled()
    expect(urlRepository.recordAccess).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      {
        expiresAt: new Date(expiresAt),
        operation: 'cleanupExpiredUrl',
        resource: 'database',
        shortCode: 'expired-code',
        urlId: 'cached-expired-url',
        err: error,
      },
      bestEffortFailureMessage,
    )
  })

  it('expires cached URLs exactly at their expiration time', async () => {
    const now = new Date('2025-01-01T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      const cachedUrl = createCachedUrl({
        id: 'boundary-cache-url',
        originalUrl: 'https://boundary-cache.example',
        expiresAt: now.toISOString(),
      })
      const urlRepository = createRepository()
      const urlCacheService = createCacheService({
        getUrl: vi.fn(() => ResultTask.ok<CachedUrl, CacheError>(cachedUrl)),
      })
      const useCase = await createUseCase({ urlCacheService, urlRepository })

      const result = await useCase.getOriginalUrl('boundary-code').runResult()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(UrlExpiredError)
      }
      expect(urlRepository.markInactive).toHaveBeenCalledWith(
        'boundary-cache-url',
        expect.any(Date),
      )
      expect(urlRepository.recordAccess).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves from repository when caches miss', async () => {
    const storedUrl = createUrl({
      id: 'stored-url',
      shortCode: 'stored-code',
      originalUrl: 'https://stored.example',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    })
    const urlRepository = createRepository({
      findActiveByIdentifier: vi.fn(() => ResultTask.ok<Url | undefined, DatabaseError>(storedUrl)),
    })
    const urlCacheService = createCacheService()
    const useCase = await createUseCase({ urlCacheService, urlRepository })

    const result = await useCase.getOriginalUrl('stored-code').runResult()

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe('https://stored.example')
    }
    expect(urlCacheService.getUrl).toHaveBeenCalledWith('stored-code')
    expect(urlRepository.findActiveByIdentifier).toHaveBeenCalledWith('stored-code')
    expect(urlCacheService.cacheUrl).toHaveBeenCalledWith(
      'stored-code',
      expect.objectContaining({ id: 'stored-url', originalUrl: 'https://stored.example' }),
    )
    expect(urlRepository.recordAccess).toHaveBeenCalledWith('stored-url', expect.any(Date))
  })

  it('logs cache read failures with context before resolving from the repository', async () => {
    const cacheError = new UrlCacheError({ detail: 'redis down' })
    const { logger, warn } = createBestEffortLogger()
    const storedUrl = createUrl({
      id: 'cache-read-fallback-url',
      shortCode: 'cache-read-fallback-code',
      originalUrl: 'https://cache-read-fallback.example',
    })
    const urlRepository = createRepository({
      findActiveByIdentifier: vi.fn(() => ResultTask.ok<Url | undefined, DatabaseError>(storedUrl)),
    })
    const urlCacheService = createCacheService({
      getUrl: vi.fn(() => ResultTask.err<undefined, CacheError>(cacheError)),
    })
    const useCase = await createUseCase({ logger, urlCacheService, urlRepository })

    const result = await useCase.getOriginalUrl('cache-read-fallback-code').runResult()

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe('https://cache-read-fallback.example')
    }
    expect(warn).toHaveBeenCalledWith(
      { operation: 'readCachedUrl', shortCode: 'cache-read-fallback-code', err: cacheError },
      bestEffortFailureMessage,
    )
    expect(urlRepository.findActiveByIdentifier).toHaveBeenCalledWith('cache-read-fallback-code')
  })

  it('resolves from repository when the Redis adapter cannot connect', async () => {
    const storedUrl = createUrl({
      id: 'redis-down-url',
      shortCode: 'redis-down-code',
      originalUrl: 'https://redis-down.example',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    })
    const redisClient: RedisClient = {
      del: () => ResultTask.ok(0),
      get: () =>
        ResultTask.err(
          new RedisCommandError({ cause: new Error('ECONNREFUSED'), operation: 'get' }),
        ),
      set: () => ResultTask.ok(undefined),
    }
    const urlRepository = createRepository({
      findActiveByIdentifier: vi.fn(() => ResultTask.ok<Url | undefined, DatabaseError>(storedUrl)),
    })
    const urlCacheService = await ResultTask.runPromise(
      RedisUrlCacheService.make.provideServices({
        appConfig: { REDIS_TTL_SECONDS: 3600, URL_CACHE_PREFIX: 'url:' },
        redisClient,
      }),
    )
    const useCase = await createUseCase({ urlCacheService, urlRepository })

    const result = await useCase.getOriginalUrl('redis-down-code').runResult()

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe('https://redis-down.example')
    }
    expect(urlRepository.findActiveByIdentifier).toHaveBeenCalledWith('redis-down-code')
    expect(urlRepository.recordAccess).toHaveBeenCalledWith('redis-down-url', expect.any(Date))
  })

  it('expires repository URLs exactly at their expiration time', async () => {
    const now = new Date('2025-01-01T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      const storedUrl = createUrl({
        id: 'boundary-stored-url',
        shortCode: 'boundary-code',
        originalUrl: 'https://boundary.example',
        expiresAt: now,
      })
      const urlRepository = createRepository({
        findActiveByIdentifier: vi.fn(() =>
          ResultTask.ok<Url | undefined, DatabaseError>(storedUrl),
        ),
      })
      const urlCacheService = createCacheService()
      const useCase = await createUseCase({ urlCacheService, urlRepository })

      const result = await useCase.getOriginalUrl('boundary-code').runResult()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(UrlExpiredError)
      }
      expect(urlRepository.markInactive).toHaveBeenCalledWith(
        'boundary-stored-url',
        expect.any(Date),
      )
      expect(urlRepository.recordAccess).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns repository URLs that have not reached their expiration time', async () => {
    const now = new Date('2025-01-01T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      const storedUrl = createUrl({
        id: 'future-stored-url',
        shortCode: 'future-stored-code',
        originalUrl: 'https://future-stored.example',
        expiresAt: new Date('2025-01-02T00:00:00.000Z'),
      })
      const urlRepository = createRepository({
        findActiveByIdentifier: vi.fn(() =>
          ResultTask.ok<Url | undefined, DatabaseError>(storedUrl),
        ),
      })
      const urlCacheService = createCacheService()
      const useCase = await createUseCase({ urlCacheService, urlRepository })

      const result = await useCase.getOriginalUrl('future-stored-code').runResult()

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toBe('https://future-stored.example')
      }
      expect(urlRepository.markInactive).not.toHaveBeenCalled()
      expect(urlCacheService.cacheUrl).toHaveBeenCalledWith(
        'future-stored-code',
        expect.objectContaining({ id: 'future-stored-url' }),
      )
      expect(urlRepository.recordAccess).toHaveBeenCalledWith('future-stored-url', expect.any(Date))
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores repository cache write failures when resolving URLs', async () => {
    const cacheError = new UrlCacheError({ detail: 'redis down' })
    const { logger, warn } = createBestEffortLogger()
    const storedUrl = createUrl({
      id: 'stored-url',
      shortCode: 'stored-code',
      originalUrl: 'https://stored.example',
    })
    const urlRepository = createRepository({
      findActiveByIdentifier: vi.fn(() => ResultTask.ok<Url | undefined, DatabaseError>(storedUrl)),
    })
    const urlCacheService = createCacheService({
      cacheUrl: vi.fn(() => ResultTask.err<undefined, CacheError>(cacheError)),
    })
    const useCase = await createUseCase({ logger, urlCacheService, urlRepository })

    const result = await useCase.getOriginalUrl('stored-code').runResult()

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toBe('https://stored.example')
    }
    expect(urlCacheService.cacheUrl).toHaveBeenCalledWith(
      'stored-code',
      expect.objectContaining({ id: 'stored-url' }),
    )
    expect(warn).toHaveBeenCalledWith(
      { operation: 'cacheResolvedUrl', shortCode: 'stored-code', err: cacheError },
      bestEffortFailureMessage,
    )
  })

  it('returns UrlExpiredError and soft deletes expired repository URLs', async () => {
    const expiredUrl = createUrl({
      id: 'expired-url',
      shortCode: 'expired-code',
      expiresAt: new Date('2020-01-01T00:00:00.000Z'),
    })
    const urlRepository = createRepository({
      findActiveByIdentifier: vi.fn(() =>
        ResultTask.ok<Url | undefined, DatabaseError>(expiredUrl),
      ),
    })
    const urlCacheService = createCacheService()
    const useCase = await createUseCase({ urlCacheService, urlRepository })

    const result = await useCase.getOriginalUrl('expired-code').runResult()

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UrlExpiredError)
      expect(result.error.message).toBe('URL has expired: expired-code')
    }
    expect(urlRepository.markInactive).toHaveBeenCalledWith('expired-url', expect.any(Date))
    expect(urlCacheService.cacheUrl).not.toHaveBeenCalled()
    expect(urlRepository.recordAccess).not.toHaveBeenCalled()
  })

  it('logs expired URL soft-delete failures without changing expired behavior', async () => {
    const expiresAt = new Date('2020-01-01T00:00:00.000Z')
    const expiredUrl = createUrl({ id: 'expired-url', shortCode: 'expired-code', expiresAt })
    const error = DatabaseError.update(new Error('soft delete failed'))
    const { logger, warn } = createBestEffortLogger()
    const urlRepository = createRepository({
      findActiveByIdentifier: vi.fn(() =>
        ResultTask.ok<Url | undefined, DatabaseError>(expiredUrl),
      ),
      markInactive: vi.fn(() => ResultTask.err<undefined, DatabaseError>(error)),
    })
    const urlCacheService = createCacheService()
    const useCase = await createUseCase({ logger, urlCacheService, urlRepository })

    const result = await useCase.getOriginalUrl('expired-code').runResult()

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UrlExpiredError)
    }
    await waitForDetachedTasks()
    expect(warn).toHaveBeenCalledWith(
      {
        expiresAt,
        operation: 'cleanupExpiredUrl',
        resource: 'database',
        shortCode: 'expired-code',
        urlId: 'expired-url',
        err: error,
      },
      bestEffortFailureMessage,
    )
  })

  it('returns UrlNotFoundError when caches and repository miss', async () => {
    const urlRepository = createRepository()
    const urlCacheService = createCacheService()
    const useCase = await createUseCase({ urlCacheService, urlRepository })

    const result = await useCase.getOriginalUrl('missing-code').runResult()

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UrlNotFoundError)
      expect(result.error.message).toBe('URL not found: missing-code')
    }
    expect(urlRepository.findActiveByIdentifier).toHaveBeenCalledWith('missing-code')
  })
})
