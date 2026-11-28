import { Queue, Worker } from 'bullmq'
import { Effect } from 'effect'
import { Redis } from 'ioredis'

import { IntegrationError } from '../../domain/errors/integration.errors.js'

type Processor<Data, Result> = (input: { data: Data }) => Promise<Result> | Result

export type BullMqClientResource<Data, Result> = {
  readonly queue: Queue<Data, Result>
  readonly close: () => Promise<void>
}

type CreateBullMqClientOptions<Data, Result> = {
  readonly queueName: string
  readonly redisUrl: string
  readonly concurrency: number
  readonly processor: Processor<Data, Result>
  readonly onFailed: (input: { readonly error: unknown; readonly jobId?: string }) => void
  readonly onError: (error: unknown) => void
}

const closeBullMqResources = async <Data, Result>(
  connection: Redis,
  queue?: Queue<Data, Result>,
  worker?: Worker<Data, Result>,
) => {
  await Promise.allSettled([worker?.close(), queue?.close()])
  connection.disconnect()
}

const initBullMqClient = async <Data, Result>({
  concurrency,
  onError,
  onFailed,
  processor,
  queueName,
  redisUrl,
}: CreateBullMqClientOptions<Data, Result>): Promise<BullMqClientResource<Data, Result>> => {
  const connection = new Redis(redisUrl, {
    lazyConnect: true,
    // oxlint-disable-next-line unicorn/no-null -- BullMQ requires unlimited retries for its worker connection.
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    connectTimeout: 1000,
  })
  connection.on('error', onError)

  let queue: Queue<Data, Result> | undefined = undefined
  let worker: Worker<Data, Result> | undefined = undefined

  try {
    const activeQueue = new Queue<Data, Result>(queueName, {
      connection,
      defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
    })
    queue = activeQueue
    activeQueue.on('error', onError)

    const activeWorker = new Worker<Data, Result>(
      queueName,
      async (job) => processor({ data: job.data }),
      { connection, autorun: false, concurrency },
    )
    worker = activeWorker
    activeWorker.on('error', onError)
    activeWorker.on('failed', (job, error) => {
      onFailed({ error, jobId: job?.id })
    })
    activeWorker
      .waitUntilReady()
      .then(async () => activeWorker.run())
      .catch(onError)

    return {
      queue: activeQueue,
      close: async () => closeBullMqResources(connection, activeQueue, activeWorker),
    }
  } catch (error) {
    await closeBullMqResources(connection, queue, worker)
    throw error
  }
}

export const makeBullMqClient = <Data, Result>(options: CreateBullMqClientOptions<Data, Result>) =>
  Effect.tryPromise({
    try: async () => initBullMqClient(options),
    catch: (error) =>
      IntegrationError.queue(
        'init',
        `Failed to initialize BullMQ client: ${error instanceof Error ? error.message : String(error)}`,
      ),
  })
