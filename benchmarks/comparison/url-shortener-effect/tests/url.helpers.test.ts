import { Effect, Fiber } from 'effect'
import { ObjectId } from 'mongodb'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  softDeleteExpiredUrlAsync,
  updateAccessCountAsync,
} from '../src/domain/usecase/url.helpers.js'

describe('url.helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('enqueues access count updates without logging successful jobs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const enqueueAccessCountUpdate = vi.fn(() => Effect.void)
    const queueService = { enqueueAccessCountUpdate, enqueueSoftDelete: () => Effect.void }

    const fiber = updateAccessCountAsync({
      queueService,
      urlId: new ObjectId().toString(),
      shortCode: 'abc',
      source: 'cached',
    })

    await Effect.runPromise(Fiber.join(fiber))
    expect(enqueueAccessCountUpdate).toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('enqueues soft deletes without logging successful jobs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const enqueueSoftDelete = vi.fn(() => Effect.void)
    const queueService = { enqueueAccessCountUpdate: () => Effect.void, enqueueSoftDelete }
    const urlId = new ObjectId()

    const fiber = softDeleteExpiredUrlAsync({
      queueService,
      urlId,
      shortCode: 'abc',
      expiresAt: new Date('2024-01-01T00:00:00.000Z'),
    })

    await Effect.runPromise(Fiber.join(fiber))
    expect(enqueueSoftDelete).toHaveBeenCalledWith({
      urlId: urlId.toString(),
      shortCode: 'abc',
      expiresAt: '2024-01-01T00:00:00.000Z',
    })
    expect(log).not.toHaveBeenCalled()
  })
})
