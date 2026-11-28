import type { FastifyBaseLogger as Logger } from 'fastify'
import { Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import { createModule, service } from 'resultar-di'
import { ResultTask, createTaggedError } from 'resultar'
import type { UrlAccessRecorder, UrlRepository } from '../../domain/repository/url.repository.js'
import { formatIsoDate } from '../../domain/usecase/url.mapper.js'

type AccessJob = { readonly urlId: string; readonly accessedAt: string }
const queueName = 'url-shortener-resultar-jobs'
const jobName = 'update-access-count'
class UrlAccessQueueError extends createTaggedError({
  name: 'UrlAccessQueueError',
  message: 'Could not enqueue access tracking for URL $urlId',
}).withProps<{ urlId: string }>() {}
type QueueLogger = Pick<Logger, 'error'>
const BullMq = service.require<{ queue: Queue<AccessJob>; worker: Worker<AccessJob> }>()('bullMq')

export const createUrlAccessQueueModule = (
  { url, concurrency }: { readonly url: string; readonly concurrency: number },
  logger: QueueLogger,
  persistAccess: UrlRepository['recordAccess'],
) =>
  createModule()
    .resource('bullMq', [], {
      acquire: () =>
        ResultTask.sync(() => {
          const connection = new Redis(url, {
            lazyConnect: true,
            // oxlint-disable-next-line unicorn/no-null -- BullMQ requires unlimited retries for its worker connection.
            maxRetriesPerRequest: null,
            enableOfflineQueue: false,
            connectTimeout: 1000,
          })
          const queue = new Queue<AccessJob>(queueName, {
            connection,
            defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
          })
          const worker = new Worker<AccessJob>(
            queueName,
            async ({ data }, _token, signal) =>
              persistAccess(data.urlId, new Date(data.accessedAt))
                .as(undefined)
                .runPromise({ signal }),
            { connection, autorun: false, concurrency },
          )
          queue.on('error', (err) => {
            logger.error({ err }, 'URL access queue unavailable')
          })
          worker.on('error', (err) => {
            logger.error({ err }, 'URL access worker unavailable')
          })
          worker.on('failed', (job, err) => {
            logger.error({ err, jobId: job?.id, urlId: job?.data.urlId }, 'URL access job failed')
          })
          connection.on('error', (err) => {
            logger.error({ err }, 'URL access Redis unavailable')
          })
          return { queue, worker, connection }
        }),
      release: ({ worker, queue, connection }) =>
        ResultTask.fromPromise(async () => worker.close())
          .ensuring(() => ResultTask.fromPromise(async () => queue.close()))
          .ensuring(() =>
            ResultTask.sync(() => {
              connection.disconnect()
            }),
          ),
      lifetime: 'singleton',
    })
    .singleton('urlAccessRecorder', ['bullMq'], ({ bullMq }): UrlAccessRecorder => ({
      recordAccess: (urlId, accessedAt) =>
        ResultTask.tryPromise({
          // oxlint-disable-next-line typescript/promise-function-async -- Return BullMQ Promise directly to avoid extra microtask per redirect.
          try: () => bullMq.queue.add(jobName, { urlId, accessedAt: formatIsoDate(accessedAt) }),
          catch: (cause) => new UrlAccessQueueError({ urlId, cause }),
        }).asVoid(),
    }))

export const startUrlAccessWorker = (logger: QueueLogger) =>
  ResultTask.gen(function* () {
    const { worker } = yield* BullMq
    worker
      .waitUntilReady()
      .then(async () => worker.run())
      .catch((error: unknown) => {
        logger.error({ err: error }, 'URL access worker stopped')
      })
  })
