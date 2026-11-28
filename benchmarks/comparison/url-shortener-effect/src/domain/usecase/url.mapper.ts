import { Effect } from 'effect'

import type { CachedUrl, UrlDocument, UrlResponse } from '../model/url.model.js'

import { InvalidCustomAliasError, InvalidUrlError } from '../errors/url.errors.js'

const supportedProtocols = new Set(['http:', 'https:'])
const customAliasPattern = /^[\w-]{1,50}$/u
const reservedAliases = new Set(['stats'])

export const validateUrl = (url: string): Effect.Effect<URL, InvalidUrlError> =>
  Effect.suspend(() => {
    try {
      const parsedUrl = new URL(url)
      if (!supportedProtocols.has(parsedUrl.protocol)) {
        return Effect.fail(new InvalidUrlError({ url }))
      }
      return Effect.succeed(parsedUrl)
    } catch {
      return Effect.fail(new InvalidUrlError({ url }))
    }
  })

export const validateCustomAlias = (
  alias: string | undefined,
): Effect.Effect<void, InvalidCustomAliasError> =>
  Effect.suspend(() => {
    if (alias === undefined) {
      return Effect.void
    }

    if (!customAliasPattern.test(alias) || reservedAliases.has(alias.toLowerCase())) {
      return Effect.fail(new InvalidCustomAliasError({ alias }))
    }

    return Effect.void
  })

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
