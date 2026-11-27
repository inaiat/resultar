import { Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { CacheError } from '../../src/domain/errors/url.errors.js'
import { makeCreateShortUrlUsecase } from '../../src/domain/usecase/create-short-url.usecase.js'
import { createTestUrlDependencies } from '../helpers/test-layers.js'

describe('createShortUrlUsecase', () => {
  it('fails on invalid url', async () => {
    const usecase = makeCreateShortUrlUsecase(createTestUrlDependencies())

    const result = await Effect.runPromiseExit(usecase({ originalUrl: 'not-a-url' }))
    expect(result._tag).toBe('Failure')
  })

  it('fails on taken alias', async () => {
    const usecase = makeCreateShortUrlUsecase(createTestUrlDependencies())
    const request = { originalUrl: 'http://a.com', customAlias: 'abc' }
    await Effect.runPromise(usecase(request))

    const result = await Effect.runPromiseExit(usecase(request))
    expect(result._tag).toBe('Failure')
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
