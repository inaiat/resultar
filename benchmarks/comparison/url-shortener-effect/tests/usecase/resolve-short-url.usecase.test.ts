import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'

import { CacheError } from '../../src/domain/errors/url.errors.js'
import { makeResolveShortUrlUsecase } from '../../src/domain/usecase/resolve-short-url.usecase.js'
import { createTestUrlDependencies } from '../helpers/test-layers.js'

const url = { shortCode: 'abc', originalUrl: 'http://db.com', accessCount: 0, isActive: true }

describe('resolveShortUrlUsecase', () => {
  it('returns UrlExpiredError if cached URL is expired', async () => {
    const dependencies = createTestUrlDependencies()
    const usecase = makeResolveShortUrlUsecase({
      ...dependencies,
      cache: {
        ...dependencies.cache,
        getUrl: () =>
          Effect.succeed({
            id: '507f1f77bcf86cd799439011',
            shortCode: url.shortCode,
            originalUrl: url.originalUrl,
            expiresAt: '2020-01-01T00:00:00.000Z',
          }),
      },
    })

    const result = await Effect.runPromiseExit(usecase('abc'))
    expect(result._tag).toBe('Failure')
  })

  it('handles cache failure gracefully', async () => {
    const dependencies = createTestUrlDependencies()
    await Effect.runPromise(dependencies.repository.create(url))
    const readCache = () => Effect.fail(new CacheError({ detail: 'cache fail' }))
    const usecase = makeResolveShortUrlUsecase({
      ...dependencies,
      cache: { ...dependencies.cache, getUrl: readCache },
    })

    const result = await Effect.runPromise(usecase('abc'))
    expect(result).toBe(url.originalUrl)
  })

  it('fails if db url is expired and handles soft delete', async () => {
    const dependencies = createTestUrlDependencies()
    await Effect.runPromise(
      dependencies.repository.create({ ...url, expiresAt: new Date('2020-01-01') }),
    )
    const enqueueSoftDelete = vi.fn(() => Effect.void)
    const usecase = makeResolveShortUrlUsecase({
      ...dependencies,
      queueService: { ...dependencies.queueService, enqueueSoftDelete },
    })

    const result = await Effect.runPromiseExit(usecase('abc'))
    expect(result._tag).toBe('Failure')
    expect(enqueueSoftDelete).toHaveBeenCalledOnce()
  })

  it('fails if db url is not found', async () => {
    const usecase = makeResolveShortUrlUsecase(createTestUrlDependencies())

    const result = await Effect.runPromiseExit(usecase('abc'))
    expect(result._tag).toBe('Failure')
  })
})
