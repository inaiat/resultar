import { deepEqual, equal } from 'node:assert'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import type {
  DisposableResult,
  Result,
  ResultOperations,
  ResultTask,
  StrictResultTask,
  TaggedEnumFactory,
} from '../src/index.js'
import type { ResultAsync, StrictResultAsync } from '../src/entries/async.js'

import * as resultarAsync from '../src/entries/async.js'
import * as resultar from '../src/index.js'

describe('public API', () => {
  it('keeps continuation helpers private at runtime and in types', () => {
    equal('toTapContinuationStep' in resultar.ResultTask, false)
    if (false) {
      // @ts-expect-error Continuation instructions are implementation details.
      void resultar.ResultTask.toTapContinuationStep
    }
  })

  it('exports the intended v5 root runtime entrypoint surface', () => {
    deepEqual(Object.keys(resultar).toSorted(), [
      'AbortError',
      'Cause',
      'Clock',
      'Deferred',
      'DisposableResult',
      'Fiber',
      'Match',
      'MissingServiceError',
      'Queue',
      'Ref',
      'Result',
      'ResultTask',
      'ResultTaskCauseError',
      'ResultTaskTypeId',
      'ResultTaskYieldTypeId',
      'Retry',
      'Scheduler',
      'Semaphore',
      'ServiceTagTypeId',
      'TaskLocal',
      'Tracer',
      'VirtualClock',
      'constant',
      'createTaggedError',
      'err',
      'findCause',
      'flow',
      'fromThrowable',
      'identity',
      'isAbortError',
      'isError',
      'isRedacted',
      'isResultTask',
      'isServiceTag',
      'matchError',
      'matchErrorPartial',
      'ok',
      'pipe',
      'redact',
      'revealRedacted',
      'runSync',
      'serviceTag',
      'taggedEnum',
      'tryResult',
      'unit',
    ])
  })

  it('exports the intended v5 opt-in async subpath surface', () => {
    deepEqual(Object.keys(resultarAsync).toSorted(), [
      'DisposableResultAsync',
      'ResultAsync',
      'asyncAndThen',
      'asyncMap',
      'errAsync',
      'fromCallback',
      'fromPromise',
      'fromSafePromise',
      'fromThrowableAsync',
      'okAsync',
      'runPromise',
      'safeTry',
      'tryAsync',
      'tryCatchAsync',
      'tryResultAsync',
      'unitAsync',
    ])
  })

  it('keeps Result disposable APIs and omits removed methods', () => {
    const result = resultar.ok<number, Error>(1)
    const disposable = result.toDisposable(() => undefined)

    expectTypeOf(result).toExtend<Result<number, Error>>()
    expectTypeOf(disposable).toExtend<DisposableResult<number, Error>>()
    expectTypeOf(disposable).toExtend<Disposable>()
    equal(disposable._unsafeUnwrap(), 1)

    if (false) {
      // @ts-expect-error Result#finally is not part of the current API.
      void result.finally
      // @ts-expect-error Result#tap was removed in v5 in favor of inspect.
      void result.tap
      // @ts-expect-error Result#tapError was removed in v5 in favor of inspectError.
      void result.tapError
      // @ts-expect-error Result#asyncMap moved to resultar/async.
      void result.asyncMap
      // @ts-expect-error Result#asyncAndThen moved to resultar/async.
      void result.asyncAndThen
    }
  })

  it('preserves full v4 ResultAsync compatibility APIs on resultar/async', async () => {
    const result = resultarAsync.okAsync<number, Error>(1)
    const strictAsync: StrictResultAsync<number, Error> = result

    expectTypeOf(result).toExtend<ResultAsync<number, Error>>()
    expectTypeOf(strictAsync).toExtend<ResultAsync<number, Error>>()
    equal((await result)._unsafeUnwrap(), 1)

    const fromTaskResult = await resultarAsync.ResultAsync.fromTask(resultar.ResultTask.ok(42))
    equal(fromTaskResult._unsafeUnwrap(), 42)

    const tappedValues: number[] = []
    const tapped = await resultarAsync
      .okAsync<number, string>(7)
      .tap((value) => {
        tappedValues.push(value)
      })
      .tapError(() => {
        tappedValues.push(-1)
      })
    equal(tapped._unsafeUnwrap(), 7)
    deepEqual(tappedValues, [7])

    const legacyMatched = await resultarAsync
      .errAsync<number, string>('boom')
      .match({ ok: (n) => `ok:${n}`, error: (e) => `err:${e}` })
    equal(legacyMatched, 'err:boom')

    equal(typeof resultarAsync.ResultAsync.retry, 'function')
    equal(typeof resultarAsync.ResultAsync.withResource, 'function')
    equal(typeof resultarAsync.ResultAsync.fromCallback, 'function')
    equal(typeof resultarAsync.ResultAsync.forEach, 'function')
    equal(typeof resultarAsync.ResultAsync.timeout, 'function')
    equal(typeof resultarAsync.ResultAsync.all, 'function')
    equal(typeof resultarAsync.ResultAsync.gen, 'function')
    equal(typeof resultarAsync.ResultAsync.fn, 'function')
    equal(typeof result.toAsyncDisposable, 'function')

    if (false) {
      // @ts-expect-error ResultAsync#finally is not part of the current API.
      void result.finally
      // @ts-expect-error ResultAsync#safeUnwrap is not part of the current API.
      void result.safeUnwrap
    }
  })

  it('exports StrictResultTask type from root', () => {
    const strictTask: StrictResultTask<number, Error> = resultar.ResultTask.ok(1)

    expectTypeOf(strictTask).toExtend<ResultTask<number, Error>>()
  })

  it('accepts method-shaped implementations for public method-like interfaces', () => {
    const methodShapedResult: Pick<ResultOperations<number, string>, 'map' | 'unwrapOr'> = {
      map(valueMapper) {
        return resultar.ok<number, string>(1).map(valueMapper)
      },
      unwrapOr(defaultValue) {
        return resultar.ok<number, string>(1).unwrapOr(defaultValue)
      },
    }

    type ReasonMembers = { Foo: { readonly id: string }; Nothing: object }

    const methodShapedEnumMatch: Pick<TaggedEnumFactory<ReasonMembers>, '$match'> = {
      $match() {
        throw new Error('type-only')
      },
    }

    expectTypeOf(methodShapedResult).toExtend<
      Pick<ResultOperations<number, string>, 'map' | 'unwrapOr'>
    >()
    expectTypeOf(methodShapedEnumMatch).toExtend<Pick<TaggedEnumFactory<ReasonMembers>, '$match'>>()
  })

  it('keeps public method-like properties writable at the type level', () => {
    if (false) {
      const result = resultar.ok<number, string>(1)
      const map = result.map
      result.map = map

      const TestError = resultar.createTaggedError({ message: 'failed', name: 'TestError' })
      const err = TestError.err
      TestError.err = err

      const reason = resultar.taggedEnum<{ Nothing: object }>()
      const match = reason.$match
      reason.$match = match

      const redacted = resultar.redact('secret')
      const toString = redacted.toString
      redacted.toString = toString
    }
  })
})
