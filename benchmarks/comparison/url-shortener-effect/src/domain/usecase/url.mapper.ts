import { Effect } from 'effect'

import type { CachedUrl, UrlDocument, UrlResponse } from '../model/url.model.js'

export const validateUrl = (url: string): Effect.Effect<URL, Error> =>
  Effect.try({ try: () => new URL(url), catch: () => new Error(`Invalid URL: ${url}`) })

const toBaseProjection = (doc: UrlDocument) => ({
  id: doc._id?.toString() ?? '',
  shortCode: doc.shortCode,
  originalUrl: doc.originalUrl,
  customAlias: doc.customAlias,
  createdAt: doc.createdAt?.toISOString() ?? new Date().toISOString(),
  lastAccessedAt: doc.lastAccessedAt?.toISOString(),
  accessCount: doc.accessCount,
  expiresAt: doc.expiresAt?.toISOString(),
  isActive: doc.isActive,
})

export const documentToResponse = (doc: UrlDocument): UrlResponse => {
  const { lastAccessedAt, expiresAt, ...base } = toBaseProjection(doc)

  const response: UrlResponse = base
  if (lastAccessedAt !== undefined) {
    response.lastAccessedAt = lastAccessedAt
  }
  if (expiresAt !== undefined) {
    response.expiresAt = expiresAt
  }

  return response
}

export const documentToCached = (doc: UrlDocument): CachedUrl => ({
  id: doc._id?.toString() ?? '',
  shortCode: doc.shortCode,
  originalUrl: doc.originalUrl,
  expiresAt: doc.expiresAt?.toISOString(),
})
