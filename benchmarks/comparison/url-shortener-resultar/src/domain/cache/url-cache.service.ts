import type { StrictResultTask } from 'resultar'

import type { CacheError } from '../errors/url.errors.js'
import type { CachedUrl } from '../model/url.model.js'

export type UrlCacheServiceResult<T> = StrictResultTask<T, CacheError>

export type UrlCacheService = {
  readonly cacheUrl: (shortCode: string, data: CachedUrl) => UrlCacheServiceResult<void>
  readonly getUrl: (shortCode: string) => UrlCacheServiceResult<CachedUrl | undefined>
  readonly invalidate: (shortCode: string) => UrlCacheServiceResult<void>
}
