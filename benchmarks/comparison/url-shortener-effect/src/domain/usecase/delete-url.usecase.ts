import type { Effect as EffectType } from 'effect/Effect'

import { Effect } from 'effect'

import type { UrlUsecaseDependencies } from './url.usecase.js'

import { type DatabaseError, UrlNotFoundError } from '../errors/url.errors.js'

export const makeDeleteUrlUsecase =
  ({ cache, repository }: Pick<UrlUsecaseDependencies, 'cache' | 'repository'>) =>
  (shortCode: string): EffectType<void, DatabaseError | UrlNotFoundError> =>
    Effect.gen(function* () {
      const url = yield* repository.findActiveByIdentifier(shortCode)
      if (!url || url._id === undefined) {
        return yield* Effect.fail(new UrlNotFoundError({ shortCode }))
      }

      yield* repository.markInactive(url._id, new Date())

      yield* cache
        .invalidate(url.shortCode)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `Cache invalidation error: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        )

      return undefined
    })
