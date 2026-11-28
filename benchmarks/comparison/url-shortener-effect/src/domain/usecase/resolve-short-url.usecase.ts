import type { Effect as EffectType } from 'effect/Effect'

import { Effect } from 'effect'

import type { DatabaseError, UrlExpiredError, UrlNotFoundError } from '../errors/url.errors.js'
import type { UrlUsecaseDependencies } from './url.usecase.js'

import { findOriginalUrlInCache, findOriginalUrlInDatabase } from './resolve-short-url.helpers.js'

export const makeResolveShortUrlUsecase =
  ({ cache, queueService, repository }: UrlUsecaseDependencies) =>
  (shortCode: string): EffectType<string, DatabaseError | UrlExpiredError | UrlNotFoundError> =>
    Effect.gen(function* () {
      const cachedByShortCode = yield* findOriginalUrlInCache({
        identifier: shortCode,
        queueService,
        read: cache.getUrl,
        shortCode,
        source: 'cached',
      })
      if (cachedByShortCode !== undefined) {
        return cachedByShortCode
      }

      return yield* findOriginalUrlInDatabase({ cache, queueService, repository, shortCode })
    })
