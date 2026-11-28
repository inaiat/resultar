import { Context, Effect, Layer } from 'effect'

import type { CachedUrl } from '../../domain/model/url.model.js'

import { CacheError } from '../../domain/errors/url.errors.js'
import { AppConfigTag } from '../app-config.js'
import { RedisClient } from './redis-client.js'
import { parseCachedUrl } from './url-cache.payload.js'

export class UrlCacheService extends Context.Service<UrlCacheService>()('UrlCacheService', {
  make: Effect.gen(function* () {
    const { redis } = yield* RedisClient
    const { REDIS_TTL_SECONDS: ttl, URL_CACHE_PREFIX: prefix } = yield* AppConfigTag
    const run = async <T>(command: () => Promise<T>) => {
      if (redis.status === 'wait') {
        await redis.connect()
      }
      return command()
    }

    const getShortCodeKey = (shortCode: string) => `${prefix}${shortCode}`

    const fetchCached = async (key: string) => {
      const data = await run(async () => redis.get(key))
      if (data === null) {
        return undefined
      }
      return parseCachedUrl(data)
    }

    const cacheJson = async (key: string, data: CachedUrl) =>
      run(async () => redis.set(key, JSON.stringify(data), 'EX', ttl))

    return {
      cacheUrl: (shortCode: string, data: CachedUrl) =>
        Effect.tryPromise({
          try: async () => {
            await cacheJson(getShortCodeKey(shortCode), data)
          },
          catch: (error) => new CacheError({ detail: String(error) }),
        }),

      getUrl: (shortCode: string) =>
        Effect.tryPromise({
          try: async () => fetchCached(getShortCodeKey(shortCode)),
          catch: (error) => new CacheError({ detail: String(error) }),
        }),

      invalidate: (shortCode: string) =>
        Effect.tryPromise({
          try: async () => {
            await run(async () => redis.del(getShortCodeKey(shortCode)))
          },
          catch: (error) => new CacheError({ detail: String(error) }),
        }),
    }
  }),
}) {
  static readonly Default = Layer.effect(this, this.make)
}
