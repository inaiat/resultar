import { Effect } from 'effect'
import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vite-plus/test'

import type { UrlJobData } from '../../src/infrastructure/queue/url-queue.types.js'

import { createMockUrlRepository } from '../helpers/mock-url-repository.js'
import { processUrlJob } from '../../src/infrastructure/queue/url-queue.processor.js'

describe('UrlQueueProcessor', () => {
  it('processes update-access-count', async () => {
    const mockRepo = createMockUrlRepository()
    const recordAccess = vi.spyOn(mockRepo, 'recordAccess')
    const data = {
      type: 'update-access-count' as const,
      urlId: new ObjectId().toString(),
      shortCode: 'abc',
      source: 'cached' as const,
    }
    const result = await Effect.runPromise(processUrlJob({ data, repository: mockRepo }))
    expect(result.success).toBe(true)
    expect(recordAccess).toHaveBeenCalledExactlyOnceWith(new ObjectId(data.urlId), expect.any(Date))
  })

  it('processes soft-delete-expired', async () => {
    const mockRepo = createMockUrlRepository()
    const markInactive = vi.spyOn(mockRepo, 'markInactive')
    const data = {
      type: 'soft-delete-expired' as const,
      urlId: new ObjectId().toString(),
      shortCode: 'abc',
      expiresAt: '2020-01-01',
    }
    const result = await Effect.runPromise(processUrlJob({ data, repository: mockRepo }))
    expect(result.success).toBe(true)
    expect(markInactive).toHaveBeenCalledExactlyOnceWith(new ObjectId(data.urlId), expect.any(Date))
  })

  it('ignores unknown job type', async () => {
    const mockRepo = createMockUrlRepository()
    const data = { type: 'unknown', urlId: new ObjectId().toString() } as unknown as UrlJobData
    const result = await Effect.runPromise(processUrlJob({ data, repository: mockRepo }))
    expect(result.success).toBe(false)
  })
})
