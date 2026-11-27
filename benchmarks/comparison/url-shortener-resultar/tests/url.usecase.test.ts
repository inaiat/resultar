import type { FastifyBaseLogger as Logger } from 'fastify'
import { ResultTask } from 'resultar'
import { describe, expect, it, vi } from 'vite-plus/test'

import type { Url } from '../src/domain/model/url.model.js'
import type { UrlRepository } from '../src/domain/repository/url.repository.js'

import {
  CacheError as UrlCacheError,
  CustomAliasExistsError,
  type CacheError,
  DatabaseError,
  InvalidCustomAliasError,
  UrlCreationError,
  UrlNotFoundError,
} from '../src/domain/errors/url.errors.js'
import { UrlUseCase } from '../src/domain/usecase/url.usecase.js'
import {
  createBestEffortLogger,
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
  return {
    createShortUrl: (request: Parameters<typeof useCase.createShortUrl>[0]) =>
      useCase.createShortUrl(request, logger),
    getOriginalUrl: (shortCode: string) => useCase.getOriginalUrl(shortCode, logger),
    deleteUrl: (shortCode: string) => useCase.deleteUrl(shortCode, logger),
    getPopularUrls: (limit: number) => useCase.getPopularUrls(limit),
    getRecentUrls: (limit: number) => useCase.getRecentUrls(limit),
  }
}

