import { deepEqual, equal, ok as isTrue, rejects, throws } from 'node:assert'
import { describe, it } from 'vite-plus/test'

import { createResultarError } from '../src/error.js'
import type { Result, TaggedEnum } from '../src/index.js'
import * as resultar from '../src/index.js'
import type * as ResultAsyncAdapter from '../src/result-async-adapter.js'

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
    const Enum = resultar.taggedEnum<{ A: Record<never, never> }>()

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
      new URL('../src/result-async-adapter.ts?coverage', import.meta.url).href
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
})
