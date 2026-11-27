import { ResultTask } from 'resultar'
import { describe, expect, it, vi } from 'vite-plus/test'

import type { UrlRepository } from '../src/domain/repository/url.repository.js'

import { CacheError, DatabaseError } from '../src/domain/errors/url.errors.js'
import {
  cleanupExpiredUrlBestEffort,
  recordAccessBestEffort,
} from '../src/domain/usecase/url.helpers.js'
import { createBestEffortLogger, createCacheService } from './helpers/url-usecase-fixtures.js'

const waitForDetachedTasks = async () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

const bestEffortFailureMessage = 'Best-effort URL operation failed'

describe('best-effort URL helpers', () => {
  it('records access asynchronously', async () => {
    const { logger, warn } = createBestEffortLogger()
    const recordAccess = vi.fn(() => ResultTask.ok<undefined, DatabaseError>(undefined))
    const repository: Pick<UrlRepository, 'recordAccess'> = { recordAccess }

    recordAccessBestEffort({ logger, recorder: repository, urlId: 'url-1' })

    await waitForDetachedTasks()
    expect(recordAccess).toHaveBeenCalledWith('url-1', expect.any(Date))
    expect(warn).not.toHaveBeenCalled()
  })

  it('logs access failures without affecting the caller', async () => {
    const error = DatabaseError.update(new Error('record failed'))
    const { logger, warn } = createBestEffortLogger()
    const repository: Pick<UrlRepository, 'recordAccess'> = {
      recordAccess: vi.fn(() => ResultTask.err<undefined, DatabaseError>(error)),
    }

    recordAccessBestEffort({ logger, recorder: repository, urlId: 'url-1' })

    await waitForDetachedTasks()
    expect(warn).toHaveBeenCalledWith(
      { operation: 'recordAccess', urlId: 'url-1', err: error },
      bestEffortFailureMessage,
    )
  })

  it('logs detached Resultar promise failures with operation context', async () => {
    const error = new Error('detached promise failed')
    const { logger, warn } = createBestEffortLogger()
    const repository: Pick<UrlRepository, 'recordAccess'> = {
      recordAccess: vi.fn(() => ResultTask.fromPromise(() => Promise.reject(error))),
    }

    recordAccessBestEffort({ logger, recorder: repository, urlId: 'url-1' })

    await waitForDetachedTasks()
    expect(warn).toHaveBeenCalledWith(
      { failure: 'detached-result', operation: 'recordAccess', urlId: 'url-1', err: error },
      bestEffortFailureMessage,
    )
  })

  it('marks an expired URL inactive and invalidates its cache key', async () => {
    const { logger } = createBestEffortLogger()
    const markInactive = vi.fn(() => ResultTask.ok<undefined, DatabaseError>(undefined))
    const repository: Pick<UrlRepository, 'markInactive'> = { markInactive }
    const cache = createCacheService()

    cleanupExpiredUrlBestEffort({
      cache,
      logger,
      repository,
      urlId: 'url-1',
      shortCode: 'abc',
      expiresAt: new Date('2024-01-01T00:00:00.000Z'),
    })

    await waitForDetachedTasks()
    expect(markInactive).toHaveBeenCalledWith('url-1', expect.any(Date))
    expect(cache.invalidate).toHaveBeenCalledWith('abc')
  })

  it('logs database cleanup failures and still invalidates the cache', async () => {
    const expiresAt = new Date('2024-01-01T00:00:00.000Z')
    const error = DatabaseError.update(new Error('cleanup failed'))
    const { logger, warn } = createBestEffortLogger()
    const repository: Pick<UrlRepository, 'markInactive'> = {
      markInactive: vi.fn(() => ResultTask.err<undefined, DatabaseError>(error)),
    }
    const cache = createCacheService()

    cleanupExpiredUrlBestEffort({
      cache,
      expiresAt,
      logger,
      repository,
      shortCode: 'abc',
      urlId: 'url-1',
    })

    await waitForDetachedTasks()
    expect(warn).toHaveBeenCalledWith(
      {
        expiresAt,
        operation: 'cleanupExpiredUrl',
        resource: 'database',
        shortCode: 'abc',
        urlId: 'url-1',
        err: error,
      },
      bestEffortFailureMessage,
    )
    expect(cache.invalidate).toHaveBeenCalledWith('abc')
  })

  it('logs cache cleanup failures without throwing', async () => {
    const error = new CacheError({ detail: 'cache unavailable' })
    const { logger, warn } = createBestEffortLogger()
    const repository: Pick<UrlRepository, 'markInactive'> = {
      markInactive: vi.fn(() => ResultTask.ok<undefined, DatabaseError>(undefined)),
    }
    const cache = createCacheService({
      invalidate: vi.fn(() => ResultTask.err<undefined, CacheError>(error)),
    })

    cleanupExpiredUrlBestEffort({ cache, logger, repository, shortCode: 'abc', urlId: 'url-1' })

    await waitForDetachedTasks()
    expect(warn).toHaveBeenCalledWith(
      {
        expiresAt: undefined,
        operation: 'cleanupExpiredUrl',
        resource: 'cache',
        shortCode: 'abc',
        urlId: 'url-1',
        err: error,
      },
      bestEffortFailureMessage,
    )
  })

  it('logs detached defects during expired URL cleanup without throwing', async () => {
    const error = new Error('unexpected cleanup defect')
    const { logger, warn } = createBestEffortLogger()
    const repository: Pick<UrlRepository, 'markInactive'> = {
      markInactive: vi.fn(() => ResultTask.fromPromise(() => Promise.reject(error))),
    }
    const cache = createCacheService()

    cleanupExpiredUrlBestEffort({ cache, logger, repository, shortCode: 'abc', urlId: 'url-1' })

    await waitForDetachedTasks()
    expect(warn).toHaveBeenCalledWith(
      {
        expiresAt: undefined,
        failure: 'detached-result',
        operation: 'cleanupExpiredUrl',
        shortCode: 'abc',
        urlId: 'url-1',
        err: error,
      },
      bestEffortFailureMessage,
    )
  })
})
