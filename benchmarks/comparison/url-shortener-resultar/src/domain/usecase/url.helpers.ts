import type { FastifyBaseLogger as Logger } from 'fastify'

import type { Cause } from 'resultar'

import type { UrlCacheService } from '../cache/url-cache.service.js'
import type { UrlAccessRecorder, UrlRepository } from '../repository/url.repository.js'

type BestEffortContext = Readonly<{ operation: string } & Record<string, unknown>>

export const bestEffortFailureMessage = 'Best-effort URL operation failed'

const logDetachedCause = <E>(logger: Logger, context: BestEffortContext, cause: Cause<E>): void => {
  if (cause._tag === 'Fail') {
    logger.warn({ ...context, err: cause.error }, bestEffortFailureMessage)
    return
  }
  const err = cause._tag === 'Die' ? cause.defect : cause
  logger.warn({ ...context, failure: 'detached-result', err }, bestEffortFailureMessage)
}

export const recordAccessBestEffort = (params: {
  logger: Logger
  recorder: UrlAccessRecorder
  urlId: string
}): void => {
  params.recorder
    .recordAccess(params.urlId, new Date())
    .inspectCause((cause) => {
      logDetachedCause(params.logger, { operation: 'recordAccess', urlId: params.urlId }, cause)
    })
    .runFork()
}

export const cleanupExpiredUrlBestEffort = (params: {
  cache: Pick<UrlCacheService, 'invalidate'>
  expiresAt?: Date
  logger: Logger
  repository: Pick<UrlRepository, 'markInactive'>
  shortCode: string
  urlId: string
}): void => {
  const context: BestEffortContext = {
    expiresAt: params.expiresAt,
    operation: 'cleanupExpiredUrl',
    shortCode: params.shortCode,
    urlId: params.urlId,
  }

  params.repository
    .markInactive(params.urlId, new Date())
    .orElseSucceed((err) => {
      params.logger.warn({ ...context, resource: 'database', err }, bestEffortFailureMessage)
      return undefined
    })
    .andThen(() =>
      params.cache.invalidate(params.shortCode).orElseSucceed((err) => {
        params.logger.warn({ ...context, resource: 'cache', err }, bestEffortFailureMessage)
        return undefined
      }),
    )
    .inspectCause((cause) => {
      logDetachedCause(params.logger, context, cause)
    })
    .runFork()
}
