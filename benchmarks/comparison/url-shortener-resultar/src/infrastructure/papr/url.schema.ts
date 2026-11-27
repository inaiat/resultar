import type { FindOptions, IndexDescription } from 'mongodb'
import { ResultTask, createTaggedError } from 'resultar'
import { service } from 'resultar-di'
import {
  type default as Papr,
  type DocumentForInsert,
  type PaprFilter,
  type PaprUpdateFilter,
  schema,
  types,
} from 'papr'

const definition = {
  collectionName: 'urls',
  indexes: [
    { key: { shortCode: 1 }, unique: true, partialFilterExpression: { isActive: true } },
    {
      key: { customAlias: 1 },
      unique: true,
      partialFilterExpression: { isActive: true, customAlias: { $exists: true, $type: 'string' } },
    },
    { key: { isActive: 1 } },
    { key: { expiresAt: 1 } },
    { key: { createdAt: -1 } },
    {
      key: { accessCount: -1, lastAccessedAt: -1 },
      name: 'idx_active_urls_access_count_last_accessed_at',
      partialFilterExpression: { isActive: true },
    },
  ] as IndexDescription[],
  schema: schema(
    {
      shortCode: types.string({ required: true }),
      originalUrl: types.string({ required: true }),
      customAlias: types.string({ required: false }),
      accessCount: types.number({ required: true }),
      lastAccessedAt: types.date({ required: false }),
      expiresAt: types.date({ required: false }),
      isActive: types.boolean({ required: true }),
      deletedAt: types.date({ required: false }),
    },
    { timestamps: true },
  ),
}

export type UrlDocument = (typeof definition.schema)[0]
export class PaprOperationError extends createTaggedError({
  name: 'PaprOperationError',
  message: 'Papr $operation failed for $collectionName',
}).withProps<{ collectionName: string; operation: string }>() {}
export const isPaprUniqueViolation = (error: PaprOperationError) => {
  const { cause } = error
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (('code' in cause && cause.code === 11_000) ||
      ('codeName' in cause && cause.codeName === 'DuplicateKey'))
  )
}

const operation = <T>(name: string, run: () => Promise<T>) =>
  ResultTask.tryPromise({
    try: run,
    catch: (cause) => new PaprOperationError({ cause, collectionName: 'urls', operation: name }),
  })

const createModel = ({ papr }: { papr: Papr }) => {
  const model = papr.model('urls', definition.schema)
  return {
    collection: model.collection,
    findOne: (filter: PaprFilter<UrlDocument>) =>
      // oxlint-disable-next-line typescript/promise-function-async -- Return driver Promise directly to avoid extra microtask per query.
      operation('findOne', () => model.findOne(filter)),
    find: (filter: PaprFilter<UrlDocument>, options: Omit<FindOptions, 'projection'>) =>
      // oxlint-disable-next-line typescript/promise-function-async -- Return driver Promise directly to avoid extra microtask per query.
      operation('find', () => model.find(filter, options)),
    insertOne: (data: DocumentForInsert<UrlDocument, (typeof definition.schema)[1]>) =>
      // oxlint-disable-next-line typescript/promise-function-async -- Return driver Promise directly to avoid extra microtask per query.
      operation('insertOne', () => model.insertOne(data)),
    updateOne: (filter: PaprFilter<UrlDocument>, update: PaprUpdateFilter<UrlDocument>) =>
      // oxlint-disable-next-line typescript/promise-function-async -- Return driver Promise directly to avoid extra microtask per query.
      operation('updateOne', () => model.updateOne(filter, update)),
  }
}
export type UrlCollectionModel = ReturnType<typeof createModel>
export const urlCollection = {
  ...definition,
  createModel,
  service: service.require<UrlCollectionModel>()('urlCollection'),
  migrate: (papr: Papr, model: UrlCollectionModel) =>
    operation('provision', async () => {
      await papr.updateSchemas()
      await model.collection.createIndexes(definition.indexes)
    }),
}
