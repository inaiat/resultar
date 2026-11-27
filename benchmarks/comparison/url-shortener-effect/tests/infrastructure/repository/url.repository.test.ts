import { Effect, Layer } from 'effect'
import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vite-plus/test'

import { UrlRepository } from '../../../src/domain/repository/url.repository.js'
import { UrlCollectionService } from '../../../src/infrastructure/papr/url.schema.js'
import { UrlRepositoryLive } from '../../../src/infrastructure/repository/url.repository.js'

const url = { shortCode: 'abc', originalUrl: 'http://a.com', accessCount: 0, isActive: true }

describe('UrlRepository', () => {
  const mockPaprModel = { insertOne: vi.fn(), findOne: vi.fn(), updateOne: vi.fn() }

  const PaprModelLayer = Layer.succeed(
    UrlCollectionService,
    mockPaprModel as unknown as typeof UrlCollectionService.Service,
  )

  it('create works', async () => {
    mockPaprModel.insertOne.mockResolvedValueOnce({ _id: '1', shortCode: 'abc' })

    const program = Effect.gen(function* () {
      const repo = yield* UrlRepository
      const result = yield* repo.create(url)
      expect(result._id).toBeDefined()
    })

    await Effect.runPromise(
      program.pipe(Effect.provide(UrlRepositoryLive), Effect.provide(PaprModelLayer)),
    )
  })

  it('create fails on duplicate key', async () => {
    const error = Object.assign(new Error('duplicate'), { code: 11_000 })
    mockPaprModel.insertOne.mockRejectedValueOnce(error)

    const program = Effect.gen(function* () {
      const repo = yield* UrlRepository
      yield* repo.create(url)
    })

    const result = await Effect.runPromiseExit(
      program.pipe(Effect.provide(UrlRepositoryLive), Effect.provide(PaprModelLayer)),
    )
    expect(result._tag).toBe('Failure')
  })

  it('findActiveByIdentifier works', async () => {
    mockPaprModel.findOne.mockResolvedValueOnce({ _id: '1', shortCode: 'abc' })

    const program = Effect.gen(function* () {
      const repo = yield* UrlRepository
      const result = yield* repo.findActiveByIdentifier('abc')
      expect(result).toBeDefined()
    })

    await Effect.runPromise(
      program.pipe(Effect.provide(UrlRepositoryLive), Effect.provide(PaprModelLayer)),
    )
  })

  it('findActiveByIdentifier fails with DatabaseError', async () => {
    mockPaprModel.findOne.mockRejectedValueOnce(new Error('db error'))

    const program = Effect.gen(function* () {
      const repo = yield* UrlRepository
      yield* repo.findActiveByIdentifier('abc')
    })

    const result = await Effect.runPromiseExit(
      program.pipe(Effect.provide(UrlRepositoryLive), Effect.provide(PaprModelLayer)),
    )
    expect(result._tag).toBe('Failure')
  })

  it('marks a URL inactive', async () => {
    const id = new ObjectId()
    const deletedAt = new Date()
    mockPaprModel.updateOne.mockResolvedValueOnce({ _id: id })

    const program = Effect.gen(function* () {
      const repo = yield* UrlRepository
      yield* repo.markInactive(id, deletedAt)
    })

    await Effect.runPromise(
      program.pipe(Effect.provide(UrlRepositoryLive), Effect.provide(PaprModelLayer)),
    )
    expect(mockPaprModel.updateOne).toHaveBeenLastCalledWith(
      { _id: id },
      { $set: { isActive: false, deletedAt } },
    )
  })

  it('increments access count and sets last accessed time in one update', async () => {
    const id = new ObjectId()
    const accessedAt = new Date()
    mockPaprModel.updateOne.mockResolvedValueOnce({ _id: id })

    const program = Effect.gen(function* () {
      const repo = yield* UrlRepository
      yield* repo.recordAccess(id, accessedAt)
    })

    await Effect.runPromise(
      program.pipe(Effect.provide(UrlRepositoryLive), Effect.provide(PaprModelLayer)),
    )
    expect(mockPaprModel.updateOne).toHaveBeenLastCalledWith(
      { _id: id },
      { $inc: { accessCount: 1 }, $set: { lastAccessedAt: accessedAt } },
    )
  })
})
