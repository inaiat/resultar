import { describe, expect, expectTypeOf, it } from 'vite-plus/test'

import { okAsync, pipe, type Result, ResultAsync, ResultTask } from '../src/index.js'

describe('ResultAsync.map compatibility', () => {
  it('resolves an async mapper before wrapping the success value', async () => {
    const result = await okAsync(1).map(async (value) => value + 1)

    expectTypeOf(result).toEqualTypeOf<Result<number, never>>()
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap()).toBe(2)
  })

  it('resolves async mappers in static and curried ResultAsync.map', async () => {
    const fromStaticAsync = await ResultAsync.map(okAsync(1), async (value) => value + 1)
    const fromCurriedAsync = await pipe(
      okAsync(1),
      ResultAsync.map(async (value) => value + 1),
    )
    expectTypeOf(fromStaticAsync).toEqualTypeOf<Result<number, never>>()
    expectTypeOf(fromCurriedAsync).toEqualTypeOf<Result<number, never>>()
    expect(fromStaticAsync._unsafeUnwrap()).toBe(2)
    expect(fromCurriedAsync._unsafeUnwrap()).toBe(2)
  })

  it('preserves synchronous null and plain object mapper values', async () => {
    const nullResult = await okAsync(1).map(() => null)
    const objectResult = await okAsync(1).map((value) => ({ value }))

    expectTypeOf(nullResult).toEqualTypeOf<Result<null, never>>()
    expectTypeOf(objectResult).toEqualTypeOf<Result<{ value: number }, never>>()
    expect(nullResult._unsafeUnwrap()).toBeNull()
    expect(objectResult._unsafeUnwrap()).toEqual({ value: 1 })
  })
})

describe('ResultTask.map promise payloads', () => {
  it('preserves an async mapper Promise as the success value after explicit execution', async () => {
    const x: ResultTask<number, never> = ResultTask.ok(1)
    const mapped = x.map(async (value) => value + 1)

    expectTypeOf(mapped).toEqualTypeOf<ResultTask<Promise<number>, never>>()
    expect('then' in mapped).toBe(false)

    const result = await ResultTask.runResult(mapped)

    expectTypeOf(result).toEqualTypeOf<Result<Promise<number>, never>>()
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap()).toBeInstanceOf(Promise)
    expect(await result._unsafeUnwrap()).toBe(2)
  })

  it('preserves Promise payloads in static and curried ResultTask.map', async () => {
    const fromStaticTask = ResultTask.map(ResultTask.ok(1), async (value) => value + 1)
    const fromCurriedTask = pipe(
      ResultTask.ok(1),
      ResultTask.map(async (value) => value + 1),
    )

    expectTypeOf(fromStaticTask).toEqualTypeOf<ResultTask<Promise<number>, never>>()
    expectTypeOf(fromCurriedTask).toEqualTypeOf<ResultTask<Promise<number>, never>>()

    const fromStatic = await ResultTask.runResult(fromStaticTask)
    const fromCurried = await ResultTask.runResult(fromCurriedTask)

    expectTypeOf(fromStatic).toEqualTypeOf<Result<Promise<number>, never>>()
    expectTypeOf(fromCurried).toEqualTypeOf<Result<Promise<number>, never>>()
    expect(fromStatic._unsafeUnwrap()).toBeInstanceOf(Promise)
    expect(fromCurried._unsafeUnwrap()).toBeInstanceOf(Promise)
    expect(await fromStatic._unsafeUnwrap()).toBe(2)
    expect(await fromCurried._unsafeUnwrap()).toBe(2)
  })
})
