import { equal, ok as assertOk, strictEqual } from 'node:assert'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import { type Result, type ResultAsync, err, errAsync, ok, okAsync, safeTry } from '../src/index.js'

class ParseConfigError extends Error {
  public readonly parseCause: unknown

  public constructor(options: { readonly cause: unknown }) {
    super('parse config failed')
    this.parseCause = options.cause
  }
}

describe('safeTry object form', () => {
  it('returns the final Ok for a sync generator', () => {
    const actual = safeTry({
      *try() {
        const value = yield* ok<number, string>(1)

        return ok<number, string>(value + 1)
      },
    })

    expectTypeOf(actual).toExtend<Result<number, string>>()
    assertOk(actual.isOk())
    equal(actual._unsafeUnwrap(), 2)
  })

  it('short-circuits the first yielded Err for a sync generator', () => {
    const actual = safeTry({
      *try() {
        const value = yield* err<number, string>('failure')

        return ok<number, string>(value + 1)
      },
    })

    expectTypeOf(actual).toExtend<Result<number, string>>()
    assertOk(actual.isErr())
    equal(actual._unsafeUnwrapErr(), 'failure')
  })

  it('returns the final Ok for an async generator', async () => {
    const pending = safeTry({
      async *try() {
        const first = yield* okAsync<number, string>(1)
        const second = yield* ok<number, string>(2)

        return okAsync<number, string>(first + second)
      },
    })
    const actual = await pending

    expectTypeOf(pending).toExtend<ResultAsync<number, string>>()
    assertOk(actual.isOk())
    equal(actual._unsafeUnwrap(), 3)
  })

  it('short-circuits the first yielded Err for an async generator', async () => {
    const pending = safeTry({
      async *try() {
        const first = yield* okAsync<number, string>(1)
        const second = yield* errAsync<number, string>('async failure')

        return ok<number, string>(first + second)
      },
    })
    const actual = await pending

    expectTypeOf(pending).toExtend<ResultAsync<number, string>>()
    assertOk(actual.isErr())
    equal(actual._unsafeUnwrapErr(), 'async failure')
  })

  it('supports explicit generics with an async object generator', async () => {
    function promiseGood(): Promise<Result<number, string>> {
      return Promise.resolve(ok<number, string>(3))
    }

    function asyncBad(): ResultAsync<number, string> {
      return errAsync<number, string>('err!')
    }

    function run(): ResultAsync<number, string> {
      return safeTry<number, string>({
        async *try() {
          const goodResult = await promiseGood()
          const value = yield* goodResult.mapErr((e) => `1st, ${e}`)
          const value2 = yield* asyncBad().mapErr((e) => `2nd, ${e}`)

          return okAsync<number, string>(value + value2)
        },
      })
    }

    const actual = await run()

    assertOk(actual.isErr())
    equal(actual._unsafeUnwrapErr(), '2nd, err!')
  })

  it('maps thrown sync generator errors with object catch', () => {
    function readConfigFile(): Result<string, string> {
      return ok('{')
    }

    const actual = safeTry({
      *try() {
        const raw = yield* readConfigFile()

        return ok(JSON.parse(raw) as { readonly port: number })
      },
      catch: (error) => new ParseConfigError({ cause: error }),
    })

    expectTypeOf(actual).toExtend<Result<{ readonly port: number }, string | ParseConfigError>>()
    assertOk(actual.isErr())
    assertOk(actual._unsafeUnwrapErr() instanceof ParseConfigError)
  })

  it('does not map yielded sync Err values with object catch', () => {
    let catchCalled = false

    const actual = safeTry({
      *try() {
        const raw = yield* err<string, string>('missing config')

        return ok(JSON.parse(raw) as { readonly port: number })
      },
      catch: (error) => {
        catchCalled = true
        return new ParseConfigError({ cause: error })
      },
    })

    assertOk(actual.isErr())
    equal(actual._unsafeUnwrapErr(), 'missing config')
    equal(catchCalled, false)
  })

  it('maps thrown async generator errors with object catch', async () => {
    const pending = safeTry({
      async *try() {
        const raw = yield* okAsync<string, string>('{')

        return ok(JSON.parse(raw) as { readonly port: number })
      },
      catch: (error) => new ParseConfigError({ cause: error }),
    })
    const actual = await pending

    expectTypeOf(pending).toExtend<
      ResultAsync<{ readonly port: number }, string | ParseConfigError>
    >()
    assertOk(actual.isErr())
    assertOk(actual._unsafeUnwrapErr() instanceof ParseConfigError)
  })

  it('supports explicit generics with an async object catch mapper', async () => {
    const pending = safeTry<number, string>({
      async *try() {
        yield* okAsync<number, string>(1)
        throw new Error('unexpected failure')
      },
      catch: () => 'mapped failure',
    })
    const actual = await pending

    expectTypeOf(pending).toExtend<ResultAsync<number, string>>()
    assertOk(actual.isErr())
    strictEqual(actual._unsafeUnwrapErr(), 'mapped failure')
  })
})
