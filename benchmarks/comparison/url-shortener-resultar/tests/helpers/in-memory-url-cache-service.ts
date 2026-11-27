import { ResultTask } from 'resultar'

import type { UrlCacheService } from '../../src/domain/cache/url-cache.service.js'
import type { CachedUrl } from '../../src/domain/model/url.model.js'

import { CacheError } from '../../src/domain/errors/url.errors.js'

export type CacheReadMode = 'memory' | 'miss' | 'error'

const success = <T>(value: T) => ResultTask.ok<T, CacheError>(value)

export const createInMemoryUrlCacheService = (
  readMode: CacheReadMode = 'memory',
): UrlCacheService => {
  const urls = new Map<string, CachedUrl>()

  const read = (value: CachedUrl | undefined) => {
    if (readMode === 'error') {
      return ResultTask.err<CachedUrl | undefined, CacheError>(
        new CacheError({ detail: 'Simulated cache outage' }),
      )
    }

    return success(readMode === 'miss' ? undefined : value)
  }

  return {
    cacheUrl: (shortCode, data) => {
      urls.set(shortCode, data)
      return success(undefined)
    },
    getUrl: (shortCode) => read(urls.get(shortCode)),
    invalidate: (shortCode) => {
      urls.delete(shortCode)
      return success(undefined)
    },
  }
}
