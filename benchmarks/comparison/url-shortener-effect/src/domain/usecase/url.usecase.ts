import type { Effect as EffectType } from 'effect/Effect'

import { Context, Effect, Layer } from 'effect'

import type { IntegrationError } from '../errors/integration.errors.js'
import type { CacheError } from '../errors/url.errors.js'
import type { CachedUrl } from '../model/url.model.js'

import { UrlCacheService } from '../../infrastructure/cache/url-cache.service.js'
import { UrlQueueService } from '../../infrastructure/queue/url-queue.service.js'
import { UrlRepository, type UrlRepositoryService } from '../repository/url.repository.js'
import { makeCreateShortUrlUsecase } from './create-short-url.usecase.js'
import { makeDeleteUrlUsecase } from './delete-url.usecase.js'
import { makeResolveShortUrlUsecase } from './resolve-short-url.usecase.js'
import { documentToResponse } from './url.mapper.js'

export type { UrlRepositoryService } from '../repository/url.repository.js'

export type UrlCacheServicePort = {
  readonly cacheUrl: (shortCode: string, data: CachedUrl) => EffectType<void, CacheError>
  readonly getUrl: (shortCode: string) => EffectType<CachedUrl | undefined, CacheError>
  readonly invalidate: (shortCode: string) => EffectType<void, CacheError>
}

export type UrlQueueServicePort = {
  readonly enqueueAccessCountUpdate: (params: {
    urlId: string
    shortCode: string
    source: 'cached' | 'alias' | 'database'
    customAlias?: string
  }) => EffectType<void, IntegrationError>
  readonly enqueueSoftDelete: (params: {
    urlId: string
    shortCode: string
    expiresAt?: string
  }) => EffectType<void, IntegrationError>
}

export type UrlUsecaseDependencies = {
  readonly cache: UrlCacheServicePort
  readonly queueService: UrlQueueServicePort
  readonly repository: UrlRepositoryService
}

export class UrlService extends Context.Service<UrlService>()('UrlService', {
  make: Effect.gen(function* () {
    const repository = yield* UrlRepository
    const cache = yield* UrlCacheService
    const queueService = yield* UrlQueueService

    const dependencies = { cache, queueService, repository }

    return {
      createShortUrl: makeCreateShortUrlUsecase(dependencies),
      getOriginalUrl: makeResolveShortUrlUsecase(dependencies),
      deleteUrl: makeDeleteUrlUsecase(dependencies),
      listUrlStats: (type: 'recent' | 'popular', limit: number) =>
        (type === 'popular' ? repository.findPopular(limit) : repository.findRecent(limit)).pipe(
          Effect.map((urls) => urls.map(documentToResponse)),
        ),
    }
  }),
}) {
  static readonly Default = Layer.effect(this, this.make)
}
