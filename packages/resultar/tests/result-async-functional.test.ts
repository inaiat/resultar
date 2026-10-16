import { describe, expect, expectTypeOf, it } from 'vite-plus/test'

import { pipe } from '../src/core/function.js'
import { ResultAsync, errAsync, okAsync } from '../src/task/result-async.js'
import { err, ok } from '../src/result.js'
import { createTaggedError } from '../src/tagged/tagged-error.js'

describe.each(['direct', 'curried'] as const)('ResultAsync functional operators: %s', (form) => {
  it('maps only success with synchronous mappers', async () => {
    const success = okAsync<number, 'source'>(2)
    const failure = errAsync<number, 'source'>('source')
    const mapper = (value: number) => String(value * 3)
    const map = ResultAsync.map
    const mapped = form === 'direct' ? map(success, mapper) : map(mapper)(success)
    const skipped = form === 'direct' ? map(failure, mapper) : map(mapper)(failure)

    expect(await mapped).toEqual(ok('6'))
    expect(await skipped).toEqual(err('source'))
    expectTypeOf(mapped).toEqualTypeOf<ResultAsync<string, 'source'>>()
  })

  it('maps only failure with synchronous error mappers', async () => {
    const success = okAsync<number, 'source'>(2)
    const failure = errAsync<number, 'source'>('source')
    const mapper = (error: 'source') => ({ source: error })
    const mapped =
      form === 'direct' ? ResultAsync.mapErr(failure, mapper) : ResultAsync.mapErr(mapper)(failure)
    const skipped =
      form === 'direct' ? ResultAsync.mapErr(success, mapper) : ResultAsync.mapErr(mapper)(success)

    expect(await mapped).toEqual(err({ source: 'source' }))
    expect(await skipped).toEqual(ok(2))
    expectTypeOf(mapped).toEqualTypeOf<ResultAsync<number, { source: 'source' }>>()
  })

  it('chains sync and async Results with precise error unions', async () => {
    const success = okAsync<number, 'source'>(2)
    const failure = errAsync<number, 'source'>('source')
    const next = (value: number) =>
      value > 0 ? ok<string, 'sync'>(String(value)) : errAsync<boolean, 'async'>('async')
    const mapped =
      form === 'direct' ? ResultAsync.andThen(success, next) : ResultAsync.andThen(next)(success)
    const skipped =
      form === 'direct' ? ResultAsync.andThen(failure, next) : ResultAsync.andThen(next)(failure)
    const asyncFailure =
      form === 'direct'
        ? ResultAsync.andThen(okAsync<number, 'source'>(0), next)
        : ResultAsync.andThen(next)(okAsync<number, 'source'>(0))

    expect(await mapped).toEqual(ok('2'))
    expect(await skipped).toEqual(err('source'))
    expect(await asyncFailure).toEqual(err('async'))
    expectTypeOf(mapped).toEqualTypeOf<ResultAsync<string | boolean, 'source' | 'sync' | 'async'>>()
  })

  it('recovers with sync and async Results while replacing the source error', async () => {
    const success = okAsync<number, 'source' | 'other'>(2)
    const failure = errAsync<number, 'source' | 'other'>('source')
    const recover = (error: 'source' | 'other') =>
      error === 'source' ? ok<string, 'sync'>('recovered') : errAsync<boolean, 'async'>('async')
    const recovered =
      form === 'direct'
        ? ResultAsync.orElse(failure, recover)
        : ResultAsync.orElse(recover)(failure)
    const skipped =
      form === 'direct'
        ? ResultAsync.orElse(success, recover)
        : ResultAsync.orElse(recover)(success)
    const asyncFailure =
      form === 'direct'
        ? ResultAsync.orElse(errAsync<number, 'source' | 'other'>('other'), recover)
        : ResultAsync.orElse(recover)(errAsync<number, 'source' | 'other'>('other'))

    expect(await recovered).toEqual(ok('recovered'))
    expect(await skipped).toEqual(ok(2))
    expect(await asyncFailure).toEqual(err('async'))
    expectTypeOf(recovered).toEqualTypeOf<
      ResultAsync<number | string | boolean, 'sync' | 'async'>
    >()
  })

  it('observes only success and ignores rejected observer promises', async () => {
    const success = okAsync<number, 'source'>(2)
    const failure = errAsync<number, 'source'>('source')
    const values: number[] = []
    const observer = (value: number): Promise<void> => {
      values.push(value)
      return Promise.reject(new Error('observer'))
    }
    const observed =
      form === 'direct'
        ? ResultAsync.inspect(success, observer)
        : ResultAsync.inspect(observer)(success)
    const skipped =
      form === 'direct'
        ? ResultAsync.inspect(failure, observer)
        : ResultAsync.inspect(observer)(failure)

    expect(await observed).toEqual(ok(2))
    expect(await skipped).toEqual(err('source'))
    expect(values).toEqual([2])
    expectTypeOf(observed).toEqualTypeOf<ResultAsync<number, 'source'>>()
  })

  it('observes only failure and ignores thrown observer errors', async () => {
    const success = okAsync<number, 'source'>(2)
    const failure = errAsync<number, 'source'>('source')
    const errors: string[] = []
    const observer = (error: 'source'): void => {
      errors.push(error)
      throw new Error('observer')
    }
    const observed =
      form === 'direct'
        ? ResultAsync.inspectError(failure, observer)
        : ResultAsync.inspectError(observer)(failure)
    const skipped =
      form === 'direct'
        ? ResultAsync.inspectError(success, observer)
        : ResultAsync.inspectError(observer)(success)

    expect(await observed).toEqual(err('source'))
    expect(await skipped).toEqual(ok(2))
    expect(errors).toEqual(['source'])
    expectTypeOf(observed).toEqualTypeOf<ResultAsync<number, 'source'>>()
  })

  it('observes both branches with inspectBoth in object and positional forms', async () => {
    const success = okAsync<number, 'source'>(2)
    const failure = errAsync<number, 'source'>('source')
    const events: string[] = []
    const handlers = {
      ok: async (value: number) => {
        events.push(`ok:${value}`)
        throw new Error('observer')
      },
      error: (error: 'source') => {
        events.push(`err:${error}`)
        throw new Error('observer')
      },
    }
    const observedObjectOk =
      form === 'direct'
        ? ResultAsync.inspectBoth(success, handlers)
        : ResultAsync.inspectBoth(handlers)(success)
    const observedObjectErr =
      form === 'direct'
        ? ResultAsync.inspectBoth(failure, handlers)
        : ResultAsync.inspectBoth(handlers)(failure)
    const observedCallbacksOk =
      form === 'direct'
        ? ResultAsync.inspectBoth(success, handlers.ok, handlers.error)
        : ResultAsync.inspectBoth(handlers.ok, handlers.error)(success)
    const observedCallbacksErr =
      form === 'direct'
        ? ResultAsync.inspectBoth(failure, handlers.ok, handlers.error)
        : ResultAsync.inspectBoth(handlers.ok, handlers.error)(failure)

    expect(await observedObjectOk).toEqual(ok(2))
    expect(await observedObjectErr).toEqual(err('source'))
    expect(await observedCallbacksOk).toEqual(ok(2))
    expect(await observedCallbacksErr).toEqual(err('source'))
    expect(await success.inspectBoth(handlers)).toEqual(ok(2))
    expect(await failure.inspectBoth(handlers.ok, handlers.error)).toEqual(err('source'))
    expect(() =>
      (success as unknown as { inspectBoth: (f: () => void) => void }).inspectBoth(() => undefined),
    ).toThrow('ResultTask.inspectBoth requires an error handler')
    expect(events).toEqual(['ok:2', 'err:source', 'ok:2', 'err:source', 'ok:2', 'err:source'])
    expectTypeOf(observedObjectOk).toEqualTypeOf<ResultAsync<number, 'source'>>()
    expectTypeOf(observedCallbacksErr).toEqualTypeOf<ResultAsync<number, 'source'>>()
  })

  it('combines tuples, arrays, and records via ResultAsync.all', async () => {
    const tupleResult = ResultAsync.all([okAsync<number, 'e1'>(1), okAsync<string, 'e2'>('two')])
    const arrayInput: readonly ResultAsync<number, 'arr'>[] = [okAsync(1), okAsync(2)]
    const arrayResult = ResultAsync.all(arrayInput)
    const recordResult = ResultAsync.all({
      id: okAsync<number, 'idErr'>(7),
      name: okAsync<string, 'nameErr'>('Ada'),
    })
    const failedAll = ResultAsync.all([okAsync<number, 'e1'>(1), errAsync<string, 'e2'>('e2')])

    expectTypeOf(tupleResult).toEqualTypeOf<ResultAsync<[number, string], 'e1' | 'e2'>>()
    expectTypeOf(arrayResult).toEqualTypeOf<ResultAsync<readonly number[], 'arr'>>()
    expectTypeOf(recordResult).toEqualTypeOf<
      ResultAsync<{ readonly id: number; readonly name: string }, 'idErr' | 'nameErr'>
    >()
    expect(await tupleResult).toEqual(ok([1, 'two']))
    expect(await arrayResult).toEqual(ok([1, 2]))
    expect(await recordResult).toEqual(ok({ id: 7, name: 'Ada' }))
    expect(await failedAll).toEqual(err('e2'))
  })

  it('matches both variants with object handlers', async () => {
    const success = okAsync<number, 'source'>(2)
    const failure = errAsync<number, 'source'>('source')
    const handlers = { ok: String, error: (_error: 'source') => false as const }
    const matched =
      form === 'direct'
        ? ResultAsync.match(success, handlers)
        : ResultAsync.match(handlers)(success)
    const rejected =
      form === 'direct'
        ? ResultAsync.match(failure, handlers)
        : ResultAsync.match(handlers)(failure)

    expect(await matched).toEqual(ok('2'))
    expect(await rejected).toEqual(ok(false))
    expectTypeOf(matched).toEqualTypeOf<ResultAsync<string | false, never>>()
  })

  it('matches both variants with positional handlers', async () => {
    const success = okAsync<number, 'source'>(2)
    const failure = errAsync<number, 'source'>('source')
    const onOk = String
    const onErr = (error: 'source') => error
    const matched =
      form === 'direct'
        ? ResultAsync.match(success, onOk, onErr)
        : ResultAsync.match(onOk, onErr)(success)
    const rejected =
      form === 'direct'
        ? ResultAsync.match(failure, onOk, onErr)
        : ResultAsync.match(onOk, onErr)(failure)

    expect(await matched).toEqual(ok('2'))
    expect(await rejected).toEqual(ok('source'))
    expectTypeOf(matched).toEqualTypeOf<ResultAsync<string, never>>()
  })

  it('replaces only success, preserving constants without executing or unwrapping them', async () => {
    const success = okAsync<number, 'source'>(2)
    const failure = errAsync<number, 'source'>('source')
    const value = okAsync('constant')
    const replaced =
      form === 'direct' ? ResultAsync.as(success, value) : ResultAsync.as(value)(success)
    const skipped =
      form === 'direct' ? ResultAsync.as(failure, value) : ResultAsync.as(value)(failure)

    expect((await replaced)._unsafeUnwrap()).toBe(value)
    expect(await skipped).toEqual(err('source'))
    expectTypeOf(replaced).toEqualTypeOf<ResultAsync<ResultAsync<string, never>, 'source'>>()
  })

  it('filters with synchronous predicates and error factories', async () => {
    const success = okAsync<number, 'source'>(2)
    const failure = errAsync<number, 'source'>('source')
    const predicate = (value: number) => value > 1
    const onFalse = (value: number) => ({ rejected: value })
    const kept =
      form === 'direct'
        ? ResultAsync.filterOrElse(success, predicate, onFalse)
        : ResultAsync.filterOrElse(predicate, onFalse)(success)
    const skipped =
      form === 'direct'
        ? ResultAsync.filterOrElse(failure, predicate, onFalse)
        : ResultAsync.filterOrElse(predicate, onFalse)(failure)
    const filtered =
      form === 'direct'
        ? ResultAsync.filterOrElse(okAsync<number, 'source'>(0), predicate, onFalse)
        : ResultAsync.filterOrElse(predicate, onFalse)(okAsync<number, 'source'>(0))

    expect(await kept).toEqual(ok(2))
    expect(await skipped).toEqual(err('source'))
    expect(await filtered).toEqual(err({ rejected: 0 }))
    expectTypeOf(kept).toEqualTypeOf<ResultAsync<number, 'source' | { rejected: number }>>()
  })

  it('narrows success with a refinement without widening errors', async () => {
    const value = okAsync<string | number, 'source'>('hello')
    const predicate = (input: string | number): input is string => typeof input === 'string'
    const onFalse = (_input: string | number) => 'invalid' as const
    const narrowed =
      form === 'direct'
        ? ResultAsync.filterOrElse(value, predicate, onFalse)
        : ResultAsync.filterOrElse(predicate, onFalse)(value)

    expect(await narrowed).toEqual(ok('hello'))
    expectTypeOf(narrowed).toEqualTypeOf<ResultAsync<string, 'source' | 'invalid'>>()
  })

  it('supports static catchTag, catchTags, matchTags, and matchTagsPartial', async () => {
    class NotFoundError extends createTaggedError({
      name: 'NotFoundError',
      message: 'Missing $id',
    }).withProps<{ readonly id: string }>() {}
    class TimeoutError extends createTaggedError({
      name: 'TimeoutError',
      message: 'Timed out after $ms',
    }).withProps<{ readonly ms: number }>() {}

    const source = errAsync<number, NotFoundError | TimeoutError>(
      new NotFoundError({ id: 'missing' }),
    )

    const caughtSingle =
      form === 'direct'
        ? ResultAsync.catchTag(source, 'NotFoundError', (error) => ok(error.id.length))
        : source.pipe(ResultAsync.catchTag('NotFoundError', (error) => ok(error.id.length)))

    const caughtAll =
      form === 'direct'
        ? ResultAsync.catchTags(source, {
            NotFoundError: (error) => ok(error.id.length),
            TimeoutError: (error) => okAsync(error.ms),
          })
        : source.pipe(
            ResultAsync.catchTags({
              NotFoundError: (error) => ok(error.id.length),
              TimeoutError: (error) => okAsync(error.ms),
            }),
          )

    const matchedAll =
      form === 'direct'
        ? ResultAsync.matchTags(source, (value) => `ok:${value}`, {
            NotFoundError: (error) => `nf:${error.id}`,
            TimeoutError: (error) => `to:${error.ms}`,
          })
        : source.pipe(
            ResultAsync.matchTags((value) => `ok:${value}`, {
              NotFoundError: (error) => `nf:${error.id}`,
              TimeoutError: (error) => `to:${error.ms}`,
            }),
          )

    const matchedPartial =
      form === 'direct'
        ? ResultAsync.matchTagsPartial(
            source,
            (value) => `ok:${value}`,
            { NotFoundError: (error) => `nf:${error.id}` },
            (remaining) => `other:${remaining._tag}`,
          )
        : source.pipe(
            ResultAsync.matchTagsPartial(
              (value) => `ok:${value}`,
              { NotFoundError: (error) => `nf:${error.id}` },
              (remaining) => `other:${remaining._tag}`,
            ),
          )

    expect(await caughtSingle).toEqual(ok(7))
    expect(await caughtAll).toEqual(ok(7))
    expect(await matchedAll).toEqual(ok('nf:missing'))
    expect(await matchedPartial).toEqual(ok('nf:missing'))
    expectTypeOf(caughtSingle).toEqualTypeOf<ResultAsync<number, TimeoutError>>()
    expectTypeOf(caughtAll).toEqualTypeOf<ResultAsync<number, never>>()
    expectTypeOf(matchedAll).toEqualTypeOf<ResultAsync<string, never>>()
    expectTypeOf(matchedPartial).toEqualTypeOf<ResultAsync<string, never>>()
  })

  it('supports static orElseSucceed, catchReason, catchReasons, and unwrapReason', async () => {
    class RateLimitError extends createTaggedError({
      name: 'RateLimitError',
      message: 'Retry in $seconds',
    }).withProps<{ readonly seconds: number }>() {}
    class TimeoutReason extends createTaggedError({
      name: 'TimeoutReason',
      message: 'Timed out after $ms',
    }).withProps<{ readonly ms: number }>() {}
    class AiError extends createTaggedError({
      name: 'AiError',
      message: 'AI call failed',
    }).withProps<{ readonly reason: RateLimitError | TimeoutReason }>() {}
    class OtherError extends createTaggedError({ name: 'OtherError', message: 'Other failure' }) {}

    const source = errAsync<number, AiError | OtherError>(
      new AiError({ reason: new RateLimitError({ seconds: 5 }) }),
    )

    const succeeded =
      form === 'direct'
        ? ResultAsync.orElseSucceed(source, (error) => error._tag.length)
        : source.pipe(ResultAsync.orElseSucceed((error) => error._tag.length))

    const caughtSingleReason =
      form === 'direct'
        ? ResultAsync.catchReason(source, 'AiError', 'RateLimitError', (reason) =>
            ok(reason.seconds),
          )
        : source.pipe(
            ResultAsync.catchReason('AiError', 'RateLimitError', (reason) =>
              okAsync(reason.seconds),
            ),
          )

    const caughtReasons =
      form === 'direct'
        ? ResultAsync.catchReasons(source, 'AiError', {
            RateLimitError: (reason) => ok(reason.seconds),
            TimeoutReason: (reason) => okAsync(reason.ms),
          })
        : source.pipe(
            ResultAsync.catchReasons('AiError', {
              RateLimitError: (reason) => ok(reason.seconds),
              TimeoutReason: (reason) => okAsync(reason.ms),
            }),
          )

    const unwrappedReason =
      form === 'direct'
        ? ResultAsync.unwrapReason(source, 'AiError')
        : source.pipe(ResultAsync.unwrapReason('AiError'))

    expect(await succeeded).toEqual(ok(7))
    expect(await caughtSingleReason).toEqual(ok(5))
    expect(await caughtReasons).toEqual(ok(5))
    expect(await unwrappedReason).toEqual(err(new RateLimitError({ seconds: 5 })))
  })
})

