import { deepEqual, equal, ok as isTrue, rejects, throws } from 'node:assert'
import { describe, expect, it } from 'vite-plus/test'

import { createResultarError } from '../src/core/error.js'
import type { Fiber as FiberType, Result, TaggedEnum } from '../src/index.js'
import * as resultar from '../src/index.js'
import { Fiber, ResultTask, Semaphore, err } from '../src/index.js'
import { FiberSignal, NEVER_ABORTED_SIGNAL } from '../src/task/exit.js'
import { registerFiberTaskFactory, startFiber } from '../src/task/fiber-runtime.js'
import { MissingServiceError, ResultTaskYieldTypeId } from '../src/task/result-task.js'
import { TaskScope } from '../src/task/scope.js'
import { schedulerCheckpoint } from '../src/task/task-scheduler.js'
import type * as ResultAsyncAdapter from '../src/resultar-async/result-async-adapter.js'

const resultAsyncForEach: typeof resultar.ResultAsync.forEach = resultar.ResultAsync.forEach

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const delayedOkTask =
  <T, E = never>(value: T, delayMs: number): resultar.ResultAsyncRaceTask<T, E> =>
  () =>
    new resultar.ResultAsync<T, E>(
      Promise.try(async () => {
        await sleep(delayMs)

        return resultar.ok<T, E>(value)
      }),
    )

const CoverageReason = resultar.taggedEnum<{
  Primary: { readonly code: string }
  Secondary: { readonly code: string }
}>()

type CoverageReason = TaggedEnum<{
  Primary: { readonly code: string }
  Secondary: { readonly code: string }
}>

class CoverageParentError extends resultar.createTaggedError({
  message: 'parent failed',
  name: 'CoverageParentError',
}) {
  public readonly reason: CoverageReason

  public constructor(reason: CoverageReason) {
    super()
    this.reason = reason
  }
}

class CoverageOtherError extends resultar.createTaggedError({
  message: 'other failed',
  name: 'CoverageOtherError',
}) {}

class CoverageTaggedFailure extends resultar.createTaggedError({
  message: 'Tagged $id failed',
  name: 'TaggedFailure',
}) {}

class CoverageOtherTaggedFailure extends resultar.createTaggedError({
  message: 'Other tagged failure',
  name: 'OtherTaggedFailure',
}) {}

class CoverageObjectTemplateFailure extends resultar.createTaggedError({
  message: 'Object $value failed',
  name: 'ObjectTemplateFailure',
}) {}

