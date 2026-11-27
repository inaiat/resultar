import {
  PaprOperationError,
  type UrlDocument,
  type UrlCollectionModel,
} from '../src/infrastructure/papr/url.schema.js'
import { ObjectId } from 'mongodb'
import { ResultTask } from 'resultar'
import { describe, expect, it, vi } from 'vite-plus/test'

import { DatabaseError } from '../src/domain/errors/url.errors.js'
import { PaprUrlRepository } from '../src/infrastructure/repository/url.repository.js'

type UrlCollectionDocument = UrlDocument

const createCollection = (operations: object): UrlCollectionModel =>
  operations as unknown as UrlCollectionModel

const paprMiss: null = JSON.parse('null')

const createDocument = (overrides: Partial<UrlCollectionDocument> = {}): UrlCollectionDocument => ({
  _id: new ObjectId(),
  shortCode: 'flash',
  originalUrl: 'https://flashapp.com.br',
  accessCount: 0,
  isActive: true,
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  updatedAt: new Date('2025-01-01T00:00:00.000Z'),
  ...overrides,
})

describe('Resultar-native URL repository', () => {
  it('maps active URL hits and misses without exposing Papr promises', async () => {
    const id = new ObjectId()
    const document = createDocument({ _id: id })
    const findOne = vi
      .fn()
      .mockReturnValueOnce(ResultTask.ok(document))
      .mockReturnValueOnce(ResultTask.ok(paprMiss))
    const repository = await ResultTask.runPromise(
      PaprUrlRepository.make.provideServices({ urlCollection: createCollection({ findOne }) }),
    )

    const hit = await repository.findActiveByIdentifier('flash').runResult()
    const miss = await repository.findActiveByIdentifier('missing').runResult()

    expect(hit.isOk() && hit.value).toMatchObject({
      id: id.toHexString(),
      shortCode: 'flash',
      originalUrl: 'https://flashapp.com.br',
    })
    expect(miss.isOk() && miss.value).toBeUndefined()
    expect(findOne).toHaveBeenNthCalledWith(1, { isActive: true, shortCode: 'flash' })
    expect(findOne).toHaveBeenNthCalledWith(2, { isActive: true, shortCode: 'missing' })
  })

  it('excludes expired URLs from recent and popular queries', async () => {
    const document = createDocument({ accessCount: 4 })
    const find = vi.fn(() => ResultTask.ok([document]))
    const repository = await ResultTask.runPromise(
      PaprUrlRepository.make.provideServices({ urlCollection: createCollection({ find }) }),
    )

    const recent = await repository.findRecent(5).runResult()
    const popular = await repository.findPopular(3).runResult()

    expect(recent.isOk() && recent.value).toHaveLength(1)
    expect(popular.isOk() && popular.value).toHaveLength(1)
    const unexpiredFilter = {
      isActive: true,
      $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: expect.any(Date) } }],
    }
    expect(find).toHaveBeenNthCalledWith(1, unexpiredFilter, { sort: { createdAt: -1 }, limit: 5 })
    expect(find).toHaveBeenNthCalledWith(
      2,
      { ...unexpiredFilter, accessCount: { $gt: 0 } },
      { sort: { accessCount: -1, lastAccessedAt: -1 }, limit: 3 },
    )
  })

  it('maps insert success and package-classified failures', async () => {
    const id = new ObjectId()
    const document = createDocument({ _id: id })
    const duplicateCause = Object.assign(new Error('duplicate key'), { code: 11_000 })
    const duplicateError = new PaprOperationError({
      cause: duplicateCause,
      collectionName: 'urls',
      operation: 'insertOne',
    })
    const duplicateCodeNameError = new PaprOperationError({
      cause: { codeName: 'DuplicateKey' },
      collectionName: 'urls',
      operation: 'insertOne',
    })
    const writeError = new PaprOperationError({
      cause: new Error('write unavailable'),
      collectionName: 'urls',
      operation: 'insertOne',
    })
    const insertOne = vi
      .fn()
      .mockReturnValueOnce(ResultTask.ok(document))
      .mockReturnValueOnce(ResultTask.err(duplicateError))
      .mockReturnValueOnce(ResultTask.err(duplicateCodeNameError))
      .mockReturnValueOnce(ResultTask.err(writeError))
    const repository = await ResultTask.runPromise(
      PaprUrlRepository.make.provideServices({ urlCollection: createCollection({ insertOne }) }),
    )
    const input = {
      shortCode: 'flash',
      originalUrl: 'https://flashapp.com.br',
      accessCount: 0,
      isActive: true,
    }

    const inserted = await repository.insert(input).runResult()
    const duplicate = await repository.insert(input).runResult()
    const duplicateByName = await repository.insert(input).runResult()
    const failed = await repository.insert(input).runResult()

    expect(inserted.isOk() && inserted.value.id).toBe(id.toHexString())
    expect(duplicate.isErr() && DatabaseError.isConstraint(duplicate.error)).toBe(true)
    expect(duplicate.isErr() && duplicate.error.cause).toBe(duplicateError)
    expect(duplicateByName.isErr() && DatabaseError.isConstraint(duplicateByName.error)).toBe(true)
    expect(duplicateByName.isErr() && duplicateByName.error.cause).toBe(duplicateCodeNameError)
    expect(failed.isErr() && failed.error.operation).toBe('insert')
    expect(failed.isErr() && failed.error.cause).toBe(writeError)
  })

  it('returns DatabaseError when persisted data has no identifier or query fails', async () => {
    const paprQueryError = new PaprOperationError({
      cause: new Error('read failed'),
      collectionName: 'urls',
      operation: 'findOne',
    })
    const findOne = vi
      .fn()
      .mockReturnValueOnce(ResultTask.ok(createDocument({ _id: undefined })))
      .mockReturnValueOnce(ResultTask.err(paprQueryError))
    const find = vi.fn(() => ResultTask.ok([createDocument({ _id: undefined })]))
    const insertOne = vi.fn(() => ResultTask.ok(createDocument({ _id: undefined })))
    const repository = await ResultTask.runPromise(
      PaprUrlRepository.make.provideServices({
        urlCollection: createCollection({ find, findOne, insertOne }),
      }),
    )

    const invalidFind = await repository.findActiveByIdentifier('flash').runResult()
    const failedFind = await repository.findActiveByIdentifier('flash').runResult()
    const invalidList = await repository.findRecent(5).runResult()
    const invalidInsert = await repository
      .insert({
        shortCode: 'flash',
        originalUrl: 'https://flashapp.com.br',
        accessCount: 0,
        isActive: true,
      })
      .runResult()

    expect(invalidFind.isErr() && invalidFind.error.operation).toBe('query')
    expect(failedFind.isErr() && failedFind.error.cause).toBe(paprQueryError)
    expect(invalidList.isErr() && invalidList.error.operation).toBe('query')
    expect(invalidInsert.isErr() && invalidInsert.error.operation).toBe('insert')
  })

  it('updates valid identifiers through the Resultar collection model', async () => {
    const id = new ObjectId()
    const deletedAt = new Date('2025-01-02T00:00:00.000Z')
    const accessedAt = new Date('2025-01-03T00:00:00.000Z')
    const updateOne = vi.fn(() => ResultTask.ok({ acknowledged: true }))
    const repository = await ResultTask.runPromise(
      PaprUrlRepository.make.provideServices({ urlCollection: createCollection({ updateOne }) }),
    )

    const inactive = await repository.markInactive(id.toHexString(), deletedAt).runResult()
    const accessed = await repository.recordAccess(id.toHexString(), accessedAt).runResult()

    expect(inactive.isOk()).toBe(true)
    expect(accessed.isOk()).toBe(true)
    expect(updateOne).toHaveBeenNthCalledWith(
      1,
      { _id: id },
      { $set: { isActive: false, deletedAt } },
    )
    expect(updateOne).toHaveBeenNthCalledWith(
      2,
      { _id: id },
      { $inc: { accessCount: 1 }, $max: { lastAccessedAt: accessedAt } },
    )
  })

  it.each(['markInactive', 'recordAccess'] as const)(
    'returns DatabaseError instead of throwing for malformed IDs in %s',
    async (operation) => {
      const updateOne = vi.fn()
      const repository = await ResultTask.runPromise(
        PaprUrlRepository.make.provideServices({ urlCollection: createCollection({ updateOne }) }),
      )
      const timestamp = new Date()

      const result = await repository[operation]('not-an-object-id', timestamp).runResult()

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(DatabaseError)
        expect(result.error.operation).toBe('update')
      }
      expect(updateOne).not.toHaveBeenCalled()
    },
  )

  it('maps Papr update failures to DatabaseError', async () => {
    const paprError = new PaprOperationError({
      cause: new Error('write failed'),
      collectionName: 'urls',
      operation: 'updateOne',
    })
    const updateOne = vi.fn(() => ResultTask.err(paprError))
    const repository = await ResultTask.runPromise(
      PaprUrlRepository.make.provideServices({ urlCollection: createCollection({ updateOne }) }),
    )

    const result = await repository
      .recordAccess(new ObjectId().toHexString(), new Date())
      .runResult()

    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.operation).toBe('update')
      expect(result.error.cause).toBe(paprError)
    }
  })
})
