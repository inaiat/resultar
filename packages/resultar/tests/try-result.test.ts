import { equal, strictEqual, throws } from 'node:assert'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import tryResultDefault, {
  type Result,
  type ResultAsync,
  tryCatch,
  tryCatchAsync,
  tryResult,
  tryResultAsync,
} from '../src/index.js'
import * as result from '../src/index.js'

class WrappedError extends Error {
  public readonly wrappedCause: unknown

  public constructor(wrappedCause: unknown) {
    super('wrapped error')
    this.wrappedCause = wrappedCause
  }
}

describe('tryResult', async () => {
  it('supports the positional success signature', () => {
    const actual = tryResult(() => JSON.parse('{"value":1}') as { value: number })

    expectTypeOf(actual).toExtend<Result<{ value: number }, unknown>>()
    equal(actual._unsafeUnwrap().value, 1)
  })

  it('supports the positional error mapping signature', () => {
    const original = new Error('boom')
    const actual = tryResult(
      (): number => {
        throw original
      },
      (error) => new WrappedError(error),
    )

    expectTypeOf(actual).toExtend<Result<number, WrappedError>>()
    strictEqual(actual._unsafeUnwrapErr().wrappedCause, original)
  })

  it('supports the object success signature', () => {
    const actual = tryResult({ try: () => JSON.parse('{"value":2}') as { value: number } })

    expectTypeOf(actual).toExtend<Result<{ value: number }, unknown>>()
    equal(actual._unsafeUnwrap().value, 2)
  })

  it('supports the object error mapping signature', () => {
    const original = new Error('boom')
    const actual = tryResult({
      try: (): number => {
        throw original
      },
      catch: (error) => new WrappedError(error),
    })

    expectTypeOf(actual).toExtend<Result<number, WrappedError>>()
    strictEqual(actual._unsafeUnwrapErr().wrappedCause, original)
  })

  it('keeps the original thrown value when object catch is omitted', () => {
    const original = new Error('boom')
    const actual = tryResult<number>({
      try: () => {
        throw original
      },
    })

    strictEqual(actual._unsafeUnwrapErr(), original)
  })

  it('exposes sync aliases and the default export as the same function', () => {
    strictEqual(tryCatch, tryResult)
    strictEqual(result.try, tryResult)
    strictEqual(tryResultDefault, tryResult)
    strictEqual(result.default, tryResult)
  })
})

describe('tryResultAsync', async () => {
  it('supports the direct promise signature', async () => {
    const actual = await tryResultAsync(Promise.resolve(1))

    expectTypeOf(actual).toExtend<Result<number, unknown>>()
    equal(actual._unsafeUnwrap(), 1)
  })

  it('supports the async factory signature', async () => {
    const pending = tryResultAsync(async () => 2)
    const actual = await pending

    expectTypeOf(pending).toExtend<ResultAsync<number, unknown>>()
    equal(actual._unsafeUnwrap(), 2)
  })

  it('treats async functions with try properties as factories', async () => {
    const factory = async (): Promise<number> => 4

    Object.defineProperty(factory, 'try', { configurable: true, value: async () => 99 })

    const actual = await tryResultAsync(factory)

    equal(actual._unsafeUnwrap(), 4)
  })

  it('does not treat primitive runtime inputs as option objects', () => {
    throws(() => {
      void tryResultAsync('not-a-promise' as unknown as Promise<never>)
    }, /then/u)
  })

  it('supports the async positional error mapping signature', async () => {
    const original = new Error('boom')
    const pending = tryResultAsync(
      async (): Promise<number> => {
        throw original
      },
      (error) => new WrappedError(error),
    )
    const actual = await pending

    expectTypeOf(pending).toExtend<ResultAsync<number, WrappedError>>()
    strictEqual(actual._unsafeUnwrapErr().wrappedCause, original)
  })

  it('supports the async object success signature', async () => {
    const actual = await tryResultAsync({ try: async () => 3 })

    expectTypeOf(actual).toExtend<Result<number, unknown>>()
    equal(actual._unsafeUnwrap(), 3)
  })

  it('supports the async object error mapping signature', async () => {
    const original = new Error('boom')
    const pending = tryResultAsync({
      try: async (): Promise<number> => {
        throw original
      },
      catch: (error) => new WrappedError(error),
    })
    const actual = await pending

    expectTypeOf(pending).toExtend<ResultAsync<number, WrappedError>>()
    strictEqual(actual._unsafeUnwrapErr().wrappedCause, original)
  })

  it('keeps the original rejection value when object catch is omitted', async () => {
    const original = new Error('boom')
    const actual = await tryResultAsync<number>({ try: () => Promise.reject(original) })

    strictEqual(actual._unsafeUnwrapErr(), original)
  })

  it('exposes async aliases as the same function', () => {
    strictEqual(tryCatchAsync, tryResultAsync)
    strictEqual(result.tryAsync, tryResultAsync)
  })
})
