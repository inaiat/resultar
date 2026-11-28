import { MongoClient } from 'mongodb'
import Papr from 'papr'
import { ResultTask, type StrictResultTask } from 'resultar'
import { createModule } from 'resultar-di'
import {
  urlCollection,
  type PaprOperationError,
  type UrlCollectionModel,
} from '../papr/url.schema.js'

export type MongoPaprProvisioningService = {
  checkReadiness?: () => StrictResultTask<void>
  ensureIndexes?: () => StrictResultTask<void>
  provision: () => StrictResultTask<void>
}

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
    .singleton('urlIndexProvisioner', ['papr'], ({ papr }) => {
      const model = urlCollection.createModel({ papr })
      let ready = false
      const migrateOnce = ResultTask.memoize(
        ResultTask.suspend(() => urlCollection.migrate(papr, model)).tap(() => {
          ready = true
        }),
      )
      const ensureIndexes = (): StrictResultTask<void, PaprOperationError> =>
        ready ? ResultTask.ok(undefined) : migrateOnce
      const guardedModel: UrlCollectionModel = {
        ...model,
        insertOne: (data) =>
          ready ? model.insertOne(data) : ensureIndexes().andThen(() => model.insertOne(data)),
      }
      return { model: guardedModel, ensureIndexes }
    })
    .singleton(
      'urlCollection',
      ['urlIndexProvisioner'],
      ({ urlIndexProvisioner }) => urlIndexProvisioner.model,
    )
    .singleton(
      'mongoPaprProvisioningService',
      ['mongoDatabase', 'urlIndexProvisioner'],
      ({ mongoDatabase, urlIndexProvisioner }): MongoPaprProvisioningService => {
        const checkReadiness = (): StrictResultTask<void> =>
          ResultTask.tryPromise({
            try: async () =>
              mongoDatabase.command(
                { ping: 1 },
                { signal: AbortSignal.timeout(options.startupTimeoutMs) },
              ),
            catch: (cause) => new Error('MongoDB startup check failed', { cause }),
          }).asVoid()
        const ensureIndexes = (): StrictResultTask<void> => urlIndexProvisioner.ensureIndexes()
        return {
          checkReadiness,
          ensureIndexes,
          provision: () => checkReadiness().andThen(ensureIndexes),
        }
      },
    )
