import { equal } from 'node:assert'
import { describe, expectTypeOf, it } from 'vite-plus/test'

import type { ResultAsync, ResultAsyncGenerator, ResultGenerator } from '../src/index.js'
import { Result, err, ok, okAsync } from '../src/index.js'

describe('Result type narrowing', () => {
  it('exposes only value after isOk', () => {
    const result = ok<number, string>(123)

    if (result.isOk()) {
      expectTypeOf(result.value).toEqualTypeOf<number>()
      // @ts-expect-error Ok results do not expose an error property.
      equal(result.error, undefined)
    }
  })

  it('exposes only error after isErr', () => {
    const result = err<number, string>('failure')

    if (result.isErr()) {
      expectTypeOf(result.error).toEqualTypeOf<string>()
      // @ts-expect-error Err results do not expose a value property.
      equal(result.value, undefined)
    }
  })

  it('does not expose value in an Err branch from fromThrowable', () => {
    const resultarJsonParse = Result.fromThrowable(JSON.parse, () => 'JSON parse error')
    const result = resultarJsonParse('boom')

    if (result.isErr()) {
      expectTypeOf(result.error).toEqualTypeOf<string>()
      // @ts-expect-error Err results do not expose a value property.
      equal(result.value, undefined)
    }
  })

  it('supports explicit ResultGenerator and ResultAsyncGenerator return annotations', async () => {
    function* parsePositive(input: string): ResultGenerator<number, 'nan' | 'non-positive'> {
      const n = Number(input)
      if (Number.isNaN(n)) {
        return yield* err('nan' as const)
      }
      if (n <= 0) {
        return yield* err('non-positive' as const)
      }
      return yield* ok(n)
    }

    const syncFn = Result.fn(function* (
      input: string,
    ): ResultGenerator<number, 'nan' | 'non-positive'> {
      const value = yield* parsePositive(input)
      return value * 2
    })

    const asyncFn = Result.fn(async function* (
      input: string,
    ): ResultAsyncGenerator<number, 'nan' | 'non-positive' | 'remote'> {
      const local = yield* parsePositive(input)
      const remote = yield* okAsync<number, 'remote'>(10)
      return local + remote
    })

    const syncGen = Result.gen(function* (): ResultGenerator<number, 'nan' | 'non-positive'> {
      return yield* parsePositive('21')
    })

    expectTypeOf(syncFn).toEqualTypeOf<(input: string) => Result<number, 'nan' | 'non-positive'>>()
    expectTypeOf(asyncFn).toEqualTypeOf<
      (input: string) => ResultAsync<number, 'nan' | 'non-positive' | 'remote'>
    >()
    expectTypeOf(syncGen).toEqualTypeOf<Result<number, 'nan' | 'non-positive'>>()

    equal(syncFn('5')._unsafeUnwrap(), 10)
    equal((await asyncFn('5'))._unsafeUnwrap(), 15)
    equal(syncGen._unsafeUnwrap(), 21)
  })
})
