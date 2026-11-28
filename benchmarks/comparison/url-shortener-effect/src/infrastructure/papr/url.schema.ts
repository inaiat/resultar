import { Context, Effect, Layer } from 'effect'

import { schema, types } from 'papr'
import { PaprInstance } from './papr-instance.js'

const urlCollection = schema(
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
)

export type UrlCollection = typeof urlCollection

export class UrlCollectionService extends Context.Service<UrlCollectionService>()('UrlCollection', {
  make: Effect.gen(function* () {
    const papr = yield* PaprInstance
    const model = papr.model('urls', urlCollection)

    yield* Effect.tryPromise({
      try: async () => {
        await papr.updateSchemas()
        await model.collection.createIndexes([
          { key: { shortCode: 1 }, unique: true, partialFilterExpression: { isActive: true } },
          {
            key: { customAlias: 1 },
            unique: true,
            partialFilterExpression: {
              isActive: true,
              customAlias: { $exists: true, $type: 'string' },
            },
          },
          { key: { isActive: 1 } },
          { key: { expiresAt: 1 } },
          { key: { createdAt: -1 } },
          {
            key: { accessCount: -1, lastAccessedAt: -1 },
            name: 'idx_active_urls_access_count_last_accessed_at',
            partialFilterExpression: { isActive: true },
          },
        ])
      },
      catch: (error) =>
        new Error(
          `Failed to provision the URL collection: ${error instanceof Error ? error.message : String(error)}`,
        ),
    })

    return model
  }),
}) {
  static readonly Default = Layer.effect(this, this.make)
}
