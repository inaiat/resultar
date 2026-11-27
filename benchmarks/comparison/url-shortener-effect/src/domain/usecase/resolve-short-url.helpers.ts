import type { Effect as EffectType } from 'effect/Effect'

import { Effect } from 'effect'

import type { CachedUrl, UrlDocument } from '../model/url.model.js'
import type { UrlUsecaseDependencies } from './url.usecase.js'

import { type DatabaseError, UrlExpiredError, UrlNotFoundError } from '../errors/url.errors.js'
import { softDeleteExpiredUrlAsync, updateAccessCountAsync } from './url.helpers.js'
import { documentToCached } from './url.mapper.js'

type ResolveShortUrlError = DatabaseError | UrlExpiredError | UrlNotFoundError
type CacheRead = UrlUsecaseDependencies['cache']['getUrl']

const isExpired = (expiresAt?: Date | string) =>
  expiresAt !== undefined && new Date(expiresAt) < new Date()

const trackCachedUrlAccess = ({
  cachedUrl,
  queueService,
  shortCode,
  source,
}: {
  readonly cachedUrl: CachedUrl
  readonly queueService: UrlUsecaseDependencies['queueService']
  readonly shortCode: string
  readonly source: 'alias' | 'cached'
}) =>
  Effect.sync(() => {
    updateAccessCountAsync({ queueService, urlId: cachedUrl.id, shortCode, source })
  })

const resolveCachedUrl = ({
  cachedUrl,
  queueService,
  shortCode,
  source,
}: {
  readonly cachedUrl: CachedUrl
  readonly queueService: UrlUsecaseDependencies['queueService']
  readonly shortCode: string
  readonly source: 'alias' | 'cached'
}): EffectType<string, UrlExpiredError> =>
  Effect.gen(function* () {
    if (isExpired(cachedUrl.expiresAt)) {
      return yield* Effect.fail(new UrlExpiredError({ shortCode }))
    }

    yield* trackCachedUrlAccess({ cachedUrl, queueService, shortCode, source })
    return cachedUrl.originalUrl
  })

export const findOriginalUrlInCache = ({
  identifier,
  queueService,
  read,
  shortCode,
  source,
}: {
  readonly identifier: string
  readonly queueService: UrlUsecaseDependencies['queueService']
  readonly read: CacheRead
  readonly shortCode: string
  readonly source: 'alias' | 'cached'
}): EffectType<string | undefined, UrlExpiredError> =>
  read(identifier).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
    Effect.flatMap((cachedUrl) => {
      if (cachedUrl === undefined) {
        return Effect.succeed(undefined)
      }

      return resolveCachedUrl({ cachedUrl, queueService, shortCode, source })
    }),
  )

const trackDatabaseUrlAccess = ({
  queueService,
  shortCode,
  url,
}: {
  readonly queueService: UrlUsecaseDependencies['queueService']
  readonly shortCode: string
  readonly url: UrlDocument
}) =>
  Effect.sync(() => {
    if (url._id === undefined) {
      return
    }

    updateAccessCountAsync({
      queueService,
      urlId: url._id.toString(),
      shortCode,
      source: 'database',
      customAlias: url.customAlias,
    })
  })

const cacheResolvedUrl = ({
  cache,
  url,
}: {
  readonly cache: UrlUsecaseDependencies['cache']
  readonly url: UrlDocument
}) => cache.cacheUrl(url.shortCode, documentToCached(url)).pipe(Effect.catch(() => Effect.void))

const handleExpiredDatabaseUrl = ({
  queueService,
  shortCode,
  url,
}: {
  readonly queueService: UrlUsecaseDependencies['queueService']
  readonly shortCode: string
  readonly url: UrlDocument
}): EffectType<never, UrlExpiredError> =>
  Effect.gen(function* () {
    const { _id } = url
    if (_id !== undefined) {
      yield* Effect.sync(() => {
        softDeleteExpiredUrlAsync({ queueService, urlId: _id, shortCode, expiresAt: url.expiresAt })
      })
    }

    return yield* Effect.fail(new UrlExpiredError({ shortCode }))
  })

export const findOriginalUrlInDatabase = ({
  cache,
  queueService,
  repository,
  shortCode,
}: {
  readonly cache: UrlUsecaseDependencies['cache']
  readonly queueService: UrlUsecaseDependencies['queueService']
  readonly repository: UrlUsecaseDependencies['repository']
  readonly shortCode: string
}): EffectType<string, ResolveShortUrlError> =>
  Effect.gen(function* () {
    const url = yield* repository.findActiveByIdentifier(shortCode)
    if (url === undefined) {
      return yield* Effect.fail(new UrlNotFoundError({ shortCode }))
    }

    if (isExpired(url.expiresAt)) {
      return yield* handleExpiredDatabaseUrl({ queueService, shortCode, url })
    }

    yield* cacheResolvedUrl({ cache, url })
    yield* trackDatabaseUrlAccess({ queueService, shortCode, url })

    return url.originalUrl
  })