describe('coverage-focused public behavior', () => {
  it('covers ResultarError payload branches and stack config', () => {
    const okResult = resultar.ok('value')
    const errResult = resultar.err('failure')

    const okError = createResultarError('ok message', okResult, { withStackTrace: true })
    const errError = createResultarError('err message', errResult)

    deepEqual(okError.data, { type: 'Ok', value: 'value' })
    equal(typeof okError.stack, 'string')
    deepEqual(errError.data, { type: 'Err', value: 'failure' })
    equal('stack' in errError, false)
    equal(errError.stack, undefined)
    equal({} instanceof resultar.Result, false)
  })

  it('covers Result error paths, iterators, and disposable delegation', () => {
    const errResult = resultar.err<string, string>('failure')
    const iterator = errResult[Symbol.iterator]()
    const yielded = iterator.next()

    isTrue(!yielded.done)
    equal(yielded.value, errResult)
    deepEqual(iterator.next(), { done: true, value: errResult })

    const safeUnwrapIterator = errResult.safeUnwrap()
    const safeYielded = safeUnwrapIterator.next()

    isTrue(!safeYielded.done)
    deepEqual(safeYielded.value, resultar.err('failure'))
    throws(() => safeUnwrapIterator.next(), /Do not use this generator/u)

    const ifResult = errResult
      .if(() => true)
      .true(() => resultar.ok('yes'))
      .false(() => resultar.ok('no'))

    equal(ifResult._unsafeUnwrapErr(), 'failure')
    const okTapError = resultar.ok('value').tapError(() => {
      throw new Error('should not run')
    })

    equal(okTapError._unsafeUnwrap(), 'value')
    throws(
      () => resultar.ok('value')._unsafeUnwrapErr({ withStackTrace: true }),
      (error) => {
        isTrue(error instanceof Error || typeof error === 'object')
        isTrue(error !== null)
        return (
          'message' in error &&
          error.message === 'Called `_unsafeUnwrapErr` on an Ok' &&
          'stack' in error &&
          typeof error.stack === 'string'
        )
      },
    )

    const disposable = resultar.ok('value').toDisposable(() => undefined)
    const errDisposable = resultar.err<string, string>('failure').toDisposable(() => undefined)

    equal(disposable.value, 'value')
    equal(disposable.error, undefined)
    equal(disposable._unsafeUnwrap(), 'value')
    equal(disposable.unwrapOr('fallback'), 'value')
    equal(errDisposable.value, undefined)
    equal(errDisposable.error, 'failure')
    equal(errDisposable._unsafeUnwrapErr(), 'failure')
    equal(errDisposable.unwrapOr('fallback'), 'fallback')
    equal(disposable.isOk(), true)
    equal(disposable.isErr(), false)
    equal(errDisposable.isOk(), false)
    equal(errDisposable.isErr(), true)
  })

  it('covers disposable finalizer branches', () => {
    const finalized: unknown[] = []
    const disposable = resultar.ok('value').toDisposable((value, error) => {
      finalized.push([value, error])
    })
    const errDisposable = resultar.err<string, string>('failure').toDisposable((value, error) => {
      finalized.push([value, error])
    })

    disposable[Symbol.dispose]()
    disposable[Symbol.dispose]()
    errDisposable[Symbol.dispose]()

    deepEqual(finalized, [
      ['value', undefined],
      [undefined, 'failure'],
    ])
  })

  it('covers Result predicate, match, and throw branches', () => {
    const original = new Error('original')
    const mapped = resultar.tryResult(
      () => {
        throw original
      },
      (error) => new Error(`mapped: ${(error as Error).message}`),
    )
    const unmapped = resultar.tryResult(() => {
      throw original
    })

    equal(mapped._unsafeUnwrapErr().message, 'mapped: original')
    equal(unmapped._unsafeUnwrapErr(), original)
    equal(
      resultar
        .ok<number, string>(1)
        .filterOrElse(
          (value) => value > 0,
          () => 'invalid',
        )
        ._unsafeUnwrap(),
      1,
    )
    equal(
      resultar
        .ok<number, string>(0)
        .filterOrElse(
          (value) => value > 0,
          () => 'invalid',
        )
        ._unsafeUnwrapErr(),
      'invalid',
    )
    equal(
      resultar
        .err<number, string>('failure')
        .filterOrElse(() => true, String)
        ._unsafeUnwrapErr(),
      'failure',
    )
    equal(
      resultar.ok('value').matchTags((value) => value, {}),
      'value',
    )
    throws(
      () =>
        (
          resultar.err<string, string>('failure').match as unknown as (
            fnOk: (value: string) => string,
          ) => string
        )((value) => value),
      /Result\.match requires an error handler/u,
    )
    throws(
      () =>
        resultar.err<string, Error>(new Error('missing handler')).matchTags(String, {} as never),
      /missing handler/u,
    )
  })

  it('covers ResultAsync error paths and async iterators', async () => {
    const ifResult = await resultar
      .errAsync<string, string>('async failure')
      .if(() => true)
      .true(() => resultar.okAsync('yes'))
      .false(() => resultar.okAsync('no'))

    equal(ifResult._unsafeUnwrapErr(), 'async failure')

    const okTapError = await resultar.okAsync('value').tapError(() => {
      throw new Error('should not run')
    })

    equal(okTapError._unsafeUnwrap(), 'value')

    const asyncIterator = resultar.errAsync<string, string>('async failure')[Symbol.asyncIterator]()
    const yielded = await asyncIterator.next()

    isTrue(!yielded.done)
    equal(yielded.value._unsafeUnwrapErr(), 'async failure')
    deepEqual(await asyncIterator.next(), { done: true, value: undefined })

    await rejects(
      async () => await resultar.errAsync<never, Error>(new Error('boom')).unwrapOrThrow(),
      /boom/u,
    )
  })

  it('covers ResultAsync predicate, match, and throw branches', async () => {
    const original = new Error('original')
    const unmapped = await resultar.tryResultAsync(Promise.reject(original))
    const falsePredicate = await resultar.okAsync<number, string>(0).filterOrElse(
      async (value) => value > 0,
      async () => 'invalid',
    )
    const truePredicate = await resultar.okAsync<number, string>(1).filterOrElse(
      async (value) => value > 0,
      async () => 'invalid',
    )
    const errPredicate = await resultar.errAsync<number, string>('failure').filterOrElse(
      async () => true,
      async () => 'invalid',
    )

    equal(unmapped._unsafeUnwrapErr(), original)
    equal(falsePredicate._unsafeUnwrapErr(), 'invalid')
    equal(truePredicate._unsafeUnwrap(), 1)
    equal(errPredicate._unsafeUnwrapErr(), 'failure')
    await rejects(
      async () =>
        await (
          resultar.errAsync<string, string>('failure').match as unknown as (
            fnOk: (value: string) => string,
          ) => Promise<string>
        )((value) => value),
      /Result\.match requires an error handler/u,
    )
    await rejects(
      async () =>
        await resultar
          .errAsync<string, Error>(new Error('missing async handler'))
          .matchTags(String, {} as never),
      /missing async handler/u,
    )
  })

  it('covers record and iterable aggregation branches', async () => {
    const recordFirstError = resultar.Result.combine({
      first: resultar.ok<number, 'first-error'>(1),
      second: resultar.err<number, 'second-error'>('second-error'),
    })
    const recordAllOk = resultar.Result.combineWithAllErrors({
      first: resultar.ok<number, 'first-error'>(1),
      second: resultar.ok<number, 'second-error'>(2),
    })
    const iterableAllErrors = resultar.Result.combineWithAllErrors(
      new Set([resultar.ok<number, string>(1), resultar.err<number, string>('bad')]),
    )
    const primitiveStringRecord = (
      resultar.Result.combineWithAllErrors as (
        input: unknown,
      ) => Result<Record<string, unknown>, unknown>
    )('')
    const asyncRecordAllOk = await resultar.ResultAsync.combineWithAllErrors({
      first: resultar.okAsync<number, 'first-error'>(1),
      second: resultar.okAsync<number, 'second-error'>(2),
    })
    const asyncRecordAllErrors = await resultar.ResultAsync.combineWithAllErrors({
      first: resultar.errAsync<number, 'first-error'>('first-error'),
      second: resultar.okAsync<number, 'second-error'>(2),
    })
    const asyncIterableCombined = await resultar.ResultAsync.combine(
      new Set([resultar.okAsync<number, string>(1), resultar.okAsync<number, string>(2)]),
    )
    const asyncIterableAllErrors = await resultar.ResultAsync.combineWithAllErrors(
      new Set([resultar.okAsync<number, string>(1), resultar.errAsync<number, string>('bad')]),
    )

    equal(recordFirstError._unsafeUnwrapErr(), 'second-error')
    deepEqual(recordAllOk._unsafeUnwrap(), { first: 1, second: 2 })
    deepEqual(iterableAllErrors._unsafeUnwrapErr(), ['bad'])
    deepEqual(primitiveStringRecord._unsafeUnwrap(), {})
    deepEqual(asyncRecordAllOk._unsafeUnwrap(), { first: 1, second: 2 })
    deepEqual(asyncRecordAllErrors._unsafeUnwrapErr(), ['first-error'])
    deepEqual(asyncIterableCombined._unsafeUnwrap(), [1, 2])
    deepEqual(asyncIterableAllErrors._unsafeUnwrapErr(), ['bad'])
  })

  it('covers static tryCatch branches', async () => {
    const original = new Error('original')
    const mapped = resultar.Result.tryCatch(
      () => {
        throw original
      },
      (error) => new Error(`mapped ${(error as Error).message}`),
    )
    const unmapped = resultar.Result.tryCatch(() => {
      throw original
    })
    const asyncMapped = await resultar.ResultAsync.tryCatch(
      () => Promise.reject(original),
      (error) => new Error(`async mapped ${(error as Error).message}`),
    )
    const asyncUnmapped = await resultar.ResultAsync.tryCatch(Promise.reject(original))
    const asyncFactoryOk = await resultar.ResultAsync.tryCatch(() => Promise.resolve('ok'))

    equal(mapped._unsafeUnwrapErr().message, 'mapped original')
    equal(unmapped._unsafeUnwrapErr(), original)
    equal(asyncMapped._unsafeUnwrapErr().message, 'async mapped original')
    equal(asyncUnmapped._unsafeUnwrapErr(), original)
    equal(asyncFactoryOk._unsafeUnwrap(), 'ok')
  })

  it('covers sync reason-aware ok and non-matching branches', () => {
    const okReason = resultar
      .ok<number, CoverageParentError>(1)
      .catchReason('CoverageParentError', 'Primary', () => resultar.ok('unused'))
    const okReasons = resultar
      .ok<number, CoverageParentError>(1)
      .catchReasons('CoverageParentError', { Primary: () => resultar.ok('unused') })
    const okUnwrap = resultar.ok<number, CoverageParentError>(1).unwrapReason('CoverageParentError')
    const wrongParent = resultar
      .err<number, CoverageParentError | CoverageOtherError>(new CoverageOtherError())
      .catchReason('CoverageParentError', 'Primary', () => resultar.ok('unused'))
    const wrongParentWithReason = new CoverageOtherError() as CoverageOtherError & {
      readonly reason: CoverageReason
    }

    Object.defineProperty(wrongParentWithReason, 'reason', {
      configurable: true,
      value: CoverageReason.Primary({ code: 'spoofed-parent' }),
    })

    const wrongParentWithMatchingReason = resultar
      .err<number, CoverageParentError | CoverageOtherError>(wrongParentWithReason)
      .catchReason('CoverageParentError', 'Primary', () => resultar.ok('bad parent'))
    const wrongReason = resultar
      .err<number, CoverageParentError | CoverageOtherError>(
        new CoverageParentError(CoverageReason.Secondary({ code: 's' })),
      )
      .catchReason('CoverageParentError', 'Primary', () => resultar.ok('unused'))
    const missingReasonHandler = resultar
      .err<number, CoverageParentError | CoverageOtherError>(
        new CoverageParentError(CoverageReason.Secondary({ code: 's' })),
      )
      .catchReasons('CoverageParentError', { Primary: () => resultar.ok('unused') })
    const wrongParentWithMatchingReasonHandler = resultar
      .err<number, CoverageParentError | CoverageOtherError>(wrongParentWithReason)
      .catchReasons('CoverageParentError', { Primary: () => resultar.ok('bad parent') })
    const primitiveReason = resultar
      .err<number, CoverageParentError | CoverageOtherError>(
        new CoverageParentError('primitive' as unknown as CoverageReason),
      )
      .catchReasons('CoverageParentError', { Primary: () => resultar.ok('unused') })
    const nullReason = resultar
      .err<number, CoverageParentError | CoverageOtherError>(
        new CoverageParentError(null as unknown as CoverageReason),
      )
      .catchReasons('CoverageParentError', { Primary: () => resultar.ok('unused') })
    const wrongUnwrap = resultar
      .err<number, CoverageParentError | CoverageOtherError>(new CoverageOtherError())
      .unwrapReason('CoverageParentError')

    equal(okReason._unsafeUnwrap(), 1)
    equal(okReasons._unsafeUnwrap(), 1)
    equal(okUnwrap._unsafeUnwrap(), 1)
    isTrue(wrongParent._unsafeUnwrapErr() instanceof CoverageOtherError)
    isTrue(wrongParentWithMatchingReason._unsafeUnwrapErr() instanceof CoverageOtherError)
    isTrue(wrongReason._unsafeUnwrapErr() instanceof CoverageParentError)
    isTrue(missingReasonHandler._unsafeUnwrapErr() instanceof CoverageParentError)
    isTrue(wrongParentWithMatchingReasonHandler._unsafeUnwrapErr() instanceof CoverageOtherError)
    isTrue(primitiveReason._unsafeUnwrapErr() instanceof CoverageParentError)
    isTrue(nullReason._unsafeUnwrapErr() instanceof CoverageParentError)
    isTrue(wrongUnwrap._unsafeUnwrapErr() instanceof CoverageOtherError)
  })

  it('covers async reason-aware ok and non-matching branches', async () => {
    const asyncOkReason = await resultar
      .okAsync<number, CoverageParentError>(1)
      .catchReason('CoverageParentError', 'Primary', () => resultar.okAsync('unused'))
    const asyncOkReasons = await resultar
      .okAsync<number, CoverageParentError>(1)
      .catchReasons('CoverageParentError', { Primary: () => resultar.okAsync('unused') })
    const asyncOkUnwrap = await resultar
      .okAsync<number, CoverageParentError>(1)
      .unwrapReason('CoverageParentError')
    const asyncWrongParent = await resultar
      .errAsync<number, CoverageParentError | CoverageOtherError>(new CoverageOtherError())
      .catchReason('CoverageParentError', 'Primary', () => resultar.okAsync('unused'))
    const asyncWrongReason = await resultar
      .errAsync<number, CoverageParentError | CoverageOtherError>(
        new CoverageParentError(CoverageReason.Secondary({ code: 's' })),
      )
      .catchReason('CoverageParentError', 'Primary', () => resultar.okAsync('unused'))
    const asyncMissingReasonHandler = await resultar
      .errAsync<number, CoverageParentError | CoverageOtherError>(
        new CoverageParentError(CoverageReason.Secondary({ code: 's' })),
      )
      .catchReasons('CoverageParentError', { Primary: () => resultar.okAsync('unused') })
    const asyncPrimitiveReason = await resultar
      .errAsync<number, CoverageParentError | CoverageOtherError>(
        new CoverageParentError('primitive' as unknown as CoverageReason),
      )
      .catchReasons('CoverageParentError', { Primary: () => resultar.okAsync('unused') })
    const asyncWrongUnwrap = await resultar
      .errAsync<number, CoverageParentError | CoverageOtherError>(new CoverageOtherError())
      .unwrapReason('CoverageParentError')

    equal(asyncOkReason._unsafeUnwrap(), 1)
    equal(asyncOkReasons._unsafeUnwrap(), 1)
    equal(asyncOkUnwrap._unsafeUnwrap(), 1)
    isTrue(asyncWrongParent._unsafeUnwrapErr() instanceof CoverageOtherError)
    isTrue(asyncWrongReason._unsafeUnwrapErr() instanceof CoverageParentError)
    isTrue(asyncMissingReasonHandler._unsafeUnwrapErr() instanceof CoverageParentError)
    isTrue(asyncPrimitiveReason._unsafeUnwrapErr() instanceof CoverageParentError)
    isTrue(asyncWrongUnwrap._unsafeUnwrapErr() instanceof CoverageOtherError)
  })

  it('covers matching reason-aware multi-handler and unwrap branches', async () => {
    const syncHandled = resultar
      .err<number, CoverageParentError>(
        new CoverageParentError(CoverageReason.Primary({ code: 'sync' })),
      )
      .catchReasons('CoverageParentError', { Primary: (reason) => resultar.ok(reason.code) })
    const asyncHandled = await resultar
      .errAsync<number, CoverageParentError>(
        new CoverageParentError(CoverageReason.Primary({ code: 'async' })),
      )
      .catchReasons('CoverageParentError', { Primary: (reason) => resultar.okAsync(reason.code) })
    const asyncUnwrapped = await resultar
      .errAsync<number, CoverageParentError>(
        new CoverageParentError(CoverageReason.Primary({ code: 'unwrap' })),
      )
      .unwrapReason('CoverageParentError')

    equal(syncHandled._unsafeUnwrap(), 'sync')
    equal(asyncHandled._unsafeUnwrap(), 'async')
    deepEqual(asyncUnwrapped._unsafeUnwrapErr(), CoverageReason.Primary({ code: 'unwrap' }))
  })

  it('covers async traversal rejection branches', async () => {
    const throwingIterable = {
      [Symbol.iterator](): Iterator<number> {
        return {
          next() {
            throw new Error('iterator failed')
          },
        }
      },
    }

    await rejects(
      async () =>
        await resultar.ResultAsync.validateAll(throwingIterable, (value) =>
          resultar.okAsync<number, string>(value),
        ),
      /iterator failed/u,
    )
    await rejects(
      async () =>
        await resultAsyncForEach(throwingIterable, (value) =>
          resultar.okAsync<number, string>(value),
        ),
      /iterator failed/u,
    )
    await rejects(
      async () =>
        await resultar.ResultAsync.validateAll(
          [0, 1],
          (value) => {
            if (value === 0) {
              return delayedOkTask<number, string>(value, 5)(new AbortController().signal)
            }

            throw new Error('validate mapper failed')
          },
          { concurrency: 2 },
        ),
      /validate mapper failed/u,
    )
    await rejects(
      async () =>
        await resultAsyncForEach(
          [0, 1],
          (value) => {
            if (value === 0) {
              return delayedOkTask<number, string>(value, 5)(new AbortController().signal)
            }

            throw new Error('forEach mapper failed')
          },
          { concurrency: 2 },
        ),
      /forEach mapper failed/u,
    )
    await rejects(
      async () =>
        await resultar.ResultAsync.validateAll(
          [1],
          () =>
            new resultar.ResultAsync<number, Error>(
              Promise.reject(new Error('rejected validation')),
            ),
        ),
      /rejected validation/u,
    )
    await rejects(
      async () =>
        await resultAsyncForEach(
          [1],
          () =>
            new resultar.ResultAsync<number, Error>(Promise.reject(new Error('rejected forEach'))),
        ),
      /rejected forEach/u,
    )

    await sleep(10)
  })

  it('covers late racing settlements and race handles', async () => {
    const first = await resultar.ResultAsync.raceFirst(
      delayedOkTask<string, string>('fast', 0),
      delayedOkTask<string, string>('slow', 50),
    )
    const success = await resultar.ResultAsync.race(
      delayedOkTask<string, string>('fast', 0),
      delayedOkTask<string, string>('slow', 50),
    )
    const withHandle = await resultar.ResultAsync.raceWith(
      delayedOkTask<string, string>('left', 0),
      delayedOkTask<string, string>('right', 50),
      {
        onLeftDone: (result, right) => {
          isTrue(right.signal instanceof AbortSignal)
          right.abort(new Error('stop right'))
          return result
        },
        onRightDone: (result, left) => {
          left.abort(new Error('stop left'))
          return result
        },
      },
    )

    equal(first._unsafeUnwrap(), 'fast')
    equal(success._unsafeUnwrap(), 'fast')
    equal(withHandle._unsafeUnwrap(), 'left')

    await sleep(60)
  })

  it('covers redaction and tagged enum defensive branches', () => {
    const redacted = resultar.redact('secret')
    const Enum = resultar.taggedEnum<{ A: object }>()

    equal(redacted.toJSON(), '<redacted>')
    equal(redacted.toString(), '<redacted>')
    equal(resultar.isRedacted('plain'), false)
    deepEqual(Enum.A({ _tag: 'Ignored' } as never), { _tag: 'A' })
    equal(CoverageReason.$is('Primary', CoverageReason.Primary({ code: 'primary' })), true)
    equal(CoverageReason.$is('Primary', null), false)
    equal(CoverageReason.$is('Primary', 'Primary'), false)
    equal(CoverageReason.$is('Primary', { _tag: 'Secondary', code: 'secondary' }), false)
    equal(CoverageReason.$is('Primary', { _tag: 123 }), false)
    equal((Enum as unknown as Record<symbol, unknown>)[Symbol.toStringTag], undefined)
    throws(
      () => Enum.$match({ _tag: 'Missing' } as never, { A: () => 'a' }),
      /No tagged enum handler/u,
    )
  })

  it('covers ResultAsync adapter registration failure in isolation', async () => {
    const adapter = (await import(
      new URL('../src/resultar-async/result-async-adapter.ts?coverage', import.meta.url).href
    )) as typeof ResultAsyncAdapter

    throws(() => adapter.createResultAsync(Promise.resolve(resultar.ok(1))), /not registered/u)
  })

  it('covers safeTry uncaught throw and rejection branches', async () => {
    const thrown = new Error('sync generator throw')
    const rejected = new Error('async generator rejection')

    throws(
      () =>
        resultar.safeTry(function* () {
          yield* [] as Iterable<Result<never, Error>>
          throw thrown
        }),
      thrown,
    )
    await rejects(
      async () =>
        await resultar.safeTry(async function* () {
          yield* [] as Iterable<Result<never, Error>>
          await Promise.reject(rejected)
          return resultar.ok(1)
        }),
      rejected,
    )
  })

  it('covers tagged-error non-error causes and fallback matching paths', () => {
    const errorWithNativeIsError = Error as typeof Error & { isError?: (value: unknown) => boolean }
    const originalIsError = errorWithNativeIsError.isError

    Object.defineProperty(Error, 'isError', {
      configurable: true,
      value: (value: unknown) => value === 'native-check',
    })
    isTrue(resultar.isError('native-check'))
    equal(resultar.isError(new Error('not-native-check')), false)

    if (originalIsError) {
      Object.defineProperty(Error, 'isError', { configurable: true, value: originalIsError })
    } else {
      Reflect.deleteProperty(errorWithNativeIsError, 'isError')
    }

    Reflect.deleteProperty(errorWithNativeIsError, 'isError')
    isTrue(resultar.isError(new Error('fallback-check')))

    if (originalIsError) {
      Object.defineProperty(Error, 'isError', { configurable: true, value: originalIsError })
    }

    const primitiveCause = new CoverageTaggedFailure({ cause: 'root cause', id: '123' })
    const LooseTaggedFailure = CoverageTaggedFailure as unknown as new () => CoverageTaggedFailure
    const missingProps = new LooseTaggedFailure()
    const objectTemplateFailure = new CoverageObjectTemplateFailure({
      value: { toJSON: () => undefined },
    } as never)

    equal(missingProps.message, 'Tagged $id failed')
    equal(objectTemplateFailure.message, 'Object [object Object] failed')

    deepEqual(primitiveCause.toJSON(), {
      _tag: 'TaggedFailure',
      cause: 'root cause',
      fingerprint: ['TaggedFailure', 'Tagged $id failed'],
      id: '123',
      message: 'Tagged 123 failed',
      messageTemplate: 'Tagged $id failed',
      name: 'TaggedFailure',
    })
    deepEqual(new CoverageTaggedFailure({ id: '456' }).toJSON(), {
      _tag: 'TaggedFailure',
      fingerprint: ['TaggedFailure', 'Tagged $id failed'],
      id: '456',
      message: 'Tagged 456 failed',
      messageTemplate: 'Tagged $id failed',
      name: 'TaggedFailure',
    })

    equal(resultar.findCause(primitiveCause, TypeError), undefined)

    const nativeError = new Error('native')
    const handledNative = resultar.matchError(nativeError, { Error: (error) => error.message })

    equal(handledNative, 'native')
    throws(() => resultar.matchError(nativeError, {} as never), /native/u)

    const tagged = new CoverageTaggedFailure({ id: '456' })
    const partialTagged = resultar.matchErrorPartial(
      tagged as CoverageTaggedFailure | CoverageOtherTaggedFailure,
      { TaggedFailure: (error) => String(error.id) },
      () => 'fallback',
    )

    equal(partialTagged, '456')
    const partialMissingHandler = resultar.matchErrorPartial(
      tagged as CoverageTaggedFailure | CoverageOtherTaggedFailure,
      {},
      () => 'fallback',
    )
    const partialUndefinedHandler = resultar.matchErrorPartial(
      tagged as CoverageTaggedFailure | CoverageOtherTaggedFailure,
      { TaggedFailure: undefined } as never,
      () => 'fallback',
    )

    equal(partialMissingHandler, 'fallback')
    equal(partialUndefinedHandler, 'fallback')

    const partialNative = resultar.matchErrorPartial(
      nativeError,
      { Error: (error) => error.message },
      () => 'fallback',
    )

    equal(partialNative, 'native')
  })

  it('covers index re-exports', () => {
    equal(typeof resultar.Result, 'function')
    equal(typeof resultar.ResultAsync, 'function')
    equal(typeof resultar.ok, 'function')
    equal(typeof resultar.err, 'function')
    equal(typeof resultar.unit, 'function')
    equal(typeof resultar.tryCatch, 'function')
    equal(typeof resultar.fromThrowable, 'function')
    equal(typeof resultar.okAsync, 'function')
    equal(typeof resultar.errAsync, 'function')
    equal(typeof resultar.unitAsync, 'function')
    equal(typeof resultar.fromPromise, 'function')
    equal(typeof resultar.fromSafePromise, 'function')
    equal(typeof resultar.fromThrowableAsync, 'function')
    equal(typeof resultar.runPromise, 'function')
    equal(typeof resultar.runSync, 'function')
    equal(typeof resultar.tryCatchAsync, 'function')
    equal(typeof resultar.safeTry, 'function')
    equal(typeof resultar.createTaggedError, 'function')
    equal(typeof resultar.findCause, 'function')
    equal(typeof resultar.isError, 'function')
    equal(typeof resultar.matchError, 'function')
    equal(typeof resultar.matchErrorPartial, 'function')
  })

  /* eslint-disable max-statements, no-throw-literal, no-empty-function, no-promise-executor-return, init-declarations, prefer-promise-reject-errors, unicorn/no-array-for-each, unicorn/prefer-native-coercion-functions, unicorn/require-array-join-separator, @typescript-eslint/no-non-null-assertion, @typescript-eslint/only-throw-error, @typescript-eslint/prefer-promise-reject-errors */
  it('covers remaining task runtime branches', async () => {
    // FiberSignal and schedulerCheckpoint direct edge cases
    const parentFs = new FiberSignal()
    parentFs.abort()
    expect(parentFs.aborted).toBe(true)
    parentFs.addEventListener('abort', () => {})
    const nativeSig = parentFs.toNativeSignal()
    expect(nativeSig.aborted).toBe(true)
    const childFs = new FiberSignal(parentFs.asAbortSignal())
    expect(childFs.aborted).toBe(true)
    expect(childFs.reason).toBe(parentFs.reason)
    expect(schedulerCheckpoint(undefined, NEVER_ABORTED_SIGNAL)).toBeUndefined()

    // Semaphore abort on second signal read (semaphore.ts line 123 & result-task.ts line 3533)
    let semAbortReads = 0
    const semFlipSignal = {
      get aborted() {
        semAbortReads += 1
        return semAbortReads >= 2
      },
      reason: 'sem-flip-2',
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as AbortSignal
    expect(
      await ResultTask.runExit(Semaphore.make(1).withPermit(ResultTask.ok(1)), {
        signal: semFlipSignal,
      }),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'sem-flip-2' } })

    // TaskScope child disposer, repeat closeSyncOrAsync/close, and drainFinalizersAsync rejections
    const childDisposerScope = new TaskScope()
    const removeChild = childDisposerScope.addChild({
      interrupt: () => {},
      close: async () => ({ _tag: 'Success', value: undefined }),
    })
    removeChild()
    removeChild()
    childDisposerScope.unregisterChild({
      interrupt: () => {},
      close: async () => ({ _tag: 'Success', value: undefined }),
    })
    const firstClosed = childDisposerScope.closeSyncOrAsync({ _tag: 'Success', value: 1 })
    expect(childDisposerScope.closeSyncOrAsync({ _tag: 'Success', value: 2 })).toBe(firstClosed)

    // Semaphore waiter inside cleanup scope (NEVER_ABORTED_SIGNAL)
    const unintSem = Semaphore.make(1)
    expect(
      await ResultTask.runPromise(
        ResultTask.all(
          [
            unintSem.withPermit(ResultTask.sleep(10)),
            ResultTask.ok(42).ensuring(() => unintSem.withPermit(ResultTask.ok(1))),
          ],
          { concurrency: 2 },
        ),
      ),
    ).toEqual([undefined, 42])

    const asyncRejectScope = new TaskScope()
    asyncRejectScope.add(() => Promise.reject('fin-loop-reject'))
    asyncRejectScope.add(async () => ({ _tag: 'Success', value: undefined }))
    asyncRejectScope.add(() => Promise.reject('pending-release-reject'))
    const closingPromise = asyncRejectScope.closeSyncOrAsync({ _tag: 'Success', value: undefined })
    expect(asyncRejectScope.closeSyncOrAsync({ _tag: 'Success', value: undefined })).toBe(
      closingPromise,
    )
    expect(asyncRejectScope.close({ _tag: 'Success', value: undefined })).toBe(closingPromise)
    expect(await closingPromise).toEqual({
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Die', defect: 'pending-release-reject' },
        right: { _tag: 'Die', defect: 'fin-loop-reject' },
      },
    })

    // fiber-runtime getFiberMeta(null), executeStructuralJoin sync/uninitialized, sync throw in ManagedFiber.run with async scope finalizer, and ManagedFiber.cleanup with completeFn
    expect(() => Fiber.join(null as never)).toThrow(TypeError)
    const syncStructuralFiber: FiberType<number, never> = {
      interrupt: () => ResultTask.ok({ _tag: 'Success' as const, value: 77 }),
      join: () => ResultTask.ok(77),
    }
    expect(
      await ResultTask.runPromise(Fiber.join(syncStructuralFiber, { interruption: 'detach' })),
    ).toBe(77)

    const structuralAwaitTask = Fiber.await(syncStructuralFiber)
    const prevFactory2 = registerFiberTaskFactory(undefined)
    try {
      expect(await ResultTask.runExit(structuralAwaitTask)).toEqual({
        _tag: 'Success',
        value: {
          _tag: 'Failure',
          cause: { _tag: 'Die', defect: new TypeError('ResultTask has not initialized') },
        },
      })
    } finally {
      registerFiberTaskFactory(prevFactory2)
    }

    const syncThrowStartFiber = startFiber({
      scope: new TaskScope(),
      signal: new AbortController().signal,
      prepare: (scope) => {
        scope.add(async () => ({ _tag: 'Success', value: undefined }))
        return {
          execute: () => {
            throw 'sync-start-fiber-boom'
          },
          complete: (exit) => exit,
        }
      },
    })
    expect(await ResultTask.runExit(Fiber.await(syncThrowStartFiber.handle))).toEqual({
      _tag: 'Success',
      value: { _tag: 'Failure', cause: { _tag: 'Die', defect: 'sync-start-fiber-boom' } },
    })

    expect(
      await ResultTask.runPromise(
        ResultTask.ok('main').ensuring(() =>
          ResultTask.race(ResultTask.sleep(50), ResultTask.ok('win')),
        ),
      ),
    ).toBe('main')

    const addFn = ResultTask.fn(function* (a: number, b: number) {
      const x = yield* ResultTask.ok(a)
      const y = yield* ResultTask.ok(b)
      return x + y
    })
    expect(await ResultTask.runPromise(addFn(20, 22))).toBe(42)

    // Structural ResultTaskYield and ServiceYield in ResultTask.gen
    const IterTag = ResultTask.service<number, 'IterTag'>('IterTag')
    expect(
      await ResultTask.runPromise(
        (
          ResultTask.gen(function* () {
            const a = (yield {
              [ResultTaskYieldTypeId]: ResultTaskYieldTypeId,
              _tag: 'ResultTask',
              task: ResultTask.ok(40),
            } as never) as { value: number }
            const b = (yield {
              [ResultTaskYieldTypeId]: ResultTaskYieldTypeId,
              _tag: 'Service',
              tag: IterTag,
            } as never) as number
            return a.value + b
          }) as ResultTask<number, never, typeof IterTag>
        ).provideService(IterTag, 2),
      ),
    ).toBe(42)

    for (const invalidYield of [
      null,
      { [ResultTaskYieldTypeId]: Symbol('wrong'), _tag: 'ResultTask', task: ResultTask.ok(1) },
      { [ResultTaskYieldTypeId]: ResultTaskYieldTypeId, _tag: 'Wrong', task: ResultTask.ok(1) },
      { [ResultTaskYieldTypeId]: ResultTaskYieldTypeId, _tag: 'ResultTask', task: 123 },
      { [ResultTaskYieldTypeId]: Symbol('wrong'), _tag: 'Service', tag: IterTag },
      { [ResultTaskYieldTypeId]: ResultTaskYieldTypeId, _tag: 'Service', tag: 123 },
    ]) {
      expect(
        await ResultTask.runExit(
          ResultTask.gen(function* () {
            yield invalidYield as never
            return 1
          }),
        ),
      ).toEqual({
        _tag: 'Failure',
        cause: {
          _tag: 'Die',
          defect: new TypeError('ResultTask.gen yielded an unsupported value'),
        },
      })
    }

    // resolveService when service is provided in context AND serviceResolver is present during closeGeneratorAsync
    let seenInFinally = 0
    expect(
      await ResultTask.runExit(
        (
          ResultTask.provideServiceResolver(
            ResultTask.gen(function* () {
              try {
                return yield* ResultTask.err('body-err')
              } finally {
                yield* ResultTask.sleep(0)
                seenInFinally = yield* IterTag
              }
            }),
            { IterTag: () => ResultTask.err('resolver-should-not-run') },
          ) as ResultTask<never, string, typeof IterTag>
        ).provideService(IterTag, 42),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'body-err' } })
    expect(seenInFinally).toBe(42)

    // A Result-producing promise is interrupted while awaiting an Err result
    const promiseAbortController = new AbortController()
    const promiseTask = ResultTask.fromResultAsync(
      new Promise<Result<number, string>>((resolve) => {
        setImmediate(() => {
          promiseAbortController.abort('promise-ctor-aborted')
          resolve(err('ignored-err'))
        })
      }),
    )
    expect(
      await ResultTask.runExit(promiseTask, { signal: promiseAbortController.signal }),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'promise-ctor-aborted' } })

    // closeGeneratorAsync catch block (throw inside finally after yielding in finally)
    expect(
      await ResultTask.runExit(
        ResultTask.gen(function* () {
          try {
            return yield* ResultTask.err('gen-err')
          } finally {
            yield* ResultTask.ok(1)
            // eslint-disable-next-line no-unsafe-finally
            throw 'finally-after-yield-boom'
          }
        }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'finally-after-yield-boom' } })

    // Scheduler failures, recoverScheduling, and combineExits in runTaskLoop, #runTaskLoopFromYield, and #resumeTaskLoopAsync
    let schedCount = 0
    let cleanupSteps = 0
    expect(
      await ResultTask.runExit(
        ResultTask.ok(1).ensuring(() =>
          ResultTask.ok(1)
            .map((x) => {
              cleanupSteps += 1
              return x + 1
            })
            .map((x) => {
              cleanupSteps += 1
              return x + 1
            }),
        ),
        {
          yieldEvery: 2,
          scheduler: {
            yield: () => {
              schedCount += 1
              if (schedCount >= 2) throw 'cleanup-sync-sched-boom'
              return Promise.resolve()
            },
          },
        },
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'cleanup-sync-sched-boom' } })
    expect(schedCount).toBe(2)
    expect(cleanupSteps).toBe(2)

    // Sync scheduler throw outside cleanup (currentExit undefined vs defined)
    expect(
      await ResultTask.runExit(
        ResultTask.ok(1).map((x) => x + 1),
        {
          yieldEvery: 1,
          scheduler: {
            yield: () => {
              throw 'sync-sched-outside-cleanup'
            },
          },
        },
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'sync-sched-outside-cleanup' } })

    let syncAfterErrCalls = 0
    expect(
      await ResultTask.runExit(
        ResultTask.err('first-err').map((x) => x),
        {
          yieldEvery: 1,
          scheduler: {
            yield: () => {
              syncAfterErrCalls += 1
              if (syncAfterErrCalls === 3) throw 'sync-sched-after-err'
              return undefined as unknown as Promise<void>
            },
          },
        },
      ),
    ).toEqual({
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Fail', error: 'first-err' },
        right: { _tag: 'Die', defect: 'sync-sched-after-err' },
      },
    })

    // Sync scheduler throw in runTaskLoop (L1493) when currentExit is already a Failure (yieldEvery: 3)
    expect(
      await ResultTask.runExit(
        ResultTask.err('first-sync-loop-err').map((x) => x),
        {
          yieldEvery: 3,
          scheduler: {
            yield: () => {
              throw 'sync-loop-sched-after-err'
            },
          },
        },
      ),
    ).toEqual({
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Fail', error: 'first-sync-loop-err' },
        right: { _tag: 'Die', defect: 'sync-loop-sched-after-err' },
      },
    })

    // Async scheduler rejection in cleanup (#runTaskLoopFromYield cleanup branch + recoverScheduling)
    let asyncCleanupYieldCalls = 0
    let asyncCleanupSteps = 0
    expect(
      await ResultTask.runExit(
        ResultTask.ok(1).ensuring(() =>
          ResultTask.ok(1)
            .map((x) => {
              asyncCleanupSteps += 1
              return x + 1
            })
            .map((x) => {
              asyncCleanupSteps += 1
              return x + 1
            }),
        ),
        {
          yieldEvery: 2,
          scheduler: {
            yield: () => {
              asyncCleanupYieldCalls += 1
              if (asyncCleanupYieldCalls >= 2) return Promise.reject('cleanup-async-yield-1')
              return Promise.resolve()
            },
          },
        },
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'cleanup-async-yield-1' } })
    expect(asyncCleanupYieldCalls).toBe(2)
    expect(asyncCleanupSteps).toBe(2)

    // Async scheduler rejection inside #resumeTaskLoopAsync in cleanup (recoverScheduling at L1745)
    let resumeCleanupYieldCalls = 0
    let resumeCleanupSteps = 0
    expect(
      await ResultTask.runExit(
        ResultTask.ok(1).ensuring(() =>
          ResultTask.sleep(0)
            .andThen(() =>
              ResultTask.sync(() => {
                resumeCleanupSteps += 1
                return 1
              }),
            )
            .map((x) => {
              resumeCleanupSteps += 1
              return x + 1
            })
            .map((x) => {
              resumeCleanupSteps += 1
              return x + 1
            }),
        ),
        {
          yieldEvery: 2,
          scheduler: {
            yield: () => {
              resumeCleanupYieldCalls += 1
              if (resumeCleanupYieldCalls >= 3) {
                return Promise.reject('cleanup-resume-async-sched-boom')
              }
              return Promise.resolve()
            },
          },
        },
      ),
    ).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Die', defect: 'cleanup-resume-async-sched-boom' },
    })
    expect(resumeCleanupYieldCalls).toBe(3)
    expect(resumeCleanupSteps).toBe(3)

    // Async scheduler rejection in #runTaskLoopFromYield (L1617) after an Err exit (yieldEvery: 3)
    expect(
      await ResultTask.runExit(
        ResultTask.err('first-async-err').map((x) => x),
        { yieldEvery: 3, scheduler: { yield: () => Promise.reject('async-sched-after-err') } },
      ),
    ).toEqual({
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Fail', error: 'first-async-err' },
        right: { _tag: 'Die', defect: 'async-sched-after-err' },
      },
    })

    const schedAbortCtrl = new AbortController()
    expect(
      await ResultTask.runExit(
        ResultTask.ok(1).map((x) => x + 1),
        {
          yieldEvery: 1,
          signal: schedAbortCtrl.signal,
          scheduler: {
            yield: () => {
              schedAbortCtrl.abort('sched-aborted')
              throw 'ignored-sched-throw'
            },
          },
        },
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'sched-aborted' } })

    const resumeSchedAbortCtrl = new AbortController()
    let resumeSchedAbortCalls = 0
    expect(
      await ResultTask.runExit(
        ResultTask.sleep(0).andThen(() => ResultTask.ok(1)),
        {
          yieldEvery: 2,
          signal: resumeSchedAbortCtrl.signal,
          scheduler: {
            yield: () => {
              resumeSchedAbortCalls += 1
              if (resumeSchedAbortCalls >= 2) {
                resumeSchedAbortCtrl.abort('resume-sched-aborted')
                throw 'ignored-resume-sched-throw'
              }
              return Promise.resolve()
            },
          },
        },
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'resume-sched-aborted' } })

    let asyncSchedCount = 0
    expect(
      await ResultTask.runExit(
        ResultTask.sleep(0).andThen(() => ResultTask.ok(1)),
        {
          yieldEvery: 1,
          scheduler: {
            yield: () => {
              asyncSchedCount += 1
              if (asyncSchedCount >= 2) return Promise.reject('async-sched-reject-no-exit')
              return Promise.resolve()
            },
          },
        },
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'async-sched-reject-no-exit' } })

    const midSyncAbort = new AbortController()
    expect(
      await ResultTask.runExit(
        ResultTask.sleep(0)
          .andThen(() =>
            ResultTask.sync(() => {
              midSyncAbort.abort('mid-sync-aborted')
              return 1
            }),
          )
          .map(() => {
            throw 'should-not-run'
          }),
        { signal: midSyncAbort.signal },
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'mid-sync-aborted' } })

    // Signal aborted during a failing step preserves Failure rather than overwriting with Interrupt
    const failSyncAbort = new AbortController()
    expect(
      await ResultTask.runExit(
        ResultTask.try({
          try: () => {
            failSyncAbort.abort('aborted-during-fail')
            throw 'sync-fail-err'
          },
          catch: (e) => String(e),
        }).map((x) => x),
        { signal: failSyncAbort.signal },
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'sync-fail-err' } })

    const failAsyncResumeAbort = new AbortController()
    expect(
      await ResultTask.runExit(
        ResultTask.sleep(0)
          .andThen(() =>
            ResultTask.try({
              try: () => {
                failAsyncResumeAbort.abort('aborted-during-async-fail')
                throw 'async-fail-err'
              },
              catch: (e) => String(e),
            }),
          )
          .map((x) => x),
        { signal: failAsyncResumeAbort.signal },
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'async-fail-err' } })

    // #resumeTaskLoopAsync TapError, TapBoth, and throwing Sync
    let tapErrSeen = ''
    let tapBothSeen = 0
    expect(
      await ResultTask.runExit(
        ResultTask.sleep(0).andThen(() =>
          ResultTask.err('tap-err-val').tapError((e) => {
            tapErrSeen = e
          }),
        ),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'tap-err-val' } })
    expect(tapErrSeen).toBe('tap-err-val')

    expect(
      await ResultTask.runPromise(
        ResultTask.sleep(0).andThen(() =>
          ResultTask.ok(7).tapBoth({
            ok: (v) => {
              tapBothSeen = v
            },
            err: () => {},
          }),
        ),
      ),
    ).toBe(7)
    expect(tapBothSeen).toBe(7)

    expect(
      await ResultTask.runExit(
        ResultTask.sleep(0).andThen(() =>
          ResultTask.sync(() => {
            throw 'sync-after-async-boom'
          }),
        ),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'sync-after-async-boom' } })

    // inspectError and inspectCause returning a ResultTask (not executed) vs async Promise (awaited)
    let inspectTaskExecuted = false
    const unexecutedTask = ResultTask.sync(() => {
      inspectTaskExecuted = true
    })
    let inspectErrAsyncDone = false
    let inspectCauseAsyncDone = false
    expect(
      await ResultTask.runExit(
        ResultTask.err('e')
          .inspectError(() => unexecutedTask)
          .inspectError(async () => {
            await sleep(5)
            inspectErrAsyncDone = true
          })
          .inspectCause(() => unexecutedTask)
          .inspectCause(async () => {
            await sleep(5)
            inspectCauseAsyncDone = true
          }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'e' } })
    expect(inspectTaskExecuted).toBe(false)
    expect(inspectErrAsyncDone).toBe(true)
    expect(inspectCauseAsyncDone).toBe(true)

    // Internal executors must fail without being caught by a public factory so the interpreter handles them.
    const InternalDefectTask = ResultTask as unknown as new (
      execute: () => Promise<never>,
    ) => ResultTask<never, never>

    // Non-root Async instruction sync throw, async reject with continuation, and reject after async resume
    const syncThrowAsyncTask = new InternalDefectTask(() => {
      throw 'non-root-sync-boom'
    })
    expect(await ResultTask.runExit(syncThrowAsyncTask.map((x) => x))).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Die', defect: 'non-root-sync-boom' },
    })

    const rawRejectAsyncTask = new InternalDefectTask(() => Promise.reject('non-root-async-reject'))
    expect(await ResultTask.runExit(rawRejectAsyncTask.map((x) => x))).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Die', defect: 'non-root-async-reject' },
    })
    expect(await ResultTask.runExit(ResultTask.sleep(0).andThen(() => rawRejectAsyncTask))).toEqual(
      { _tag: 'Failure', cause: { _tag: 'Die', defect: 'non-root-async-reject' } },
    )

    // tryPromise({ try, catch }) error/abort paths (1891, 1897, 1902)
    expect(
      await ResultTask.runExit(
        ResultTask.tryPromise({
          try: () => Promise.reject('try-reject'),
          catch: () => {
            throw 'catch-async-boom'
          },
        }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'catch-async-boom' } })

    const trySyncAbort = new AbortController()
    expect(
      await ResultTask.runExit(
        ResultTask.tryPromise({
          try: () => {
            trySyncAbort.abort('try-sync-aborted')
            throw 'ignored-sync'
          },
          catch: () => 'mapped',
        }),
        { signal: trySyncAbort.signal },
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'try-sync-aborted' } })

    expect(
      await ResultTask.runExit(
        ResultTask.tryPromise({
          try: () => {
            throw 'try-sync-boom'
          },
          catch: () => {
            throw 'catch-sync-boom'
          },
        }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'catch-sync-boom' } })

    // #registerAcquireReleaseFinalizer async inner scope close (1953), raw reject (1961), and raw sync throw (1965)
    expect(
      await ResultTask.runExit(
        ResultTask.scoped(
          ResultTask.acquireRelease({
            acquire: ResultTask.ok('res'),
            release: () =>
              ResultTask.acquireRelease({
                acquire: ResultTask.ok(undefined),
                release: () => ResultTask.sleep(0),
              }),
          }),
        ),
      ),
    ).toEqual({ _tag: 'Success', value: 'res' })

    const customRejectRelease = ResultTask.ok(undefined)
    ;(customRejectRelease as unknown as { execute: () => unknown }).execute = () => undefined
    ;(customRejectRelease as unknown as { execute: () => unknown }).execute = () =>
      Promise.reject('release-custom-reject')
    expect(
      await ResultTask.runExit(
        ResultTask.scoped(
          ResultTask.acquireRelease({
            acquire: ResultTask.ok('res'),
            release: () => customRejectRelease,
          }),
        ),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'release-custom-reject' } })

    const customThrowRelease = ResultTask.ok(undefined)
    ;(customThrowRelease as unknown as { execute: () => unknown }).execute = () => {
      throw 'release-custom-throw'
    }
    expect(
      await ResultTask.runExit(
        ResultTask.scoped(
          ResultTask.acquireRelease({
            acquire: ResultTask.ok('res'),
            release: () => customThrowRelease,
          }),
        ),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'release-custom-throw' } })

    // #resumeGenFromTaskAsync, #resumeGenFromServiceAsync, and #resumeGenLoopAsync (2347, 2363-2510)
    expect(
      await ResultTask.runExit(
        ResultTask.gen(function* () {
          return yield* customRejectRelease
        }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'release-custom-reject' } })

    expect(
      await ResultTask.runExit(
        ResultTask.gen(function* () {
          yield* ResultTask.sleep(0)
          throw 'after-sleep-boom'
        }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'after-sleep-boom' } })

    const AsyncSvc = ResultTask.service<number, 'AsyncSvc'>('AsyncSvc')
    expect(
      await ResultTask.runExit(
        ResultTask.provideServiceResolver(
          ResultTask.gen(function* () {
            yield* AsyncSvc
            throw 'after-svc-boom'
          }),
          { AsyncSvc: () => ResultTask.ok(10) },
        ),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'after-svc-boom' } })

    expect(
      await ResultTask.runExit(
        ResultTask.gen(function* () {
          yield* ResultTask.sleep(0)
          return yield* customRejectRelease
        }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'release-custom-reject' } })

    expect(
      await ResultTask.runExit(
        ResultTask.gen(function* () {
          yield* ResultTask.sleep(0)
          return yield* ResultTask.err('step2-task-err')
        }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'step2-task-err' } })

    expect(
      await ResultTask.runExit(
        ResultTask.gen(function* () {
          yield* ResultTask.sleep(0)
          return yield* AsyncSvc
        }).provideService(AsyncSvc, 99),
      ),
    ).toEqual({ _tag: 'Success', value: 99 })

    expect(
      await ResultTask.runExit(
        ResultTask.provideServiceResolver(
          ResultTask.gen(function* () {
            yield* ResultTask.sleep(0)
            return yield* AsyncSvc
          }),
          { AsyncSvc: () => ResultTask.ok(77) },
        ),
      ),
    ).toEqual({ _tag: 'Success', value: 77 })

    expect(
      await ResultTask.runExit(
        ResultTask.provideServiceResolver(
          ResultTask.gen(function* () {
            yield* ResultTask.sleep(0)
            return yield* AsyncSvc
          }),
          { AsyncSvc: () => ResultTask.err('svc-effect-err') },
        ),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'svc-effect-err' } })

    const MissingAfterAsyncSvc = ResultTask.service<number, 'MissingAfterAsyncSvc'>(
      'MissingAfterAsyncSvc',
    )
    const missingAfterAsyncExit = await ResultTask.runExit(
      ResultTask.gen(function* () {
        yield* ResultTask.sleep(0)
        return yield* MissingAfterAsyncSvc
      }) as ResultTask<number>,
    )
    expect(missingAfterAsyncExit).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Die', defect: new MissingServiceError('MissingAfterAsyncSvc') },
    })

    expect(
      await ResultTask.runExit(
        ResultTask.provideServiceResolver(
          ResultTask.gen(function* () {
            yield* ResultTask.sleep(0)
            return yield* AsyncSvc
          }),
          {
            AsyncSvc: () => {
              throw 'svc-effect-die'
            },
          },
        ),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'svc-effect-die' } })

    expect(
      await ResultTask.runExit(
        ResultTask.gen(function* () {
          yield* ResultTask.sleep(0)
          return yield* err('step2-sync-err')
        }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'step2-sync-err' } })

    const unsupportedAfterAsyncExit = await ResultTask.runExit(
      ResultTask.gen(function* () {
        yield* ResultTask.sleep(0)
        yield 123 as never
        return 1
      }),
    )
    expect(unsupportedAfterAsyncExit).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Die', defect: new TypeError('ResultTask.gen yielded an unsupported value') },
    })

    expect(
      await ResultTask.runExit(
        ResultTask.gen(function* () {
          yield* ResultTask.sleep(0)
          yield* ResultTask.ok(1)
          throw 'step3-sync-boom'
        }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'step3-sync-boom' } })

    // Semaphore custom task sync throw (3512-3513) and raw promise reject (3522-3523) still release permit
    const sharedSem = Semaphore.make(1)
    expect(await ResultTask.runExit(sharedSem.withPermit(customThrowRelease))).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Die', defect: 'release-custom-throw' },
    })
    expect(await ResultTask.runExit(sharedSem.withPermit(customRejectRelease))).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Die', defect: 'release-custom-reject' },
    })
    expect(await ResultTask.runPromise(sharedSem.withPermit(ResultTask.ok('acquired-after')))).toBe(
      'acquired-after',
    )

    // forEach worker async scope close on success (3904) and sync/async in catch block (3909)
    expect(await ResultTask.runExit(ResultTask.forEach([1], () => customThrowRelease))).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Die', defect: 'release-custom-throw' },
    })
    const customAsyncScopeThrowTask = ResultTask.ok(1)
    ;(
      customAsyncScopeThrowTask as unknown as { execute: (ctx: { scope: TaskScope }) => unknown }
    ).execute = (ctx) => {
      ctx.scope.add(async () => ({ _tag: 'Success', value: undefined }))
      throw 'foreach-async-scope-throw'
    }
    expect(
      await ResultTask.runExit(
        ResultTask.forEach(
          [1, 2],
          (n) =>
            n === 1
              ? ResultTask.acquireRelease({
                  acquire: ResultTask.ok(1),
                  release: () => ResultTask.sleep(0),
                })
              : customAsyncScopeThrowTask,
          { concurrency: 2 },
        ),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'foreach-async-scope-throw' } })

    // runExitSyncOrAsync async scope close interruption (for both sync and async root tasks) and non-Error option throw
    const syncBodyAsyncCloseAbort = new AbortController()
    expect(
      await ResultTask.runExit(
        ResultTask.ok('sync-body').ensuring(() =>
          ResultTask.tryPromise(async () => {
            await Promise.resolve()
            syncBodyAsyncCloseAbort.abort('abort-in-sync-body-async-close')
          }),
        ),
        { signal: syncBodyAsyncCloseAbort.signal },
      ),
    ).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'abort-in-sync-body-async-close' },
    })

    const asyncBodyAsyncCloseAbort = new AbortController()
    expect(
      await ResultTask.runExit(
        ResultTask.sleep(0)
          .as('async-body')
          .ensuring(() =>
            ResultTask.tryPromise(async () => {
              await Promise.resolve()
              asyncBodyAsyncCloseAbort.abort('abort-in-async-body-async-close')
            }),
          ),
        { signal: asyncBodyAsyncCloseAbort.signal },
      ),
    ).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'abort-in-async-body-async-close' },
    })

    const nonErrorRunOptions = {
      get yieldEvery(): number {
        throw 'non-error-run-option'
      },
    }
    await expect(ResultTask.runExit(ResultTask.ok(1), nonErrorRunOptions)).rejects.toThrow(
      expect.objectContaining({ message: 'non-error-run-option', cause: 'non-error-run-option' }),
    )
    await expect(ResultTask.runResult(ResultTask.ok(1), nonErrorRunOptions)).rejects.toThrow(
      expect.objectContaining({ message: 'non-error-run-option', cause: 'non-error-run-option' }),
    )
    await expect(ResultTask.runPromise(ResultTask.ok(1), nonErrorRunOptions)).rejects.toThrow(
      expect.objectContaining({ message: 'non-error-run-option', cause: 'non-error-run-option' }),
    )

    // ResultTask.match callback overloads and validation (5729-5732, 5740-5745)
    expect(
      await ResultTask.runPromise(
        ResultTask.match(
          ResultTask.ok(5),
          (v) => v * 2,
          () => 0,
        ),
      ),
    ).toBe(10)
    expect(
      await ResultTask.runPromise(
        ResultTask.match(
          (v: number) => v + 1,
          () => 0,
        )(ResultTask.ok(5)),
      ),
    ).toBe(6)
    expect(() =>
      (ResultTask.match as (...args: unknown[]) => unknown)(ResultTask.ok(1), (v: number) => v),
    ).toThrow(new TypeError('ResultTask.match requires both onOk and onErr callbacks'))
    expect(() => (ResultTask.match as (...args: unknown[]) => unknown)((v: number) => v)).toThrow(
      new TypeError('ResultTask.match requires both onOk and onErr callbacks'),
    )

    const genFnSingleArg = ResultTask.fn(function* (x: number) {
      const y = yield* ResultTask.ok(x + 1)
      return y * 2
    })
    expect(await ResultTask.runPromise(genFnSingleArg(4).map((v) => v + 1))).toBe(11)
    expect(
      await ResultTask.runPromise(
        ResultTask.tryPromise(() => Promise.resolve(3)).andThen((v) => genFnSingleArg(v)),
      ),
    ).toBe(8)

    const settledFiber = ResultTask.runFork(ResultTask.ok(7))
    expect(await ResultTask.runPromise(settledFiber.join())).toBe(7)
    expect(await ResultTask.runPromise(settledFiber.interrupt())).toEqual({
      _tag: 'Success',
      value: 7,
    })
  })
})
