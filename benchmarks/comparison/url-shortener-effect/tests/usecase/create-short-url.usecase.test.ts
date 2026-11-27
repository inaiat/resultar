import { Cause, Effect, Exit } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'

import {
  CacheError,
  CustomAliasExistsError,
  DatabaseError,
  InvalidCustomAliasError,
  InvalidUrlError,
  UrlCreationError,
} from '../../src/domain/errors/url.errors.js'
import { makeCreateShortUrlUsecase } from '../../src/domain/usecase/create-short-url.usecase.js'
import { createTestUrlDependencies } from '../helpers/test-layers.js'

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined => {
  if (!Exit.isFailure(exit)) {
    return undefined
  }
  const fail = exit.cause.reasons.find(Cause.isFailReason)
  return fail?.error
}

describe('createShortUrlUsecase', () => {
  it('fails on invalid url and unsupported protocol', async () => {
    const usecase = makeCreateShortUrlUsecase(createTestUrlDependencies())

    for (const originalUrl of ['not-a-url', 'ftp://files.example/archive']) {
      const result = await Effect.runPromiseExit(usecase({ originalUrl }))
      expect(failureOf(result)).toBeInstanceOf(InvalidUrlError)
    }
  })

  it('rejects reserved custom alias stats without querying the repository', async () => {
    const { cache, repository } = createTestUrlDependencies()
    const createSpy = vi.spyOn(repository, 'create')
    const findSpy = vi.spyOn(repository, 'findActiveByIdentifier')
    const usecase = makeCreateShortUrlUsecase({ cache, repository })

    const result = await Effect.runPromiseExit(
      usecase({ originalUrl: 'https://example.com', customAlias: 'stats' }),
    )
    expect(failureOf(result)).toBeInstanceOf(InvalidCustomAliasError)
    expect(createSpy).not.toHaveBeenCalled()
    expect(findSpy).not.toHaveBeenCalled()
  })

  it('maps unique constraint violation on insert to 409 CustomAliasExistsError without pre-checking', async () => {
    const { cache, repository } = createTestUrlDependencies()
    const findSpy = vi.spyOn(repository, 'findActiveByIdentifier')
    const usecase = makeCreateShortUrlUsecase({
      cache,
      repository: {
        ...repository,
        create: () => Effect.fail(DatabaseError.constraint('Duplicate entry')),
      },
    })

    const result = await Effect.runPromiseExit(
      usecase({ originalUrl: 'https://example.com', customAlias: 'taken-alias' }),
    )
    const error = failureOf(result)
    expect(error).toBeInstanceOf(CustomAliasExistsError)
    expect(error?.statusCode).toBe(409)
    expect(findSpy).not.toHaveBeenCalled()
  })

  it('retries generated short codes on unique violation and stops after the attempt limit', async () => {
    const { cache, repository } = createTestUrlDependencies()
    let attempts = 0
    const retryingUsecase = makeCreateShortUrlUsecase({
      cache,
      repository: {
        ...repository,
        create: (data) => {
          attempts += 1
          if (attempts === 1) {
            return Effect.fail(DatabaseError.constraint('Duplicate entry'))
          }
          return repository.create(data)
        },
      },
    })

    const created = await Effect.runPromise(retryingUsecase({ originalUrl: 'https://example.com' }))
    expect(attempts).toBe(2)
    expect(created.originalUrl).toBe('https://example.com')

    let exhaustedAttempts = 0
    const exhaustedUsecase = makeCreateShortUrlUsecase({
      cache,
      repository: {
        ...repository,
        create: () => {
          exhaustedAttempts += 1
          return Effect.fail(DatabaseError.constraint('Duplicate entry'))
        },
      },
    })

    const exhausted = await Effect.runPromiseExit(
      exhaustedUsecase({ originalUrl: 'https://example.com' }),
    )
    expect(exhaustedAttempts).toBe(10)
    expect(failureOf(exhausted)).toBeInstanceOf(UrlCreationError)
  })

  it('fails on taken alias', async () => {
    const usecase = makeCreateShortUrlUsecase(createTestUrlDependencies())
    const request = { originalUrl: 'http://a.com', customAlias: 'abc' }
    await Effect.runPromise(usecase(request))

    const result = await Effect.runPromiseExit(usecase(request))
    expect(failureOf(result)).toBeInstanceOf(CustomAliasExistsError)
  })

  it('handles cache failure gracefully', async () => {
    const { cache, repository } = createTestUrlDependencies()
    const usecase = makeCreateShortUrlUsecase({
      cache: { ...cache, cacheUrl: () => Effect.fail(new CacheError({ detail: 'cache fail' })) },
      repository,
    })

    const result = await Effect.runPromiseExit(
      usecase({ originalUrl: 'http://a.com', customAlias: 'abc' }),
    )
    expect(result._tag).toBe('Success')
  })
})
