import type { StrictResultTask } from 'resultar'

import type { DatabaseError } from '../errors/url.errors.js'
import type { Url } from '../model/url.model.js'

export type UrlCreate = {
  readonly shortCode: string
  readonly originalUrl: string
  readonly customAlias?: string
  readonly accessCount: number
  readonly expiresAt?: Date
  readonly isActive: boolean
}

export type UrlRepositoryResult<T> = StrictResultTask<T, DatabaseError>

export type UrlAccessRecorder = {
  readonly recordAccess: (id: string, accessedAt: Date) => StrictResultTask<void>
}

export type UrlRepository = {
  readonly findActiveByIdentifier: (identifier: string) => UrlRepositoryResult<Url | undefined>
  readonly findPopular: (limit: number) => UrlRepositoryResult<Url[]>
  readonly findRecent: (limit: number) => UrlRepositoryResult<Url[]>
  readonly insert: (data: UrlCreate) => UrlRepositoryResult<Url>
  readonly markInactive: (id: string, deletedAt: Date) => UrlRepositoryResult<void>
  readonly recordAccess: (id: string, accessedAt: Date) => UrlRepositoryResult<void>
}
