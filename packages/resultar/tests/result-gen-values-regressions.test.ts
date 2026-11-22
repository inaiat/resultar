/* eslint-disable require-yield -- Final-return-only generators verify completion without yielded operations. */
import { deepEqual, equal, rejects, throws } from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expectTypeOf, it } from 'vite-plus/test'

import { ResultAsync, errAsync, okAsync } from '../src/entries/async.js'
import { Result, err, ok } from '../src/index.js'

describe('Result.gen and ResultAsync.gen value return regressions', () => {
  it('delegates native and structural Results via yield* in Result.gen and ResultAsync.gen', async () => {
    const payload = { id: 'user-1' }
    const native = ok(payload)
    const structural: Result<{ id: string }, never> = new Proxy(native, {
      getPrototypeOf: () => Object.prototype,
    })
    equal(Object.getPrototypeOf(structural), Object.prototype)
    equal(
      Result.gen(function* () {
        return yield* native
      })._unsafeUnwrap(),
      payload,
    )
    equal(
      Result.gen(function* () {
        return yield* structural
      })._unsafeUnwrap(),
      payload,
    )
    equal(
      (
        await ResultAsync.gen(async function* () {
          return yield* structural
        })
      )._unsafeUnwrap(),
      payload,
    )
    const failure = err('final failure')
    const yielded = Result.gen(function* () {
      yield* ok(1)
      return yield* failure
    })
    equal(yielded, failure)
  })

  it('unwraps Results from a separate module instance via yield*', () => {
    const resultUrl = new URL('../src/result/result.ts', import.meta.url).href
    const indexUrl = new URL('../src/index.ts', import.meta.url).href
    const asyncUrl = new URL('../src/entries/async.ts', import.meta.url).href
    const script = `
      import { equal } from 'node:assert/strict';
      const { Result } = await import(${JSON.stringify(indexUrl)});
      const { ResultAsync } = await import(${JSON.stringify(asyncUrl)});
      const foreign = await import(${JSON.stringify(`${resultUrl}?independent-copy`)});
      const success = foreign.ok(42);
      const failure = foreign.err('foreign failure');
      equal(Result.gen(function* () { return yield* success; })._unsafeUnwrap(), 42);
      equal(await ResultAsync.gen(async function* () { return yield* failure; }), failure);
    `
    const output = execFileSync(
      process.execPath,
      ['--import', 'vite-plus/register', '--input-type', 'module', '--eval', script],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10_000 },
    )
    equal(output, '')
  })

  it('wraps null, undefined, function values and bare Result-shaped domain data', () => {
    const domain = { _tag: 'Ok', value: 42, isOk: true, isErr: false } as const
    const callback = (value: number): number => value + 1
    const nullResult = Result.gen(function* () {
      return null
    })
    const voidResult = Result.gen(function* () {
      yield* ok(1)
    })
    const functionResult = Result.gen(function* () {
      return callback
    })
    const domainResult = Result.gen(function* () {
      return domain
    })
    expectTypeOf(nullResult).toEqualTypeOf<Result<null, never>>()
    expectTypeOf(voidResult).toEqualTypeOf<Result<void, never>>()
    expectTypeOf(functionResult).toEqualTypeOf<Result<typeof callback, never>>()
    expectTypeOf(domainResult).toEqualTypeOf<Result<typeof domain, never>>()
    equal(nullResult.unwrapOrThrow(), null)
    equal(voidResult.unwrapOrThrow(), undefined)
    equal(functionResult.unwrapOrThrow(), callback)
    equal(domainResult.unwrapOrThrow(), domain)
  })

  it('infers mixed plain and delegated Result.gen returns', () => {
    const choose = (accepted: boolean) =>
      Result.gen(function* () {
        yield* ok<number, 'validation'>(1)
        return accepted ? (42 as const) : yield* err('rejected' as const)
      })
    expectTypeOf(choose(true)).toEqualTypeOf<Result<42, 'validation' | 'rejected'>>()
    deepEqual(choose(true), ok(42))
    deepEqual(choose(false), err('rejected'))
  })

  it('short-circuits yielded failures without draining finally for raw return workflows', async () => {
    const events: string[] = []
    const syncFailure = err('sync failure')
    const sync = Result.gen(function* () {
      try {
        yield* syncFailure
        return 42
      } finally {
        events.push('sync finally')
      }
    })
    const asyncFailure = err('async failure')
    const pending = ResultAsync.gen(async function* () {
      try {
        yield* errAsync(asyncFailure.error)
        return 42
      } finally {
        events.push('async finally')
      }
    })
    expectTypeOf(sync).toEqualTypeOf<Result<number, 'sync failure'>>()
    expectTypeOf(pending).toEqualTypeOf<ResultAsync<number, 'async failure'>>()
    equal(sync, syncFailure)
    deepEqual(await pending, asyncFailure)
    deepEqual(events, [])
  })

  it('maps generator failures and propagates mapper defects in sync and async forms', async () => {
    const defect = new Error('generator failed')
    const mapperDefect = new Error('mapper failed')
    const fail = (): never => {
      throw defect
    }
    const mapDefect = (): never => {
      throw mapperDefect
    }
    const sync = Result.gen({
      *try() {
        yield* ok(1)
        return fail()
      },
      catch: (error) => (error === defect ? ('mapped' as const) : ('unexpected' as const)),
    })
    deepEqual(sync, err('mapped'))
    const pending = ResultAsync.gen({
      async *try() {
        yield* okAsync(1)
        return fail()
      },
      catch: (error) => (error === defect ? ('mapped' as const) : ('unexpected' as const)),
    })
    deepEqual(await pending, err('mapped'))
    throws(
      () =>
        Result.gen({
          *try() {
            return fail()
          },
          catch: mapDefect,
        }),
      (error) => error === mapperDefect,
    )
    await rejects(
      Promise.resolve(
        ResultAsync.gen({
          async *try() {
            return fail()
          },
          catch: mapDefect,
        }),
      ),
      (error) => error === mapperDefect,
    )
  })

  it('awaits async return thenables in ResultAsync.gen', async () => {
    const thenable = {
      then: (resolve: (value: number) => void): void => {
        resolve(42)
      },
    }
    const pending = ResultAsync.gen(async function* () {
      return thenable
    })
    expectTypeOf(pending).toEqualTypeOf<ResultAsync<number, never>>()
    deepEqual(await pending, ok(42))
  })

  it('does not read incomplete Result protocol getters on ordinary domain data', () => {
    let probes = 0
    const domain = {
      value: 42,
      get isOk(): never {
        probes += 1
        throw new Error('domain getter')
      },
      get isErr(): never {
        probes += 1
        throw new Error('domain getter')
      },
    }
    const result = Result.gen(function* () {
      return domain
    })
    equal(result.unwrapOrThrow(), domain)
    equal(probes, 0)
  })

  it('does not query the prototype or properties of an opaque proxy payload', () => {
    let queries = 0
    const failQuery = (): never => {
      queries += 1
      throw new Error('opaque payload query')
    }
    const domain = new Proxy(
      { id: 'user-1' },
      { getPrototypeOf: failQuery, has: failQuery, get: failQuery },
    )
    const result = Result.gen(function* () {
      return domain
    })
    expectTypeOf(result).toEqualTypeOf<Result<{ id: string }, never>>()
    equal(result.unwrapOrThrow(), domain)
    equal(queries, 0)
  })

  it('reads an async raw DTO then getter once and never inspects a boxed opaque payload', async () => {
    let thenReads = 0
    const domain = {
      id: 'user-1',
      get then(): undefined {
        thenReads += 1
        if (thenReads > 1) throw new Error('repeated then lookup')
        return undefined
      },
    }
    const pending = ResultAsync.gen(async function* () {
      return domain
    })
    expectTypeOf(pending).toEqualTypeOf<ResultAsync<typeof domain, never>>()
    const result = await pending
    equal(result.unwrapOrThrow(), domain)
    equal(thenReads, 1)

    let opaqueQueries = 0
    const failQuery = (): never => {
      opaqueQueries += 1
      throw new Error('opaque payload query')
    }
    const opaque = new Proxy(
      { id: 'opaque' },
      { getPrototypeOf: failQuery, has: failQuery, get: failQuery },
    )
    const wrapped = await ResultAsync.gen(async function* () {
      return { opaque }
    })
    equal(wrapped.unwrapOrThrow().opaque, opaque)
    equal(opaqueQueries, 0)
  })

  it('returns Ok(undefined) when a sync or async workflow omits its return', async () => {
    const sync = Result.gen(function* () {
      yield* ok(1)
    })
    const pending = ResultAsync.gen(async function* () {
      yield* okAsync(1)
    })
    expectTypeOf(sync).toEqualTypeOf<Result<void, never>>()
    expectTypeOf(pending).toEqualTypeOf<ResultAsync<void, never>>()
    deepEqual(sync, ok(undefined))
    deepEqual(await pending, ok(undefined))
  })

  it('ignores own catch property on async generator functions passed to ResultAsync.gen', async () => {
    const boom = new Error('unmapped boom')
    const generatorWithCatch = Object.assign(
      // eslint-disable-next-line require-await -- Throws synchronously inside async generator body.
      async function* () {
        throw boom
      },
      { catch: () => 'should-not-run' },
    )
    await rejects(Promise.resolve(ResultAsync.gen(generatorWithCatch)), (error) => error === boom)
  })
})
