import { deepEqual, equal, rejects, throws } from 'node:assert/strict'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import {
  Result,
  ResultAsync,
  createTaggedError,
  err,
  errAsync,
  ok,
  okAsync,
  pipe,
} from '../src/index.js'

describe('Result functional operators', () => {
  it('infers direct and curried inline success pipelines and combines errors', () => {
    const input: Result<number, 'source'> = ok(2)
    const direct = Result.andThen(
      // eslint-disable-next-line unicorn/no-array-method-this-argument -- Result.map takes a Result and callback.
      Result.map(input, (value) => value + 1),
      (value) => (value > 0 ? ok(String(value)) : err('validation' as const)),
    )
    const curried = pipe(
      input,
      Result.map((value) => value + 1),
      Result.andThen((value) => (value > 0 ? ok(String(value)) : err('validation' as const))),
    )
    const fluentPipe = input.pipe(Result.map((value) => value.toFixed(0)))

    expectTypeOf(direct).toEqualTypeOf<Result<string, 'source' | 'validation'>>()
    expectTypeOf(curried).toEqualTypeOf<Result<string, 'source' | 'validation'>>()
    expectTypeOf(fluentPipe).toEqualTypeOf<Result<string, 'source'>>()
    equal(direct._unsafeUnwrap(), '3')
    equal(curried._unsafeUnwrap(), '3')
  })

  it('maps and recovers concrete error channels without discarding success types', () => {
    const input: Result<number, 'source'> = err('source')
    const direct = Result.orElse(
      Result.mapErr(input, (error) => ({ code: error })),
      (error) => {
        expectTypeOf(error).toEqualTypeOf<{ code: 'source' }>()
        return ok(error.code)
      },
    )
    const curried = pipe(
      input,
      Result.mapErr((error) => ({ code: error })),
      Result.orElse((error) => {
        expectTypeOf(error).toEqualTypeOf<{ code: 'source' }>()
        return ok(error.code)
      }),
    )

    expectTypeOf(direct).toEqualTypeOf<Result<number | 'source', never>>()
    expectTypeOf(curried).toEqualTypeOf<Result<number | 'source', never>>()
    equal(direct._unsafeUnwrap(), 'source')
    equal(curried._unsafeUnwrap(), 'source')
  })

  it('keeps heterogeneous branch outputs and rejects incompatible callbacks', () => {
    const input: Result<number, 'source'> = ok(2)
    const choose = (value: number) =>
      value > 0 ? ok('ready' as const) : err({ _tag: 'Invalid' as const, value })
    const chained = input.pipe(Result.andThen(choose))
    const recovered = pipe(
      input,
      Result.orElse((error) => (error.length > 0 ? ok(true) : err('recovery' as const))),
    )

    expectTypeOf(chained).toEqualTypeOf<
      Result<'ready', 'source' | { _tag: 'Invalid'; value: number }>
    >()
    expectTypeOf(recovered).toEqualTypeOf<Result<number | boolean, 'recovery'>>()
    equal(chained._unsafeUnwrap(), 'ready')
    equal(recovered._unsafeUnwrap(), 2)

    if (false) {
      // @ts-expect-error The mapper does not accept number input.
      Result.map((value: string) => value.length)(input)
      // @ts-expect-error The recovery handler does not accept the source error.
      Result.orElse((_error: Error) => ok(0))(input)
      Result.filterOrElse(
        // @ts-expect-error Validation predicates must return synchronous booleans.
        async (_value: number) => true,
        () => 'invalid',
      )
    }
  })

  it('preserves inactive callbacks and constant success replacement', () => {
    let calls = 0
    const fail: Result<number, 'source'> = err('source')
    const success: Result<number, 'source'> = ok(2)
    const onValue = (value: number): number => {
      calls += 1
      return value + 1
    }
    const onError = (error: 'source'): string => {
      calls += 1
      return error
    }

    // eslint-disable-next-line unicorn/no-array-method-this-argument -- Result.map takes a Result and callback.
    equal(Result.map(fail, onValue)._unsafeUnwrapErr(), 'source')
    equal(Result.mapErr(success, onError)._unsafeUnwrap(), 2)
    equal(Result.andThen(fail, (value) => ok(onValue(value)))._unsafeUnwrapErr(), 'source')
    equal(Result.orElse(success, (error) => ok(onError(error)))._unsafeUnwrap(), 2)
    equal(calls, 0)
    equal(Result.as(success, 'ready')._unsafeUnwrap(), 'ready')
    equal(fail.pipe(Result.as('ready'))._unsafeUnwrapErr(), 'source')
    expectTypeOf(Result.as('ready')(success)).toEqualTypeOf<Result<string, 'source'>>()
  })

  it('keeps inspection best-effort, immediate and identical to the original value', () => {
    const success = ok<number, 'source'>(2)
    const failure = err<number, 'source'>('source')
    const seen: unknown[] = []
    const inspected = pipe(
      success,
      Result.inspect((value) => {
        expectTypeOf(value).toEqualTypeOf<number>()
        seen.push(value)
        throw new Error('observer failure')
      }),
      Result.inspectError((error) => seen.push(error)),
    )
    const inspectedError = Result.inspectError(failure, (error) => {
      expectTypeOf(error).toEqualTypeOf<'source'>()
      seen.push(error)
      throw new Error('observer failure')
    })

    expectTypeOf(inspected).toEqualTypeOf<Result<number, 'source'>>()
    equal(inspected, success)
    equal(inspectedError, failure)
    equal(
      Result.inspect(failure, (value) => seen.push(value)),
      failure,
    )
    equal(
      Result.inspectError(success, (error) => seen.push(error)),
      success,
    )
    deepEqual(seen, [2, 'source'])

    const bothSeen: string[] = []
    const handlers = {
      ok: (v: number) => {
        bothSeen.push(`ok:${v}`)
        throw new Error('ignored')
      },
      error: (e: 'source') => {
        bothSeen.push(`err:${e}`)
        throw new Error('ignored')
      },
    }
    equal(success.inspectBoth(handlers), success)
    equal(failure.inspectBoth(handlers), failure)
    equal(success.inspectBoth(handlers.ok, handlers.error), success)
    equal(failure.inspectBoth(handlers.ok, handlers.error), failure)
    equal(Result.inspectBoth(success, handlers), success)
    equal(Result.inspectBoth(failure, handlers.ok, handlers.error), failure)
    equal(pipe(success, Result.inspectBoth(handlers)), success)
    equal(pipe(failure, Result.inspectBoth(handlers.ok, handlers.error)), failure)
    deepEqual(bothSeen, [
      'ok:2',
      'err:source',
      'ok:2',
      'err:source',
      'ok:2',
      'err:source',
      'ok:2',
      'err:source',
    ])
  })

  it('supports Result.all as a unified collection combinator for tuples, arrays, and records', () => {
    const tupleResult = Result.all([ok<number, 'e1'>(1), ok<string, 'e2'>('two')])
    const arrayInput: readonly Result<number, 'arr'>[] = [ok(1), ok(2), ok(3)]
    const arrayResult = Result.all(arrayInput)
    const recordResult = Result.all({
      id: ok<number, 'idErr'>(7),
      name: ok<string, 'nameErr'>('Ada'),
    })
    const failedAll = Result.all([ok<number, 'e1'>(1), err<string, 'e2'>('e2')])

    expectTypeOf(tupleResult).toEqualTypeOf<Result<[number, string], 'e1' | 'e2'>>()
    expectTypeOf(arrayResult).toEqualTypeOf<Result<readonly number[], 'arr'>>()
    expectTypeOf(recordResult).toEqualTypeOf<
      Result<{ readonly id: number; readonly name: string }, 'idErr' | 'nameErr'>
    >()
    deepEqual(tupleResult._unsafeUnwrap(), [1, 'two'])
    deepEqual(arrayResult._unsafeUnwrap(), [1, 2, 3])
    deepEqual(recordResult._unsafeUnwrap(), { id: 7, name: 'Ada' })
    equal(failedAll._unsafeUnwrapErr(), 'e2')
  })

  it('matches both branches with direct and curried object or callback handlers', () => {
    const success: Result<number, 'source'> = ok(2)
    const failure: Result<number, 'source'> = err('source')
    const handlers = { ok: (value: number) => value + 1, error: (error: 'source') => error }
    const direct = Result.match(success, { ok: (value) => value + 1, error: (error) => error })
    const curried = pipe(
      failure,
      Result.match({ ok: (value) => value + 1, error: (error) => error }),
    )
    const callbacks = pipe(
      success,
      Result.match(
        (value) => value + 1,
        (error) => error,
      ),
    )
    expectTypeOf(direct).toEqualTypeOf<number | 'source'>()
    expectTypeOf(curried).toEqualTypeOf<number | 'source'>()
    expectTypeOf(callbacks).toEqualTypeOf<number | 'source'>()
    equal(direct, 3)
    equal(curried, 'source')
    equal(callbacks, 3)
    equal(Result.match(failure, handlers.ok, handlers.error), 'source')
    equal(Result.match(handlers)(success), 3)
    equal(Result.match(handlers.ok, handlers.error)(failure), 'source')
  })

  it('supports static catchTag, catchTags, matchTags, and matchTagsPartial in direct and pipe forms', () => {
    class NotFoundError extends createTaggedError({
      name: 'NotFound',
      message: 'Missing $id',
    }).withProps<{ readonly id: string }>() {}
    class ForbiddenError extends createTaggedError({
      name: 'Forbidden',
      message: 'Denied $role',
    }).withProps<{ readonly role: string }>() {}
    type AppError = NotFoundError | ForbiddenError

    const failedNotFound: Result<number, AppError> = err(new NotFoundError({ id: 'u1' }))
    const failedForbidden: Result<number, AppError> = err(new ForbiddenError({ role: 'guest' }))

    const directCatchTag = Result.catchTag(failedNotFound, 'NotFound', (e) => ok(e.id.length))
    const pipedCatchTag = pipe(
      failedNotFound,
      Result.catchTag('NotFound', (e) => ok(e.id.length)),
    )
    const directCatchTags = Result.catchTags(failedForbidden, {
      Forbidden: (e) => ok(e.role.length),
    })
    const pipedCatchTags = pipe(
      failedForbidden,
      Result.catchTags({ Forbidden: (e) => ok(e.role.length) }),
    )

    expectTypeOf(directCatchTag).toEqualTypeOf<Result<number, ForbiddenError>>()
    expectTypeOf(pipedCatchTag).toEqualTypeOf<Result<number, ForbiddenError>>()
    expectTypeOf(directCatchTags).toEqualTypeOf<Result<number, NotFoundError>>()
    expectTypeOf(pipedCatchTags).toEqualTypeOf<Result<number, NotFoundError>>()
    equal(directCatchTag._unsafeUnwrap(), 2)
    equal(pipedCatchTag._unsafeUnwrap(), 2)
    equal(directCatchTags._unsafeUnwrap(), 5)
    equal(pipedCatchTags._unsafeUnwrap(), 5)

    const directMatched = Result.matchTags(failedNotFound, (n) => `ok:${n}` as const, {
      NotFound: (e) => `nf:${e.id}` as const,
      Forbidden: (e) => `fb:${e.role}` as const,
    })
    const pipedMatched = pipe(
      failedForbidden,
      Result.matchTags((n) => `ok:${n}` as const, {
        NotFound: (e) => `nf:${e.id}` as const,
        Forbidden: (e) => `fb:${e.role}` as const,
      }),
    )
    const directPartial = Result.matchTagsPartial(
      failedForbidden,
      (n) => `ok:${n}` as const,
      { NotFound: (e) => `nf:${e.id}` as const },
      (rest) => `rest:${rest.role}` as const,
    )
    const pipedPartial = pipe(
      failedNotFound,
      Result.matchTagsPartial(
        (n) => `ok:${n}` as const,
        { NotFound: (e) => `nf:${e.id}` as const },
        (rest) => `rest:${rest.role}` as const,
      ),
    )

    equal(directMatched, 'nf:u1')
    equal(pipedMatched, 'fb:guest')
    equal(directPartial, 'rest:guest')
    equal(pipedPartial, 'nf:u1')
  })

  it('narrows refined successes and keeps existing or validation failures', () => {
    const input: Result<string | number, 'source'> = ok('Ada')
    const isString = (value: string | number): value is string => typeof value === 'string'
    const direct = Result.filterOrElse(input, isString, () => 'validation' as const)
    const curried = pipe(
      input,
      Result.filterOrElse(isString, () => 'validation' as const),
      Result.map((value) => value.toUpperCase()),
    )
    const rejected: Result<string | number, 'source'> = ok(2)
    const existing: Result<string | number, 'source'> = err('source')
    const failedInputs: (string | number)[] = []
    const refined = Result.filterOrElse(isString, (value) => {
      failedInputs.push(value)
      return 'validation' as const
    })
    const boolean = input.pipe(
      Result.filterOrElse(
        (value) => {
          expectTypeOf(value).toEqualTypeOf<string | number>()
          return String(value).length > 0
        },
        () => 'empty' as const,
      ),
    )

    expectTypeOf(direct).toEqualTypeOf<Result<string, 'source' | 'validation'>>()
    expectTypeOf(curried).toEqualTypeOf<Result<string, 'source' | 'validation'>>()
    expectTypeOf(boolean).toEqualTypeOf<Result<string | number, 'source' | 'empty'>>()
    equal(direct._unsafeUnwrap(), 'Ada')
    equal(curried._unsafeUnwrap(), 'ADA')
    equal(refined(rejected)._unsafeUnwrapErr(), 'validation')
    equal(refined(existing)._unsafeUnwrapErr(), 'source')
    deepEqual(failedInputs, [2])
  })

  it('propagates active transform, chain, validation and match exceptions', () => {
    const defect = new Error('callback defect')
    const fail = (): never => {
      throw defect
    }
    const transforms = [
      () => Result.map(ok(1), fail),
      () => Result.mapErr(fail)(err('source')),
      () => Result.andThen(ok(1), fail),
      () => Result.orElse(fail)(err('source')),
      () => Result.filterOrElse(ok(1), fail, () => 'validation'),
      () => Result.filterOrElse(() => false, fail)(ok(1)),
      () => Result.match(ok(1), { ok: fail, error: fail }),
      () => Result.match(fail, fail)(err('source')),
    ]

    for (const transform of transforms) {
      throws(transform, (error) => error === defect)
    }
  })

  it('starts success async callbacks immediately and retains original error unions', async () => {
    let calls = 0
    const input: Result<number, 'source'> = ok(2)
    const chained = pipe(
      input,
      Result.asyncAndThen((value) => {
        calls += 1
        return ResultAsync.fromSafePromise(Promise.resolve(String(value)))
      }),
    )
    const mapped = Result.asyncMap(input, (value) => {
      calls += 1
      return Promise.resolve(value + 1)
    })
    const curriedMap = input.pipe(Result.asyncMap((value) => Promise.resolve(value + 1)))
    const directChain = Result.asyncAndThen(input, () => errAsync<never, 'async'>('async'))

    equal(calls, 2)
    expectTypeOf(chained).toEqualTypeOf<ResultAsync<string, 'source'>>()
    expectTypeOf(mapped).toEqualTypeOf<ResultAsync<number, 'source'>>()
    expectTypeOf(curriedMap).toEqualTypeOf<ResultAsync<number, 'source'>>()
    expectTypeOf(directChain).toEqualTypeOf<ResultAsync<never, 'source' | 'async'>>()
    equal((await chained)._unsafeUnwrap(), '2')
    equal((await mapped)._unsafeUnwrap(), 3)
    equal((await curriedMap)._unsafeUnwrap(), 3)
    equal((await directChain)._unsafeUnwrapErr(), 'async')
  })

  it('skips async callbacks on Err and keeps synchronous throws or Promise rejections', async () => {
    let calls = 0
    const input: Result<number, 'source'> = err('source')
    const mapped = Result.asyncMap(input, (value) => {
      calls += 1
      return Promise.resolve(value + 1)
    })
    const chained = Result.asyncAndThen((value: number) => {
      calls += 1
      return okAsync(value + 1)
    })(input)
    const defect = new Error('async callback defect')
    const fail = (): never => {
      throw defect
    }

    equal(calls, 0)
    equal((await mapped)._unsafeUnwrapErr(), 'source')
    equal((await chained)._unsafeUnwrapErr(), 'source')
    throws(
      () => Result.asyncMap(ok(1), fail),
      (error) => error === defect,
    )
    throws(
      () => Result.asyncAndThen(fail)(ok(1)),
      (error) => error === defect,
    )
    await rejects(
      Promise.resolve(Result.asyncMap(() => Promise.reject(defect))(ok(1))),
      (error) => error === defect,
    )
  })
})
