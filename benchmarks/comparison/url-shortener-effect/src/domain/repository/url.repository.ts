import type { Effect } from 'effect/Effect'
import type { ObjectId } from 'mongodb'

import { Context } from 'effect'

import type { DatabaseError } from '../errors/url.errors.js'
import type { UrlDocument } from '../model/url.model.js'

type UrlCreate = Readonly<Omit<UrlDocument, '_id' | 'createdAt' | 'updatedAt'>>

export interface UrlRepositoryService {
  readonly create: (url: UrlCreate) => Effect<UrlDocument, DatabaseError>
  readonly findActiveByIdentifier: (
    identifier: string,
  ) => Effect<UrlDocument | undefined, DatabaseError>
  readonly findRecent: (limit: number) => Effect<UrlDocument[], DatabaseError>
  readonly findPopular: (limit: number) => Effect<UrlDocument[], DatabaseError>
  readonly markInactive: (id: ObjectId, deletedAt: Date) => Effect<void, DatabaseError>
  readonly recordAccess: (id: ObjectId, accessedAt: Date) => Effect<void, DatabaseError>
}

export class UrlRepository extends Context.Service<UrlRepository, UrlRepositoryService>()(
  'UrlRepository',
) {}
