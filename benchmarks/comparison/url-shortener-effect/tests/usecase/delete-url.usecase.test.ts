import { Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { CacheError } from '../../src/domain/errors/url.errors.js'
import { makeDeleteUrlUsecase } from '../../src/domain/usecase/delete-url.usecase.js'
import { createTestUrlDependencies } from '../helpers/test-layers.js'

describe('deleteUrlUsecase', () => {
  it('returns UrlNotFoundError if not found', async () => {
    const usecase = makeDeleteUrlUsecase(createTestUrlDependencies())

    const result = await Effect.runPromiseExit(usecase('abc'))
    expect(result._tag).toBe('Failure')
  })

  it('handles cache invalidate error gracefully', async () => {
    const { cache, repository } = createTestUrlDependencies()
    await Effect.runPromise(
      repository.create({
        shortCode: 'abc',
        originalUrl: 'http://a.com',
        accessCount: 0,
        isActive: true,
      }),
    )
    const usecase = makeDeleteUrlUsecase({
      cache: { ...cache, invalidate: () => Effect.fail(new CacheError({ detail: 'cache fail' })) },
      repository,
    })

    const result = await Effect.runPromiseExit(usecase('abc'))
    expect(result._tag).toBe('Success')
  })
})
