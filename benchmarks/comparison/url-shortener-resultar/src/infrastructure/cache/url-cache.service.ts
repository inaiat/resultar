import { RedisClientService } from './redis-client.js'
import { service } from 'resultar-di'
import { ResultTask, err, ok, tryResult, type StrictResult } from 'resultar'

import type {
  UrlCacheService,
  UrlCacheServiceResult,
} from '../../domain/cache/url-cache.service.js'
import type { CachedUrl } from '../../domain/model/url.model.js'

import { CacheError } from '../../domain/errors/url.errors.js'

const objectIdPattern = /^[0-9a-fA-F]{24}$/u
const isoDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u

const isValidCachedUrl = (value: unknown): value is CachedUrl => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    !('shortCode' in value) ||
    !('originalUrl' in value)
  ) {
    return false
  }
  if (
    typeof value.id !== 'string' ||
    !objectIdPattern.test(value.id) ||
    typeof value.shortCode !== 'string' ||
    typeof value.originalUrl !== 'string'
  ) {
    return false
  }
  if ('expiresAt' in value && value.expiresAt !== undefined) {
    return typeof value.expiresAt === 'string' && isoDateTimePattern.test(value.expiresAt)
  }
  return true
}

const CacheConfig = service.require<{
  readonly REDIS_TTL_SECONDS: number
  readonly URL_CACHE_PREFIX: string
}>()('appConfig')

const toCacheError = (error: unknown) =>
  new CacheError({ detail: error instanceof Error ? error.message : String(error), cause: error })

const parseCachedUrl = (data: string): StrictResult<CachedUrl, CacheError> => {
  const parsed = tryResult(() => JSON.parse(data) as unknown, toCacheError)
  if (parsed.isErr()) {
    return err(parsed.error)
  }
  if (!isValidCachedUrl(parsed.value)) {
    return CacheError.err({ detail: 'Invalid cached URL payload' })
  }
  return ok(parsed.value)
}

const decodeCachedEntry = (data: string | null): StrictResult<CachedUrl | undefined, CacheError> =>
  data === null ? ok(undefined) : parseCachedUrl(data)

export const RedisUrlCacheService = service<UrlCacheService>()('urlCacheService', {
  requires: { config: CacheConfig, redisClient: RedisClientService },
  make: ({ config, redisClient }) => {
    const ttl = config.REDIS_TTL_SECONDS
    const prefix = config.URL_CACHE_PREFIX

    return {
      cacheUrl(shortCode: string, data: CachedUrl): UrlCacheServiceResult<void> {
        const payload = tryResult(() => JSON.stringify(data), toCacheError)
        if (payload.isErr()) {
          return ResultTask.err(payload.error)
        }
        return redisClient
          .set(`${prefix}${shortCode}`, payload.value, { ttlSeconds: ttl })
          .mapErr(toCacheError)
      },

      getUrl(shortCode: string): UrlCacheServiceResult<CachedUrl | undefined> {
        return redisClient
          .get(`${prefix}${shortCode}`)
          .mapErr(toCacheError)
          .andThen(decodeCachedEntry)
      },

      invalidate(shortCode: string): UrlCacheServiceResult<void> {
        return redisClient.del(`${prefix}${shortCode}`).mapErr(toCacheError).asVoid()
      },
    }
  },
})
