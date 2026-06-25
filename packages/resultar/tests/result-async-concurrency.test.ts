import { deepEqual, equal, ok as isTrue, rejects } from 'node:assert'
import { setTimeout as sleep } from 'node:timers/promises'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import type { ResultAsyncConcurrency } from '../src/index.js'

import { Result, ResultAsync, errAsync, okAsync } from '../src/index.js'

const resultAsyncForEach: typeof ResultAsync.forEach = ResultAsync.forEach

const delayedOk = <T, E = never>(value: T, delayMs: number): ResultAsync<T, E> =>
  new ResultAsync<T, E>(
    Promise.try(async () => {
      await sleep(delayMs)

      return Result.ok<T, E>(value)
    }),
  )

const delayedErr = <T = never, E = unknown>(error: E, delayMs: number): ResultAsync<T, E> =>
  new ResultAsync<T, E>(
    Promise.try(async () => {
      await sleep(delayMs)

      return Result.err<T, E>(error)
    }),
  )

describe('ResultAsync concurrency options', () => {
  it('keeps ResultAsync.forEach sequential by default', async () => {
    let active = 0
    let maxActive = 0

    const result = await resultAsyncForEach([1, 2, 3], (value) => {
      active += 1
      maxActive = Math.max(maxActive, active)

      return new ResultAsync<number, string>(
        Promise.try(async () => {
          await sleep(1)
          active -= 1

          return Result.ok<number, string>(value * 2)
        }),
      )
    })

    isTrue(result.isOk())
    deepEqual(result.value, [2, 4, 6])
    equal(maxActive, 1)
  })

  it('limits ResultAsync.forEach with numbered concurrency', async () => {
    let active = 0
    let maxActive = 0

    const result = await resultAsyncForEach(
      [1, 2, 3, 4],
      (value) => {
        active += 1
        maxActive = Math.max(maxActive, active)

        return new ResultAsync<number, string>(
          Promise.try(async () => {
            await sleep(5)
            active -= 1

            return Result.ok<number, string>(value * 10)
          }),
        )
      },
      { concurrency: 2 },
    )

    isTrue(result.isOk())
    deepEqual(result.value, [10, 20, 30, 40])
    equal(maxActive, 2)
  })

  it('starts all ResultAsync.forEach items with unbounded concurrency', async () => {
    let active = 0
    let maxActive = 0

    const result = await resultAsyncForEach(
      [1, 2, 3, 4],
      (value) => {
        active += 1
        maxActive = Math.max(maxActive, active)

        return new ResultAsync<number, string>(
          Promise.try(async () => {
            await sleep(5)
            active -= 1

            return Result.ok<number, string>(value)
          }),
        )
      },
      { concurrency: 'unbounded' },
    )

    isTrue(result.isOk())
    deepEqual(result.value, [1, 2, 3, 4])
    equal(maxActive, 4)
  })

  it('preserves ResultAsync.forEach value order when tasks complete out of order', async () => {
    const result = await resultAsyncForEach(
      [1, 2, 3],
      (value) => delayedOk<number, string>(value * 10, value === 1 ? 20 : 1),
      { concurrency: 'unbounded' },
    )

    isTrue(result.isOk())
    deepEqual(result.value, [10, 20, 30])
  })

  it('keeps discard mode with concurrent ResultAsync.forEach', async () => {
    const result = await resultAsyncForEach(
      [1, 2, 3],
      (value) => delayedOk<number, string>(value, 1),
      { concurrency: 2, discard: true },
    )

    isTrue(result.isOk())
    equal(result.value, undefined)
  })

  it('waits for active discard ResultAsync.forEach tasks before resolving', async () => {
    const completed: number[] = []

    const result = await resultAsyncForEach(
      [1, 2],
      (value) =>
        new ResultAsync<number, string>(
          Promise.try(async () => {
            await sleep(value === 1 ? 10 : 1)
            completed.push(value)

            return Result.ok<number, string>(value)
          }),
        ),
      { concurrency: 2, discard: true },
    )

    isTrue(result.isOk())
    equal(result.value, undefined)
    deepEqual(
      [...completed].toSorted((left, right) => left - right),
      [1, 2],
    )
  })

  it('stops scheduling ResultAsync.forEach after error and returns the first started input error', async () => {
    const started: number[] = []

    const result = await resultAsyncForEach(
      [0, 1, 2, 3, 4],
      (value) => {
        started.push(value)

        if (value === 0) {
          return delayedErr<number, string>('zero', 20)
        }

        if (value === 1) {
          return delayedErr<number, string>('one', 1)
        }

        return delayedOk<number, string>(value, 5)
      },
      { concurrency: 3 },
    )

    isTrue(result.isErr())
    equal(result.error, 'zero')
    deepEqual(started, [0, 1, 2])
  })

  it('limits ResultAsync.validateAll with numbered concurrency', async () => {
    let active = 0
    let maxActive = 0

    const result = await ResultAsync.validateAll(
      [1, 2, 3, 4],
      (value) => {
        active += 1
        maxActive = Math.max(maxActive, active)

        return new ResultAsync<number, string>(
          Promise.try(async () => {
            await sleep(5)
            active -= 1

            return Result.ok<number, string>(value * 2)
          }),
        )
      },
      { concurrency: 2 },
    )

    isTrue(result.isOk())
    deepEqual(result.value, [2, 4, 6, 8])
    equal(maxActive, 2)
  })

  it('starts all ResultAsync.validateAll items with unbounded concurrency', async () => {
    let active = 0
    let maxActive = 0

    const result = await ResultAsync.validateAll(
      [1, 2, 3],
      (value) => {
        active += 1
        maxActive = Math.max(maxActive, active)

        return new ResultAsync<number, string>(
          Promise.try(async () => {
            await sleep(5)
            active -= 1

            return Result.ok<number, string>(value)
          }),
        )
      },
      { concurrency: 'unbounded' },
    )

    isTrue(result.isOk())
    deepEqual(result.value, [1, 2, 3])
    equal(maxActive, 3)
  })

  it('collects ResultAsync.validateAll errors in input order', async () => {
    const result = await ResultAsync.validateAll(
      [0, 1, 2, 3],
      (value) => {
        if (value === 1) {
          return delayedErr<number, string>('one', 20)
        }

        if (value === 3) {
          return delayedErr<number, string>('three', 1)
        }

        return delayedOk<number, string>(value, 5)
      },
      { concurrency: 'unbounded' },
    )

    isTrue(result.isErr())
    deepEqual(result.error, ['one', 'three'])
  })

  it('rejects invalid runtime concurrency values', async () => {
    await rejects(
      async () =>
        await resultAsyncForEach([1], (value) => okAsync<number, string>(value), {
          concurrency: 0 as ResultAsyncConcurrency,
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === 'IllegalArgumentException' &&
        error.message === 'ResultAsync concurrency must be a positive integer or "unbounded"',
    )
  })

  it('infers public concurrency option types', () => {
    const concurrency: ResultAsyncConcurrency = 'unbounded'
    const collected = resultAsyncForEach(
      [1, 2] as const,
      (value) =>
        value === 1
          ? okAsync<number, 'ok-error'>(value)
          : errAsync<string, 'err-error'>('err-error'),
      { concurrency: 2 },
    )
    const discarded = resultAsyncForEach(
      [1, 2],
      (value) => okAsync<number, 'discard-error'>(value),
      { concurrency, discard: true },
    )
    const validated = ResultAsync.validateAll(
      [1, 2],
      (value) => okAsync<number, 'validation-error'>(value),
      { concurrency },
    )

    expectTypeOf(collected).toEqualTypeOf<
      ResultAsync<readonly (number | string)[], 'ok-error' | 'err-error'>
    >()
    expectTypeOf(discarded).toEqualTypeOf<ResultAsync<void, 'discard-error'>>()
    expectTypeOf(validated).toEqualTypeOf<ResultAsync<readonly number[], 'validation-error'[]>>()
  })
})
