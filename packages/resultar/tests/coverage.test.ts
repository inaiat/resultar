import { deepEqual, equal, ok as isTrue, rejects, throws } from 'node:assert'
import { describe, it } from 'vite-plus/test'

import { createResultarError } from '../src/error.js'
import type { Result } from '../src/index.js'
import * as resultar from '../src/index.js'
import type * as ResultAsyncAdapter from '../src/result-async-adapter.js'

describe('coverage-focused public behavior', () => {
  it('covers ResultarError payload branches and stack config', () => {
    const okResult = resultar.ok('value')
    const errResult = resultar.err('failure')

    const okError = createResultarError('ok message', okResult, { withStackTrace: true })
    const errError = createResultarError('err message', errResult)

    deepEqual(okError.data, { type: 'Ok', value: 'value' })
    equal(typeof okError.stack, 'string')
    deepEqual(errError.data, { type: 'Err', value: 'failure' })
    equal(errError.stack, undefined)
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
    void resultar.ok('value').tapError(() => {
      throw new Error('should not run')
    })

    throws(
      () => resultar.ok('value')._unsafeUnwrapErr({ withStackTrace: true }),
      (error) => {
        isTrue(error instanceof Error || typeof error === 'object')
        isTrue(error !== null)
        return 'stack' in error && typeof error.stack === 'string'
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

    class TaggedFailure extends resultar.createTaggedError({
      message: 'Tagged $id failed',
      name: 'TaggedFailure',
    }) {}

    class OtherTaggedFailure extends resultar.createTaggedError({
      message: 'Other tagged failure',
      name: 'OtherTaggedFailure',
    }) {}

    const primitiveCause = new TaggedFailure({ cause: 'root cause', id: '123' })
    const LooseTaggedFailure = TaggedFailure as unknown as new () => TaggedFailure
    const missingProps = new LooseTaggedFailure()

    equal(missingProps.message, 'Tagged $id failed')

    deepEqual(primitiveCause.toJSON(), {
      _tag: 'TaggedFailure',
      cause: 'root cause',
      fingerprint: ['TaggedFailure', 'Tagged $id failed'],
      id: '123',
      message: 'Tagged 123 failed',
      messageTemplate: 'Tagged $id failed',
      name: 'TaggedFailure',
    })
    deepEqual(new TaggedFailure({ id: '456' }).toJSON(), {
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

    const tagged = new TaggedFailure({ id: '456' })
    const partialTagged = resultar.matchErrorPartial(
      tagged as TaggedFailure | OtherTaggedFailure,
      { TaggedFailure: (error) => String(error.id) },
      () => 'fallback',
    )

    equal(partialTagged, '456')
    const partialMissingHandler = resultar.matchErrorPartial(
      tagged as TaggedFailure | OtherTaggedFailure,
      {},
      () => 'fallback',
    )

    equal(partialMissingHandler, 'fallback')

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
    equal(typeof resultar.tryCatchAsync, 'function')
    equal(typeof resultar.safeTry, 'function')
    equal(typeof resultar.createTaggedError, 'function')
    equal(typeof resultar.findCause, 'function')
    equal(typeof resultar.isError, 'function')
    equal(typeof resultar.matchError, 'function')
    equal(typeof resultar.matchErrorPartial, 'function')
  })
})
