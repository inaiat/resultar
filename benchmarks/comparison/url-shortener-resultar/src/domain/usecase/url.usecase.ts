import type { FastifyBaseLogger as Logger } from 'fastify'

import { service } from 'resultar-di'
import { ResultTask, type StrictResultTask } from 'resultar'

import type { UrlCacheService } from '../cache/url-cache.service.js'
import type { CachedUrl, CreateUrlInput, Url } from '../model/url.model.js'
import type {
  UrlAccessRecorder,
  UrlRepository,
  UrlRepositoryResult,
} from '../repository/url.repository.js'

import {
  UrlExpiredError,
  UrlNotFoundError,
  type CustomAliasExistsError,
  type DatabaseError,
  type InvalidCustomAliasError,
  type InvalidUrlError,
  type UrlCreationError,
} from '../errors/url.errors.js'
import { createAvailableUrl } from './url.creation.js'
import {
  bestEffortFailureMessage,
  cleanupExpiredUrlBestEffort,
  recordAccessBestEffort,
} from './url.helpers.js'
import { urlToCached } from './url.mapper.js'

type UrlUseCaseError =
  | CustomAliasExistsError
  | DatabaseError
  | InvalidCustomAliasError
  | InvalidUrlError
  | UrlCreationError
  | UrlExpiredError
  | UrlNotFoundError

type UrlUseCaseResult<T> = StrictResultTask<T, UrlUseCaseError>

type UrlUseCaseDeps = {
  readonly urlRepository: UrlRepository
  readonly urlCacheService: UrlCacheService
  readonly urlAccessRecorder: UrlAccessRecorder
}

const UrlRepositoryTag = service.require<UrlRepository>()('urlRepository')
const UrlCacheServiceTag = service.require<UrlCacheService>()('urlCacheService')
const UrlAccessRecorderTag = service.require<UrlAccessRecorder>()('urlAccessRecorder')

const resolveCachedUrl = (
  cachedUrl: CachedUrl,
  context: { readonly shortCode: string; readonly logger: Logger },
  deps: UrlUseCaseDeps,
): UrlUseCaseResult<string> => {
  const { logger, shortCode } = context
  if (cachedUrl.expiresAt !== undefined) {
    const expiresAt = new Date(cachedUrl.expiresAt)
    if (expiresAt.getTime() <= Date.now()) {
      cleanupExpiredUrlBestEffort({
        cache: deps.urlCacheService,
        expiresAt,
        logger,
        repository: deps.urlRepository,
        shortCode,
        urlId: cachedUrl.id,
      })
      return UrlExpiredError.taskErr({ shortCode })
    }
  }
  recordAccessBestEffort({ logger, recorder: deps.urlAccessRecorder, urlId: cachedUrl.id })
  return ResultTask.ok(cachedUrl.originalUrl)
}

const resolveRepositoryUrl = (
  shortCode: string,
  logger: Logger,
  deps: UrlUseCaseDeps,
): UrlUseCaseResult<string> =>
  deps.urlRepository.findActiveByIdentifier(shortCode).andThen((url): UrlUseCaseResult<string> => {
    if (url === undefined) {
      return UrlNotFoundError.taskErr({ shortCode })
    }
    if (url.expiresAt !== undefined && url.expiresAt.getTime() <= Date.now()) {
      cleanupExpiredUrlBestEffort({
        cache: deps.urlCacheService,
        expiresAt: url.expiresAt,
        logger,
        repository: deps.urlRepository,
        shortCode: url.shortCode,
        urlId: url.id,
      })
      return UrlExpiredError.taskErr({ shortCode })
    }
    return deps.urlCacheService
      .cacheUrl(url.shortCode, urlToCached(url))
      .orElseSucceed((err) => {
        logger.warn(
          { operation: 'cacheResolvedUrl', shortCode: url.shortCode, err },
          bestEffortFailureMessage,
        )
        return undefined
      })
      .map(() => {
        recordAccessBestEffort({ logger, recorder: deps.urlAccessRecorder, urlId: url.id })
        return url.originalUrl
      })
  })

export const UrlUseCase = service('urlUseCase', {
  requires: {
    urlRepository: UrlRepositoryTag,
    urlCacheService: UrlCacheServiceTag,
    urlAccessRecorder: UrlAccessRecorderTag,
  },
  make: (deps) => ({
    createShortUrl(request: CreateUrlInput, logger: Logger): UrlUseCaseResult<Url> {
      return createAvailableUrl(request, {
        logger,
        urlCacheService: deps.urlCacheService,
        urlRepository: deps.urlRepository,
      })
    },

    getOriginalUrl(shortCode: string, logger: Logger): UrlUseCaseResult<string> {
      return deps.urlCacheService
        .getUrl(shortCode)
        .orElseSucceed((err) => {
          logger.warn({ operation: 'readCachedUrl', shortCode, err }, bestEffortFailureMessage)
          return undefined
        })
        .andThen((cachedUrl) =>
          cachedUrl === undefined
            ? resolveRepositoryUrl(shortCode, logger, deps)
            : resolveCachedUrl(cachedUrl, { shortCode, logger }, deps),
        )
    },

    deleteUrl(shortCode: string, logger: Logger): UrlUseCaseResult<undefined> {
      return deps.urlRepository
        .findActiveByIdentifier(shortCode)
        .andThen((url): UrlUseCaseResult<undefined> => {
          if (url === undefined) {
            return UrlNotFoundError.taskErr({ shortCode })
          }
          return deps.urlRepository
            .markInactive(url.id, new Date())
            .andThen(() =>
              deps.urlCacheService.invalidate(url.shortCode).orElseSucceed((err) => {
                logger.warn(
                  { operation: 'invalidateDeletedUrl', shortCode: url.shortCode, err },
                  bestEffortFailureMessage,
                )
                return undefined
              }),
            )
            .as(undefined)
        })
    },

    getPopularUrls(limit: number): UrlRepositoryResult<Url[]> {
      return deps.urlRepository.findPopular(limit)
    },

    getRecentUrls(limit: number): UrlRepositoryResult<Url[]> {
      return deps.urlRepository.findRecent(limit)
    },
  }),
})
