import { deepEqual, equal } from 'node:assert'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import type {
  DisposableResult,
  DisposableResultAsync,
  Result,
  ResultAsync,
  ResultAsyncAbortSignal,
  ResultAsyncConcurrency,
  ResultAsyncRaceHandle,
  ResultAsyncRetryContext,
  ResultAsyncRetryOptions,
  ResultAsyncRetryOrElseOptions,
  ResultAsyncRetryTask,
  ResultOperations,
  TaggedEnumFactory,
} from '../src/index.js'

import * as resultar from '../src/index.js'

describe('public API', () => {
  it('exports the intended runtime entrypoint surface', () => {
    deepEqual(Object.keys(resultar).toSorted(), [
      'AbortError',
      'DisposableResult',
      'DisposableResultAsync',
      'Result',
      'ResultAsync',
      'createTaggedError',
      'default',
      'err',
      'errAsync',
      'findCause',
      'fromPromise',
      'fromSafePromise',
      'fromThrowable',
      'fromThrowableAsync',
      'isAbortError',
      'isError',
      'isRedacted',
      'matchError',
      'matchErrorPartial',
      'ok',
      'okAsync',
      'redact',
      'revealRedacted',
      'runPromise',
      'runSync',
      'safeTry',
      'taggedEnum',
      'try',
      'tryAsync',
      'tryCatch',
      'tryCatchAsync',
      'tryResult',
      'tryResultAsync',
      'unit',
      'unitAsync',
    ])
  })

  it('keeps Result disposable APIs and omits removed cleanup methods', () => {
    const result = resultar.ok<number, Error>(1)
    const disposable = result.toDisposable(() => undefined)

    expectTypeOf(result).toExtend<Result<number, Error>>()
    expectTypeOf(disposable).toExtend<DisposableResult<number, Error>>()
    expectTypeOf(disposable).toExtend<Disposable>()
    equal(disposable._unsafeUnwrap(), 1)

    if (false) {
      // @ts-expect-error Result#finally is not part of the current API.
      void result.finally
    }
  })

  it('keeps ResultAsync disposable APIs and omits removed deprecated methods', async () => {
    const result = resultar.okAsync<number, Error>(1)
    const disposable = result.toAsyncDisposable(() => undefined)

    expectTypeOf(result).toExtend<ResultAsync<number, Error>>()
    expectTypeOf(disposable).toExtend<DisposableResultAsync<number, Error>>()
    expectTypeOf(disposable).toExtend<AsyncDisposable>()
    equal((await disposable)._unsafeUnwrap(), 1)

    if (false) {
      // @ts-expect-error ResultAsync#finally is not part of the current API.
      void result.finally
      // @ts-expect-error ResultAsync#safeUnwrap is not part of the current API.
      void result.safeUnwrap
      // @ts-expect-error safeTryAsync is not part of the current API.
      void resultar.safeTryAsync
    }
  })

  it('exports ResultAsync concurrency option types', () => {
    const concurrencyValues: readonly ResultAsyncConcurrency[] = [2, 'unbounded']

    deepEqual(concurrencyValues, [2, 'unbounded'])

    if (false) {
      // @ts-expect-error inherited concurrency sentinel is not part of Resultar.
      const invalid: ResultAsyncConcurrency = 'inherit'

      equal(invalid, undefined)
    }
  })

  it('exports ResultAsync retry option types', () => {
    const task: ResultAsyncRetryTask<number, 'retry-error'> = () => resultar.errAsync('retry-error')
    const context: ResultAsyncRetryContext = { attempt: 0, nextAttempt: 1, retriesRemaining: 1 }
    const options: ResultAsyncRetryOptions<'retry-error'> = { jittered: 0.2, times: 1 }
    const fallbackOptions: ResultAsyncRetryOrElseOptions<'retry-error', 'fallback-error', string> =
      { orElse: () => resultar.err('fallback-error'), times: 1 }

    equal(typeof task, 'function')
    deepEqual(context, { attempt: 0, nextAttempt: 1, retriesRemaining: 1 })
    deepEqual(options, { jittered: 0.2, times: 1 })
    equal(typeof fallbackOptions.orElse, 'function')
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

    const methodShapedSignal: ResultAsyncAbortSignal = {
      aborted: false,
      addEventListener() {
        return undefined
      },
      removeEventListener() {
        return undefined
      },
    }

    const methodShapedHandle: ResultAsyncRaceHandle<number, string> = {
      abort() {
        return undefined
      },
      signal: methodShapedSignal,
      wait() {
        return resultar.okAsync<number, string>(1)
      },
    }

    type ReasonMembers = { Foo: { readonly id: string }; Nothing: Record<never, never> }

    const methodShapedEnumMatch: Pick<TaggedEnumFactory<ReasonMembers>, '$match'> = {
      $match() {
        throw new Error('type-only')
      },
    }

    expectTypeOf(methodShapedResult).toExtend<
      Pick<ResultOperations<number, string>, 'map' | 'unwrapOr'>
    >()
    expectTypeOf(methodShapedSignal).toExtend<ResultAsyncAbortSignal>()
    expectTypeOf(methodShapedHandle).toExtend<ResultAsyncRaceHandle<number, string>>()
    expectTypeOf(methodShapedEnumMatch).toExtend<Pick<TaggedEnumFactory<ReasonMembers>, '$match'>>()
  })

  it('keeps public method-like properties writable at the type level', () => {
    if (false) {
      const result = resultar.ok<number, string>(1)
      const map = result.map
      result.map = map

      const signal: ResultAsyncAbortSignal = new AbortController().signal
      const addEventListener = signal.addEventListener
      signal.addEventListener = addEventListener

      const TestError = resultar.createTaggedError({ message: 'failed', name: 'TestError' })
      const err = TestError.err
      TestError.err = err

      const reason = resultar.taggedEnum<{ Nothing: Record<never, never> }>()
      const match = reason.$match
      reason.$match = match

      const redacted = resultar.redact('secret')
      const toString = redacted.toString
      redacted.toString = toString
    }
  })
})
