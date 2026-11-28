import type { PaprFilter } from 'papr'

import { Effect, Layer } from 'effect'

import { DatabaseError } from '../../domain/errors/url.errors.js'
import { UrlRepository, type UrlRepositoryService } from '../../domain/repository/url.repository.js'
import { type UrlCollection, UrlCollectionService } from '../papr/url.schema.js'

const buildActiveUrlFilter = (identifier: string): PaprFilter<UrlCollection[0]> => ({
  isActive: true,
  shortCode: identifier,
})

const activeAndUnexpiredFilter = (): PaprFilter<UrlCollection[0]> => ({
  isActive: true,
  $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
})

export const UrlRepositoryLive = Layer.effect(
  UrlRepository,
  Effect.gen(function* () {
    const collection = yield* UrlCollectionService

    return {
      create: (url) =>
        Effect.tryPromise({
          try: async () => collection.insertOne(url),
          catch: (error) => DatabaseError.create(error),
        }),

      findActiveByIdentifier: (identifier) =>
        Effect.tryPromise({
          try: async () =>
            (await collection.findOne(buildActiveUrlFilter(identifier))) ?? undefined,
          catch: (error) => DatabaseError.query(error),
        }),

      findRecent: (limit) =>
        Effect.tryPromise({
          try: async () =>
            collection.find(activeAndUnexpiredFilter(), { sort: { createdAt: -1 }, limit }),
          catch: (error) => DatabaseError.query(error),
        }),

      findPopular: (limit) =>
        Effect.tryPromise({
          try: async () =>
            collection.find(
              { ...activeAndUnexpiredFilter(), accessCount: { $gt: 0 } },
              { sort: { accessCount: -1, lastAccessedAt: -1 }, limit },
            ),
          catch: (error) => DatabaseError.query(error),
        }),

      markInactive: (id, deletedAt) =>
        Effect.tryPromise({
          try: async () => {
            await collection.updateOne({ _id: id }, { $set: { isActive: false, deletedAt } })
          },
          catch: (error) => DatabaseError.update(error),
        }),

      recordAccess: (id, accessedAt) =>
        Effect.tryPromise({
          try: async () => {
            await collection.updateOne(
              { _id: id },
              { $inc: { accessCount: 1 }, $set: { lastAccessedAt: accessedAt } },
            )
          },
          catch: (error) => DatabaseError.update(error),
        }),
    } satisfies UrlRepositoryService
  }),
)
