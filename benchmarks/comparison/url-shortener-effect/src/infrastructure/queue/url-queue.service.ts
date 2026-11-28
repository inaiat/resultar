import { Context, Effect, Layer, Result } from 'effect'

import { IntegrationError } from '../../domain/errors/integration.errors.js'
import { UrlRepository } from '../../domain/repository/url.repository.js'
import { AppConfigTag } from '../app-config.js'
import { makeBullMqClient } from './bullmq-client.js'
import { processUrlJob } from './url-queue.processor.js'
import { URL_QUEUE, type UrlJobData, type UrlJobResult } from './url-queue.types.js'
import { createUnavailableQueueService } from './url-queue.unavailable.js'

export class UrlQueueService extends Context.Service<UrlQueueService>()('UrlQueueService', {
  make: Effect.gen(function* () {
    const config = yield* AppConfigTag
    const repository = yield* UrlRepository

    const clientResult = yield* Effect.result(
      Effect.acquireRelease(
        makeBullMqClient<UrlJobData, UrlJobResult>({
          queueName: URL_QUEUE,
          redisUrl: config.REDIS_URL,
          concurrency: config.URL_ACCESS_WORKER_CONCURRENCY,
          processor: async ({ data }) => {
            const result = await Effect.runPromise(processUrlJob({ data, repository }))
            return result
          },
          onError: (error) => {
            Effect.runSync(Effect.logError('URL access queue unavailable', error))
          },
          onFailed: ({ error, jobId }) => {
            Effect.runSync(
              Effect.logError(
                `URL queue job ${jobId ?? 'unknown'} failed: ${error instanceof Error ? error.message : String(error)}`,
              ),
            )
          },
        }),
        (client) => Effect.promise(async () => client.close()),
      ),
    )

    if (Result.isFailure(clientResult)) {
      yield* Effect.logError(
        `BullMQ unavailable, continuing without background queue processing: ${clientResult.failure.message}`,
      )

      return createUnavailableQueueService(clientResult.failure)
    }

    const client = clientResult.success

    const enqueueJob = (jobName: string, data: UrlJobData) =>
      Effect.tryPromise({
        try: async () => {
          await client.queue.add(jobName, data)
        },
        catch: (error) =>
          IntegrationError.queue(
            'enqueue',
            `Failed to enqueue ${jobName}: ${error instanceof Error ? error.message : String(error)}`,
          ),
      })

    return {
      enqueueAccessCountUpdate: (params: {
        urlId: string
        shortCode: string
        source: 'cached' | 'alias' | 'database'
        customAlias?: string
      }) => enqueueJob('update-access-count', { type: 'update-access-count', ...params }),

      enqueueSoftDelete: (params: { urlId: string; shortCode: string; expiresAt?: string }) =>
        enqueueJob('soft-delete-expired', { type: 'soft-delete-expired', ...params }),

      close: () =>
        Effect.promise(async () => {
          await client.close()
        }),
    }
  }),
}) {
  static readonly Default = Layer.effect(this, this.make)
}

export const UrlQueueLive = UrlQueueService.Default
