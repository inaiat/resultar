import { Effect, Layer } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'

import { MongoDatabaseService } from '../../../src/infrastructure/database/mongo-database.js'
import { PaprInstance } from '../../../src/infrastructure/papr/papr-instance.js'
import { UrlCollectionService } from '../../../src/infrastructure/papr/url.schema.js'

describe('Papr', () => {
  it('PaprInstance works', async () => {
    const MongoLayer = Layer.succeed(
      MongoDatabaseService,
      {} as typeof MongoDatabaseService.Service,
    )

    const program = Effect.gen(function* () {
      const papr = yield* PaprInstance
      expect(papr).toBeDefined()
    })

    await Effect.runPromise(
      program.pipe(Effect.provide(PaprInstance.Default), Effect.provide(MongoLayer)),
    )
  })

  it('UrlCollectionService works', async () => {
    const mockPapr = {
      updateSchemas: vi.fn().mockResolvedValue(undefined),
      model: vi
        .fn()
        .mockReturnValue({ collection: { createIndexes: vi.fn().mockResolvedValue(true) } }),
    }
    const PaprLayer = Layer.succeed(
      PaprInstance,
      mockPapr as unknown as typeof PaprInstance.Service,
    )

    const program = Effect.gen(function* () {
      const model = yield* UrlCollectionService
      expect(model).toBeDefined()
    })

    await Effect.runPromise(
      program.pipe(Effect.provide(UrlCollectionService.Default), Effect.provide(PaprLayer)),
    )
  })

  it('UrlCollectionService handles index creation error', async () => {
    const mockPapr = {
      updateSchemas: vi.fn().mockResolvedValue(undefined),
      model: vi
        .fn()
        .mockReturnValue({
          collection: { createIndexes: vi.fn().mockRejectedValue(new Error('index fail')) },
        }),
    }
    const PaprLayer = Layer.succeed(
      PaprInstance,
      mockPapr as unknown as typeof PaprInstance.Service,
    )

    const program = Effect.gen(function* () {
      const model = yield* UrlCollectionService
      expect(model).toBeDefined()
    })

    const result = await Effect.runPromiseExit(
      program.pipe(Effect.provide(UrlCollectionService.Default), Effect.provide(PaprLayer)),
    )
    expect(result._tag).toBe('Failure')
  })
})
