import type { HttpErrorStatusByTag } from 'resultar-request'
import { type Static, Type } from 'typebox'

import type { UrlError } from '../../domain/errors/url.errors.js'
import type { CreateUrlInput, Url } from '../../domain/model/url.model.js'
import { formatIsoDate } from '../../domain/usecase/url.mapper.js'

export const urlErrorStatusByTag = {
  CustomAliasExistsError: 409,
  DatabaseError: 500,
  InvalidCustomAliasError: 400,
  InvalidUrlError: 400,
  UrlCreationError: 500,
  UrlExpiredError: 410,
  UrlNotFoundError: 404,
} satisfies HttpErrorStatusByTag<UrlError>

export const CreateUrlRequest = Type.Object({
  originalUrl: Type.String({ minLength: 1 }),
  customAlias: Type.Optional(
    Type.String({ minLength: 1, maxLength: 50, pattern: '^[a-zA-Z0-9-_]+$' }),
  ),
  expiresAt: Type.Optional(Type.String({ format: 'date-time' })),
})

const urlProjectionFields = {
  id: Type.String(),
  shortCode: Type.String(),
  originalUrl: Type.String(),
  customAlias: Type.Optional(Type.String()),
  createdAt: Type.String({ format: 'date-time' }),
  accessCount: Type.Number({ minimum: 0 }),
  isActive: Type.Boolean(),
}

export const UrlResponse = Type.Object({
  ...urlProjectionFields,
  lastAccessedAt: Type.Optional(Type.String({ format: 'date-time' })),
  expiresAt: Type.Optional(Type.String({ format: 'date-time' })),
})

export const CreateUrlResponse = Type.Object({ success: Type.Literal(true), data: UrlResponse })

export const DeleteUrlResponse = Type.Object({
  success: Type.Literal(true),
  message: Type.String(),
})

export const UrlStatsResponse = Type.Object({
  success: Type.Literal(true),
  data: Type.Array(UrlResponse),
})

export type CreateUrlRequest = Static<typeof CreateUrlRequest>
type UrlResponse = Static<typeof UrlResponse>

export const requestToCreateUrlInput = ({
  expiresAt,
  ...request
}: CreateUrlRequest): CreateUrlInput => ({
  ...request,
  expiresAt: expiresAt === undefined ? undefined : new Date(expiresAt),
})

export const urlToResponse = (url: Url): UrlResponse => ({
  id: url.id,
  shortCode: url.shortCode,
  originalUrl: url.originalUrl,
  customAlias: url.customAlias,
  createdAt: formatIsoDate(url.createdAt),
  accessCount: url.accessCount,
  isActive: url.isActive,
  lastAccessedAt: url.lastAccessedAt === undefined ? undefined : formatIsoDate(url.lastAccessedAt),
  expiresAt: url.expiresAt === undefined ? undefined : formatIsoDate(url.expiresAt),
})

export const urlsToResponses = (urls: readonly Url[]): UrlResponse[] => {
  const responses: UrlResponse[] = []
  for (const url of urls) {
    responses.push(urlToResponse(url))
  }
  return responses
}
