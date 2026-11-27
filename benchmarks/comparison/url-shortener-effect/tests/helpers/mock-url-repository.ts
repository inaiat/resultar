import { Effect, Layer } from 'effect'
import { ObjectId } from 'mongodb'

import type { UrlDocument } from '../../src/domain/model/url.model.js'

import { DatabaseError } from '../../src/domain/errors/url.errors.js'
import {
  UrlRepository,
  type UrlRepositoryService,
} from '../../src/domain/repository/url.repository.js'

const activeUrls = (store: Map<string, UrlDocument>) => {
  const now = Date.now()
  return [...store.values()].filter(
    (doc) => doc.isActive && (doc.expiresAt === undefined || doc.expiresAt.getTime() > now),
  )
}

export const createMockUrlRepository = (): UrlRepositoryService => {
  const store = new Map<string, UrlDocument>()

  return {
    findActiveByIdentifier: (identifier) =>
      Effect.sync(() => store.values().find((doc) => doc.isActive && doc.shortCode === identifier)),

    findRecent: (limit: number) =>
      Effect.sync(() =>
        activeUrls(store)
          .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
          .slice(0, limit),
      ),

    findPopular: (limit: number) =>
      Effect.sync(() =>
        activeUrls(store)
          .filter((doc) => doc.accessCount > 0)
          .sort(
            (a, b) =>
              b.accessCount - a.accessCount ||
              (b.lastAccessedAt?.getTime() ?? 0) - (a.lastAccessedAt?.getTime() ?? 0),
          )
          .slice(0, limit),
      ),

    create: (data) =>
      Effect.suspend(() => {
        const hasActiveIdentifier = [...store.values()].some(
          (doc) => doc.isActive && doc.shortCode === data.shortCode,
        )
        if (hasActiveIdentifier) {
          return Effect.fail(DatabaseError.constraint('Duplicate entry'))
        }

        const id = new ObjectId()
        const now = new Date()
        const doc: UrlDocument = { ...data, _id: id, createdAt: now, updatedAt: now }
        store.set(id.toString(), doc)
        return Effect.succeed(doc)
      }),

    markInactive: (id, deletedAt) =>
      Effect.sync(() => {
        const doc = store.get(id.toString())
        if (doc !== undefined) {
          doc.isActive = false
          doc.deletedAt = deletedAt
          doc.updatedAt = new Date()
        }
      }),

    recordAccess: (id, accessedAt) =>
      Effect.sync(() => {
        const doc = store.get(id.toString())
        if (doc !== undefined) {
          doc.accessCount += 1
          doc.lastAccessedAt = accessedAt
          doc.updatedAt = new Date()
        }
      }),
  }
}

export const MockUrlRepository = Layer.effect(UrlRepository, Effect.sync(createMockUrlRepository))
