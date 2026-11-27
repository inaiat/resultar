import type { PaprFilter } from 'papr'

import {
  isPaprUniqueViolation,
  urlCollection,
  type UrlDocument,
  type PaprOperationError,
} from '../papr/url.schema.js'
import { service } from 'resultar-di'
import { ObjectId } from 'mongodb'
import { ResultTask, err, ok, tryResult, type StrictResult } from 'resultar'

import type { Url } from '../../domain/model/url.model.js'
import type {
  UrlRepository,
  UrlRepositoryResult,
  UrlCreate,
} from '../../domain/repository/url.repository.js'

import { DatabaseError } from '../../domain/errors/url.errors.js'

type UrlCollectionDocument = UrlDocument
type ValidUrlCollectionDocument = UrlCollectionDocument & {
  _id: ObjectId
  createdAt: Date
  updatedAt: Date
}

type DatabaseErrorFactory = (error: unknown) => DatabaseError

const isValidDate = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime())

const isValidPersistedUrlDocument = (
  document: UrlCollectionDocument,
): document is ValidUrlCollectionDocument =>
  document._id !== undefined && isValidDate(document.createdAt) && isValidDate(document.updatedAt)

const toDomain = (document: ValidUrlCollectionDocument): Url => ({
  id: document._id.toHexString(),
  shortCode: document.shortCode,
  originalUrl: document.originalUrl,
  customAlias: document.customAlias,
  accessCount: document.accessCount,
  lastAccessedAt: document.lastAccessedAt,
  expiresAt: document.expiresAt,
  isActive: document.isActive,
  deletedAt: document.deletedAt,
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
})

const invalidPersistedUrlError = (onError: DatabaseErrorFactory): DatabaseError =>
  onError(new TypeError('Persisted URL has an invalid identifier or timestamps'))

const toDomainResult = (
  document: UrlCollectionDocument,
  onError: DatabaseErrorFactory,
): StrictResult<Url, DatabaseError> =>
  isValidPersistedUrlDocument(document)
    ? ok(toDomain(document))
    : err(invalidPersistedUrlError(onError))

const toDomainQueryError = (error: unknown) => DatabaseError.query(error)
const toDomainInsertError = (error: unknown) => DatabaseError.insert(error)

const toDomainQueryResult = (
  document: UrlCollectionDocument | null,
): StrictResult<Url | undefined, DatabaseError> =>
  document === null ? ok(undefined) : toDomainResult(document, toDomainQueryError)

const toDomainInsertResult = (document: UrlCollectionDocument): StrictResult<Url, DatabaseError> =>
  toDomainResult(document, toDomainInsertError)

const toDomainListResult = (
  documents: UrlCollectionDocument[],
): StrictResult<Url[], DatabaseError> => {
  const list: Url[] = []
  for (const document of documents) {
    if (!isValidPersistedUrlDocument(document)) {
      return err(invalidPersistedUrlError(toDomainQueryError))
    }
    list.push(toDomain(document))
  }
  return ok(list)
}

const urlIdFilter = (id: string): StrictResult<PaprFilter<UrlCollectionDocument>, DatabaseError> =>
  tryResult(
    () => ({ _id: new ObjectId(id) }),
    (error) => DatabaseError.update(error),
  )

const toQueryError = (error: PaprOperationError) => DatabaseError.query(error)
const toInsertError = (error: PaprOperationError) =>
  isPaprUniqueViolation(error)
    ? DatabaseError.constraint('Duplicate entry', error)
    : DatabaseError.insert(error)
const toUpdateError = (error: PaprOperationError) => DatabaseError.update(error)

const activeAndUnexpiredFilter = (): PaprFilter<UrlCollectionDocument> => ({
  isActive: true,
  $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
})

export const PaprUrlRepository = service<UrlRepository>()('urlRepository', {
  requires: { collection: urlCollection.service },
  make: ({ collection }) => ({
    findActiveByIdentifier(identifier: string): UrlRepositoryResult<Url | undefined> {
      return collection
        .findOne({ isActive: true, shortCode: identifier })
        .mapErr(toQueryError)
        .andThen(toDomainQueryResult)
    },

    findPopular(limit: number): UrlRepositoryResult<Url[]> {
      return collection
        .find(
          { ...activeAndUnexpiredFilter(), accessCount: { $gt: 0 } },
          { sort: { accessCount: -1, lastAccessedAt: -1 }, limit },
        )
        .mapErr(toQueryError)
        .andThen(toDomainListResult)
    },

    findRecent(limit: number): UrlRepositoryResult<Url[]> {
      return collection
        .find(activeAndUnexpiredFilter(), { sort: { createdAt: -1 }, limit })
        .mapErr(toQueryError)
        .andThen(toDomainListResult)
    },

    insert(data: UrlCreate): UrlRepositoryResult<Url> {
      return collection.insertOne(data).mapErr(toInsertError).andThen(toDomainInsertResult)
    },

    markInactive(id: string, deletedAt: Date): UrlRepositoryResult<void> {
      const filter = urlIdFilter(id)
      if (filter.isErr()) {
        return ResultTask.err(filter.error)
      }
      return collection
        .updateOne(filter.value, { $set: { isActive: false, deletedAt } })
        .mapErr(toUpdateError)
        .asVoid()
    },

    recordAccess(id: string, accessedAt: Date): UrlRepositoryResult<void> {
      const filter = urlIdFilter(id)
      if (filter.isErr()) {
        return ResultTask.err(filter.error)
      }
      return collection
        .updateOne(filter.value, { $inc: { accessCount: 1 }, $max: { lastAccessedAt: accessedAt } })
        .mapErr(toUpdateError)
        .asVoid()
    },
  }),
})
