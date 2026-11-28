import { Context, Effect, Layer } from 'effect'

import { AppConfigTag } from '../app-config.js'
import { MongoClientService } from './mongo-client.js'

export class MongoDatabaseService extends Context.Service<MongoDatabaseService>()('MongoDatabase', {
  make: Effect.gen(function* () {
    const config = yield* AppConfigTag
    const client = yield* MongoClientService
    const database = client.db(config.DB_NAME)

    yield* Effect.tryPromise({
      try: async () =>
        database.command({ ping: 1 }, { signal: AbortSignal.timeout(config.DB_HEALTH_TIMEOUT_MS) }),
      catch: (cause) => new Error('MongoDB startup check failed', { cause }),
    })

    return database
  }),
}) {
  static readonly Default = Layer.effect(this, this.make)
}
