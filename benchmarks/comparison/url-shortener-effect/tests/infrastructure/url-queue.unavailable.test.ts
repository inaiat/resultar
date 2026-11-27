import { Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { IntegrationError } from '../../src/domain/errors/integration.errors.js'
import { createUnavailableQueueService } from '../../src/infrastructure/queue/url-queue.unavailable.js'

describe('UrlQueueUnavailable', () => {
  it('returns IntegrationError on enqueue methods', async () => {
    const error = IntegrationError.queue('init', 'offline')
    const service = createUnavailableQueueService(error)

    const updateResult = await Effect.runPromiseExit(
      service.enqueueAccessCountUpdate({ urlId: '123', shortCode: 'abc', source: 'database' }),
    )
    expect(updateResult._tag).toBe('Failure')

    const deleteResult = await Effect.runPromiseExit(
      service.enqueueSoftDelete({ urlId: '123', shortCode: 'abc' }),
    )
    expect(deleteResult._tag).toBe('Failure')

    const closeResult = await Effect.runPromiseExit(service.close())
    expect(closeResult._tag).toBe('Success')
  })
})
