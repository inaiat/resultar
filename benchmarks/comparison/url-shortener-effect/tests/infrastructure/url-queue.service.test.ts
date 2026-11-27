import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'

import { IntegrationError } from '../../src/domain/errors/integration.errors.js'
import * as BullMQMock from '../../src/infrastructure/queue/bullmq-client.js'
import { UrlQueueService } from '../../src/infrastructure/queue/url-queue.service.js'
import { MockUrlRepository } from '../helpers/mock-url-repository.js'
import { TestAppConfigLive } from '../helpers/test-layers.js'

const ConfigLayer = TestAppConfigLive({ URL_ACCESS_WORKER_CONCURRENCY: 8 })

describe('UrlQueueService', () => {
  it('initializes and enqueues jobs', async () => {
    const mockQueue = { add: vi.fn().mockResolvedValue({ id: '1' }) }
    const mockClient = { queue: mockQueue, close: vi.fn().mockResolvedValue(undefined) }

    // Mock the makeBullMqClient function
    const makeBullMqClientSpy = vi
      .spyOn(BullMQMock, 'makeBullMqClient')
      .mockReturnValue(
        Effect.succeed(mockClient as unknown as BullMQMock.BullMqClientResource<unknown, unknown>),
      )

    const program = Effect.gen(function* () {
      const service = yield* UrlQueueService
      yield* service.enqueueAccessCountUpdate({ urlId: '1', shortCode: 'abc', source: 'cached' })
      yield* service.enqueueSoftDelete({ urlId: '1', shortCode: 'abc' })
      expect(mockQueue.add).toHaveBeenCalledTimes(2)
    })

    await Effect.runPromise(
      program.pipe(
        Effect.provide(UrlQueueService.Default),
        Effect.provide(ConfigLayer),
        Effect.provide(MockUrlRepository),
      ),
    )

    expect(mockClient.close).toHaveBeenCalledOnce()
    expect(makeBullMqClientSpy).toHaveBeenCalledWith(
      expect.objectContaining({ concurrency: 8, queueName: 'url-shortener-effect-jobs' }),
    )
    makeBullMqClientSpy.mockRestore()
  })

  it('handles initialization failure', async () => {
    vi.spyOn(BullMQMock, 'makeBullMqClient').mockReturnValue(
      Effect.fail(IntegrationError.queue('init', 'init fail')),
    )

    const program = Effect.gen(function* () {
      const service = yield* UrlQueueService
      // Should return the unavailable service which fails on enqueue
      const result = yield* Effect.exit(
        service.enqueueAccessCountUpdate({ urlId: '1', shortCode: 'abc', source: 'cached' }),
      )
      expect(result._tag).toBe('Failure')
    })

    await Effect.runPromise(
      program.pipe(
        Effect.provide(UrlQueueService.Default),
        Effect.provide(ConfigLayer),
        Effect.provide(MockUrlRepository),
      ),
    )

    vi.restoreAllMocks()
  })
})
