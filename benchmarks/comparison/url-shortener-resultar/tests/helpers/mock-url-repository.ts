import { ObjectId } from 'mongodb'
import { ResultTask } from 'resultar'

import type { Url } from '../../src/domain/model/url.model.js'
import type { UrlCreate, UrlRepository } from '../../src/domain/repository/url.repository.js'

import { DatabaseError } from '../../src/domain/errors/url.errors.js'

const findActiveByIdentifier = (store: Map<string, Url>, identifier: string) => {
  const now = new Date()

  for (const document of store.values()) {
    if (
      document.isActive &&
      (document.expiresAt === undefined || document.expiresAt > now) &&
      document.shortCode === identifier
    ) {
      return document
    }
  }
  return undefined
}

const byCreatedAtDesc = (left: Url, right: Url) =>
  right.createdAt.getTime() - left.createdAt.getTime()

const byPopularityDesc = (left: Url, right: Url) => {
  if (left.accessCount !== right.accessCount) {
    return right.accessCount - left.accessCount
  }

  return (right.lastAccessedAt?.getTime() ?? 0) - (left.lastAccessedAt?.getTime() ?? 0)
}

export const createMockUrlRepository = (): UrlRepository => {
  const store = new Map<string, Url>()
  const isVisibleInStats = (document: Url) =>
    document.isActive && (document.expiresAt === undefined || document.expiresAt > new Date())

  return {
    findActiveByIdentifier: (identifier) =>
      ResultTask.ok<Url | undefined, DatabaseError>(findActiveByIdentifier(store, identifier)),

    findPopular: (limit) =>
      ResultTask.ok<Url[], DatabaseError>(
        [...store.values()]
          .filter((document) => isVisibleInStats(document) && document.accessCount > 0)
          .sort(byPopularityDesc)
          .slice(0, limit),
      ),

    findRecent: (limit) =>
      ResultTask.ok<Url[], DatabaseError>(
        [...store.values()].filter(isVisibleInStats).sort(byCreatedAtDesc).slice(0, limit),
      ),

    insert: (data: UrlCreate) => {
      const hasActiveIdentifier = [...store.values()].some(
        (document) => document.isActive && document.shortCode === data.shortCode,
      )
      if (hasActiveIdentifier) {
        return ResultTask.err<Url, DatabaseError>(DatabaseError.constraint('Duplicate entry'))
      }

      const id = new ObjectId().toString()
      const now = new Date()
      const document: Url = {
        id,
        shortCode: data.shortCode,
        originalUrl: data.originalUrl,
        customAlias: data.customAlias,
        accessCount: data.accessCount,
        expiresAt: data.expiresAt,
        isActive: data.isActive,
        createdAt: now,
        updatedAt: now,
      }
      store.set(id, document)
      return ResultTask.ok<Url, DatabaseError>(document)
    },

    markInactive: (id, deletedAt) => {
      const document = store.get(id)
      if (document) {
        document.isActive = false
        document.deletedAt = deletedAt
        document.updatedAt = deletedAt
        store.set(id, document)
      }
      return ResultTask.ok<undefined, DatabaseError>(undefined)
    },

    recordAccess: (id, accessedAt) => {
      const document = store.get(id)
      if (document) {
        document.accessCount += 1
        if (document.lastAccessedAt === undefined || accessedAt > document.lastAccessedAt) {
          document.lastAccessedAt = accessedAt
        }
        document.updatedAt = accessedAt
        store.set(id, document)
      }
      return ResultTask.ok<undefined, DatabaseError>(undefined)
    },
  }
}