describe('url.usecase', () => {
  describe('createShortUrl', () => {
    it('rejects reserved aliases before inserting', async () => {
      const urlRepository = createRepository()
      const urlCacheService = createCacheService()
      const useCase = await createUseCase({ urlCacheService, urlRepository })

      const result = await useCase
        .createShortUrl({ originalUrl: 'https://example.com', customAlias: 'stats' })
        .runResult()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(InvalidCustomAliasError)
        expect(result.error.message).toBe('Invalid custom alias: stats')
      }
      expect(urlRepository.insert).not.toHaveBeenCalled()
      expect(urlCacheService.cacheUrl).not.toHaveBeenCalled()
    })

    it('creates a URL with a custom alias, expiration date, and cache entry', async () => {
      const expiresAt = new Date('2030-01-02T03:04:05.000Z')
      const inserted = createUrl({
        id: 'url-2',
        shortCode: 'vanity',
        originalUrl: 'https://example.com/page',
        customAlias: 'vanity',
        expiresAt,
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
      })
      const insert = vi.fn(() => ResultTask.ok<Url, DatabaseError>(inserted))
      const urlRepository = createRepository({ insert })
      const urlCacheService = createCacheService()
      const useCase = await createUseCase({ urlCacheService, urlRepository })

      const result = await useCase
        .createShortUrl({
          originalUrl: 'https://example.com/page',
          customAlias: 'vanity',
          expiresAt,
        })
        .runResult()

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toMatchObject({
          id: 'url-2',
          shortCode: 'vanity',
          originalUrl: 'https://example.com/page',
          customAlias: 'vanity',
          expiresAt,
        })
      }
      expect(urlRepository.findActiveByIdentifier).not.toHaveBeenCalled()
      expect(insert).toHaveBeenCalledWith({
        shortCode: 'vanity',
        originalUrl: 'https://example.com/page',
        customAlias: 'vanity',
        accessCount: 0,
        expiresAt,
        isActive: true,
      })
      expect(urlCacheService.cacheUrl).toHaveBeenCalledWith(
        'vanity',
        expect.objectContaining({ shortCode: 'vanity', expiresAt: expiresAt.toISOString() }),
      )
    })

    it('retries a generated short code when insert hits a duplicate constraint', async () => {
      const insert = vi
        .fn()
        .mockReturnValueOnce(
          ResultTask.err<Url, DatabaseError>(
            DatabaseError.constraint('Duplicate entry', { code: 11_000 }),
          ),
        )
        .mockImplementationOnce((data: Parameters<UrlRepository['insert']>[0]) =>
          ResultTask.ok<Url, DatabaseError>(
            createUrl({
              id: 'created-after-race',
              shortCode: data.shortCode,
              originalUrl: data.originalUrl,
              createdAt: new Date('2025-01-01T00:00:00.000Z'),
            }),
          ),
        )
      const urlRepository = createRepository({ insert })
      const urlCacheService = createCacheService()
      const useCase = await createUseCase({ urlCacheService, urlRepository })

      const result = await useCase
        .createShortUrl({ originalUrl: 'https://example.com' })
        .runResult()

      expect(result.isOk()).toBe(true)
      expect(insert).toHaveBeenCalledTimes(2)
      expect(urlRepository.findActiveByIdentifier).not.toHaveBeenCalled()
      if (result.isOk()) {
        expect(result.value.id).toBe('created-after-race')
        expect(result.value.shortCode).toBe(insert.mock.calls[1]?.[0].shortCode)
      }
    })

    it('returns CustomAliasExistsError when custom alias insert hits a duplicate race', async () => {
      const insert = vi.fn(() =>
        ResultTask.err<Url, DatabaseError>(
          DatabaseError.constraint('Duplicate entry', { code: 11_000 }),
        ),
      )
      const urlRepository = createRepository({ insert })
      const urlCacheService = createCacheService()
      const useCase = await createUseCase({ urlCacheService, urlRepository })

      const result = await useCase
        .createShortUrl({ originalUrl: 'https://example.com', customAlias: 'raced-alias' })
        .runResult()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(CustomAliasExistsError)
        expect(result.error.message).toBe('Custom alias already exists: raced-alias')
      }
      expect(insert).toHaveBeenCalledOnce()
      expect(urlCacheService.cacheUrl).not.toHaveBeenCalled()
    })

    it('returns DatabaseError when insert fails without a duplicate constraint', async () => {
      const insertError = DatabaseError.insert(new Error('insert failed'))
      const insert = vi.fn(() => ResultTask.err<Url, DatabaseError>(insertError))
      const urlRepository = createRepository({ insert })
      const urlCacheService = createCacheService()
      const useCase = await createUseCase({ urlCacheService, urlRepository })

      const result = await useCase
        .createShortUrl({ originalUrl: 'https://example.com' })
        .runResult()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error).toBe(insertError)
        expect(result.error).toBeInstanceOf(DatabaseError)
        expect(insertError.operation).toBe('insert')
      }
      expect(urlRepository.findActiveByIdentifier).not.toHaveBeenCalled()
      expect(insert).toHaveBeenCalledOnce()
      expect(urlCacheService.cacheUrl).not.toHaveBeenCalled()
    })

    it('returns UrlCreationError when generated insert duplicate races are exhausted', async () => {
      const insert = vi.fn(() =>
        ResultTask.err<Url, DatabaseError>(
          DatabaseError.constraint('Duplicate entry', { code: 11_000 }),
        ),
      )
      const urlRepository = createRepository({ insert })
      const urlCacheService = createCacheService()
      const useCase = await createUseCase({ urlCacheService, urlRepository })

      const result = await useCase
        .createShortUrl({ originalUrl: 'https://example.com' })
        .runResult()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(UrlCreationError)
        expect(result.error.message).toBe('Failed to generate unique short code')
      }
      expect(urlRepository.findActiveByIdentifier).not.toHaveBeenCalled()
      expect(insert).toHaveBeenCalledTimes(10)
      expect(urlCacheService.cacheUrl).not.toHaveBeenCalled()
    })

    it('ignores cache write failures after inserting a URL', async () => {
      const cacheError = new UrlCacheError({ detail: 'redis down' })
      const { logger, warn } = createBestEffortLogger()
      const inserted = createUrl({
        id: 'url-3',
        shortCode: 'cached-fail',
        originalUrl: 'https://example.com',
        customAlias: 'cached-fail',
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
      })
      const urlRepository = createRepository({
        insert: vi.fn(() => ResultTask.ok<Url, DatabaseError>(inserted)),
      })
      const urlCacheService = createCacheService({
        cacheUrl: vi.fn(() => ResultTask.err<undefined, CacheError>(cacheError)),
      })
      const useCase = await createUseCase({ logger, urlCacheService, urlRepository })

      const result = await useCase
        .createShortUrl({ originalUrl: 'https://example.com', customAlias: 'cached-fail' })
        .runResult()

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.shortCode).toBe('cached-fail')
      }
      expect(urlCacheService.cacheUrl).toHaveBeenCalledWith(
        'cached-fail',
        expect.objectContaining({ shortCode: 'cached-fail' }),
      )
      expect(warn).toHaveBeenCalledWith(
        { operation: 'cacheCreatedUrl', shortCode: 'cached-fail', err: cacheError },
        bestEffortFailureMessage,
      )
    })
  })

  describe('deleteUrl', () => {
    it('returns UrlNotFoundError when the short code has no active URL', async () => {
      const urlRepository = createRepository()
      const urlCacheService = createCacheService()
      const useCase = await createUseCase({ urlCacheService, urlRepository })

      const result = await useCase.deleteUrl('missing-short-code').runResult()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(UrlNotFoundError)
        expect(result.error.message).toBe('URL not found: missing-short-code')
        expect(result.error).toHaveProperty('_tag', 'UrlNotFoundError')
      }
      expect(urlRepository.findActiveByIdentifier).toHaveBeenCalledWith('missing-short-code')
      expect(urlRepository.markInactive).not.toHaveBeenCalled()
      expect(urlCacheService.invalidate).not.toHaveBeenCalled()
    })

    it('marks the active URL inactive and invalidates cache when the short code exists', async () => {
      const url = createUrl({
        id: 'url-1',
        shortCode: 'short-code',
        originalUrl: 'https://example.com',
        customAlias: 'custom-alias',
        accessCount: 0,
        isActive: true,
      })
      const urlRepository = createRepository({
        findActiveByIdentifier: vi.fn(() => ResultTask.ok<Url | undefined, DatabaseError>(url)),
      })
      const urlCacheService = createCacheService()
      const useCase = await createUseCase({ urlCacheService, urlRepository })

      const result = await useCase.deleteUrl('short-code').runResult()

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toBeUndefined()
      }
      expect(urlRepository.findActiveByIdentifier).toHaveBeenCalledWith('short-code')
      expect(urlRepository.markInactive).toHaveBeenCalledWith('url-1', expect.any(Date))
      expect(urlCacheService.invalidate).toHaveBeenCalledWith('short-code')
    })

    it('keeps deletion successful and logs cache invalidation failures with context', async () => {
      const cacheError = new UrlCacheError({ detail: 'redis down' })
      const { logger, warn } = createBestEffortLogger()
      const url = createUrl({ id: 'url-with-cache-failure', shortCode: 'cache-failure-code' })
      const urlRepository = createRepository({
        findActiveByIdentifier: vi.fn(() => ResultTask.ok<Url | undefined, DatabaseError>(url)),
      })
      const urlCacheService = createCacheService({
        invalidate: vi.fn(() => ResultTask.err<undefined, CacheError>(cacheError)),
      })
      const useCase = await createUseCase({ logger, urlCacheService, urlRepository })

      const result = await useCase.deleteUrl('cache-failure-code').runResult()

      expect(result.isOk()).toBe(true)
      expect(urlRepository.markInactive).toHaveBeenCalledWith(
        'url-with-cache-failure',
        expect.any(Date),
      )
      expect(urlCacheService.invalidate).toHaveBeenCalledWith('cache-failure-code')
      expect(warn).toHaveBeenCalledWith(
        { operation: 'invalidateDeletedUrl', shortCode: 'cache-failure-code', err: cacheError },
        bestEffortFailureMessage,
      )
    })
  })

  describe('stats', () => {
    it('maps popular URLs to response payloads', async () => {
      const popularUrl = createUrl({
        id: 'popular-url',
        shortCode: 'popular-code',
        originalUrl: 'https://popular.example',
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        lastAccessedAt: new Date('2025-01-02T00:00:00.000Z'),
        accessCount: 42,
      })
      const urlRepository = createRepository({
        findPopular: vi.fn(() => ResultTask.ok<Url[], DatabaseError>([popularUrl])),
      })
      const urlCacheService = createCacheService()
      const useCase = await createUseCase({ urlCacheService, urlRepository })

      const result = await useCase.getPopularUrls(5).runResult()

      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value).toEqual([
          expect.objectContaining({
            id: 'popular-url',
            shortCode: 'popular-code',
            originalUrl: 'https://popular.example',
            createdAt: new Date('2025-01-01T00:00:00.000Z'),
            lastAccessedAt: new Date('2025-01-02T00:00:00.000Z'),
            accessCount: 42,
          }),
        ])
      }
      expect(urlRepository.findPopular).toHaveBeenCalledWith(5)
    })
  })
})
