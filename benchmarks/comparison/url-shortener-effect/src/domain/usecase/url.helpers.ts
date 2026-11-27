import type { ObjectId } from 'mongodb'

import { Effect } from 'effect'

import type { UrlQueueServicePort } from './url.usecase.js'

// Helper: Enqueue access count update via BullMQ
export const updateAccessCountAsync = (params: {
  queueService: UrlQueueServicePort
  urlId: string
  shortCode: string
  source: 'cached' | 'alias' | 'database'
  customAlias?: string
}) =>
  Effect.runFork(
    params.queueService
      .enqueueAccessCountUpdate({
        urlId: params.urlId,
        shortCode: params.shortCode,
        source: params.source,
        customAlias: params.customAlias,
      })
      .pipe(
        Effect.catch((error: unknown) =>
          Effect.logError('ACCESS_COUNT_UPDATE enqueue failed').pipe(
            Effect.annotateLogs({
              shortCode: params.shortCode,
              source: params.source,
              urlId: params.urlId,
              customAlias: params.customAlias,
              errorMessage: error instanceof Error ? error.message : String(error),
            }),
          ),
        ),
      ),
  )

// Helper: Enqueue soft delete via BullMQ
export const softDeleteExpiredUrlAsync = (params: {
  queueService: UrlQueueServicePort
  urlId: ObjectId
  shortCode: string
  expiresAt?: Date
}) =>
  Effect.runFork(
    params.queueService
      .enqueueSoftDelete({
        urlId: params.urlId.toString(),
        shortCode: params.shortCode,
        expiresAt: params.expiresAt?.toISOString(),
      })
      .pipe(
        Effect.catch((error: unknown) =>
          Effect.logError('SOFT_DELETE enqueue failed').pipe(
            Effect.annotateLogs({
              shortCode: params.shortCode,
              urlId: params.urlId.toString(),
              expiresAt: params.expiresAt?.toISOString(),
              errorMessage: error instanceof Error ? error.message : String(error),
            }),
          ),
        ),
      ),
  )
