import { MongoClient } from 'mongodb'
import Papr from 'papr'
import { ResultTask, type StrictResultTask } from 'resultar'
import { createModule } from 'resultar-di'
import { urlCollection } from '../papr/url.schema.js'

export type MongoPaprProvisioningService = { provision: () => StrictResultTask<void> }

export const createMongoPaprModule = (options: {
  url: string
  databaseName: string
  startupTimeoutMs: number
}) =>
  createModule()
    .resource('mongoClient', [], {
      acquire: () =>
        ResultTask.sync(
          () =>
            new MongoClient(options.url, { serverSelectionTimeoutMS: options.startupTimeoutMs }),
        ),
      release: (client) => ResultTask.fromPromise(async () => client.close()),
      lifetime: 'singleton',
    })
    .singleton('mongoDatabase', ['mongoClient'], ({ mongoClient }) =>
      mongoClient.db(options.databaseName),
    )
    .singleton('papr', ['mongoDatabase'], ({ mongoDatabase }) => {
      const papr = new Papr()
      papr.initialize(mongoDatabase)
      return papr
    })
    .singleton('urlCollection', ['papr'], ({ papr }) => urlCollection.createModel({ papr }))
    .singleton(
      'mongoPaprProvisioningService',
      ['mongoDatabase', 'papr', 'urlCollection'],
      ({ mongoDatabase, papr, urlCollection: model }): MongoPaprProvisioningService => ({
        provision: () =>
          ResultTask.gen(function* () {
            yield* ResultTask.tryPromise({
              try: async () =>
                mongoDatabase.command(
                  { ping: 1 },
                  { signal: AbortSignal.timeout(options.startupTimeoutMs) },
                ),
              catch: (cause) => new Error('MongoDB startup check failed', { cause }),
            })
            yield* urlCollection.migrate(papr, model)
          }),
      }),
    )