describe('ResultAsync functional inference and lazy composition', () => {
  it('infers inline callbacks through instance and root pipe', async () => {
    const source = okAsync<number, 'source'>(2)
    const transformed = source.pipe(
      ResultAsync.map((value) => {
        expectTypeOf(value).toEqualTypeOf<number>()
        return String(value)
      }),
      ResultAsync.andThen((value) => {
        expectTypeOf(value).toEqualTypeOf<string>()
        return ok<boolean, 'next'>(value.length > 0)
      }),
      ResultAsync.mapErr((error) => {
        expectTypeOf(error).toEqualTypeOf<'source' | 'next'>()
        return { error }
      }),
      ResultAsync.orElse((error) => {
        expectTypeOf(error).toEqualTypeOf<{ error: 'source' | 'next' }>()
        return okAsync<number, 'recovery'>(error.error.length)
      }),
    )
    const matched = pipe(
      transformed,
      ResultAsync.match({
        ok: (value) => {
          expectTypeOf(value).toEqualTypeOf<number | boolean>()
          return String(value)
        },
        error: (error) => {
          expectTypeOf(error).toEqualTypeOf<'recovery'>()
          return false as const
        },
      }),
    )

    expectTypeOf(transformed).toEqualTypeOf<ResultAsync<number | boolean, 'recovery'>>()
    expectTypeOf(matched).toEqualTypeOf<ResultAsync<string | false, never>>()
    expect(await matched).toEqual(ok('true'))
  })

  it('infers inline observer and predicate arguments in a pipeline', async () => {
    const result = okAsync<string | number, 'source'>('hello').pipe(
      ResultAsync.inspect((value) => {
        expectTypeOf(value).toEqualTypeOf<string | number>()
      }),
      ResultAsync.inspectError((error) => {
        expectTypeOf(error).toEqualTypeOf<'source'>()
      }),
      ResultAsync.filterOrElse(
        (value): value is string => typeof value === 'string',
        (value) => {
          expectTypeOf(value).toEqualTypeOf<string | number>()
          return 'invalid' as const
        },
      ),
      ResultAsync.as(42 as const),
    )

    expectTypeOf(result).toEqualTypeOf<ResultAsync<42, 'source' | 'invalid'>>()
    expect(await result).toEqual(ok(42))
  })

  it('defers composed callbacks until the ResultAsync is awaited or run', async () => {
    const values: number[] = []
    const result = okAsync(2).pipe(
      ResultAsync.map((value) => {
        values.push(value)
        return value + 1
      }),
    )

    await Promise.resolve()
    expect(values).toEqual([])
    expect(await result).toEqual(ok(3))
    expect(values).toEqual([2])
  })

  it('leaves callback defects outside the typed error channel', async () => {
    const defect = new Error('mapper defect')
    const mapDefect = ResultAsync.map(okAsync(2), () => {
      throw defect
    })
    const errorMapDefect = errAsync('source').pipe(
      ResultAsync.mapErr(() => {
        throw defect
      }),
    )
    const chainDefect = ResultAsync.andThen(okAsync(2), () => {
      throw defect
    })
    const recoveryDefect = ResultAsync.orElse(errAsync('source'), () => {
      throw defect
    })
    const predicateDefect = ResultAsync.filterOrElse(
      okAsync(2),
      () => {
        throw defect
      },
      () => 'invalid',
    )
    const matchDefect = ResultAsync.match(okAsync(2), {
      ok: () => {
        throw defect
      },
      error: () => 'source',
    })

    await Promise.all(
      [mapDefect, errorMapDefect, chainDefect, recoveryDefect, predicateDefect, matchDefect].map(
        async (result) => {
          await expect(Promise.resolve(result)).rejects.toBe(defect)
        },
      ),
    )
  })

  it('supports curried Result.when/unless, ResultAsync.when/unless, and ResultAsync.fromTask', async () => {
    const { Result, ResultTask } = await import('../src/index.js')

    expect(Result.when(true)(() => ok(42))).toEqual(ok(42))
    expect(Result.when(false)(() => ok(42))).toEqual(ok(undefined))
    expect(Result.unless(false)(() => ok(42))).toEqual(ok(42))
    expect(Result.unless(true)(() => ok(42))).toEqual(ok(undefined))

    expect(await ResultAsync.when(true)(() => okAsync(42))).toEqual(ok(42))
    expect(await ResultAsync.when(false)(() => okAsync(42))).toEqual(ok(undefined))
    expect(await ResultAsync.unless(false)(() => okAsync(42))).toEqual(ok(42))
    expect(await ResultAsync.unless(true)(() => okAsync(42))).toEqual(ok(undefined))

    // eslint-disable-next-line @typescript-eslint/no-deprecated
    expect(await ResultAsync.fromTask(ResultTask.ok(99))).toEqual(ok(99))
  })
})
