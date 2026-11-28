import { Context, Effect, Layer } from 'effect'
import { Redis } from 'ioredis'

import { AppConfigTag } from '../app-config.js'

export class RedisClient extends Context.Service<RedisClient>()('RedisClient', {
  make: Effect.gen(function* () {
    const config = yield* AppConfigTag
    const redisUrl = config.REDIS_URL
    const redis = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const connection = new Redis(redisUrl, {
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          connectTimeout: 1000,
        })
        // Cache commands report connection failures through the typed cache error.
        connection.on('error', () => undefined)
        return connection
      }),
      (client) =>
        Effect.sync(() => {
          client.disconnect()
        }),
    )

    return {
      redis,
      disconnect: () =>
        Effect.sync(() => {
          redis.disconnect()
        }),
    }
  }),
}) {
  static readonly Default = Layer.effect(this, this.make)
}
