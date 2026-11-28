import { Context, Effect, Layer } from 'effect'
import { MongoClient } from 'mongodb'

import { AppConfigTag } from '../app-config.js'

export class MongoClientService extends Context.Service<MongoClientService>()('MongoClient', {
  make: Effect.gen(function* () {
    const config = yield* AppConfigTag

    return yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new MongoClient(config.DB_URL, { serverSelectionTimeoutMS: config.DB_HEALTH_TIMEOUT_MS }),
      ),
      (connection) => Effect.promise(async () => connection.close()),
    )
  }),
}) {
  static readonly Default = Layer.effect(this, this.make)
}
