import { deepEqual, equal } from 'node:assert'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import type {
  DisposableResult,
  DisposableResultAsync,
  Result,
  ResultAsync,
  ResultAsyncConcurrency,
  ResultAsyncRetryContext,
  ResultAsyncRetryOptions,
  ResultAsyncRetryOrElseOptions,
  ResultAsyncRetryTask,
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
      // @ts-expect-error inherited Effect-style concurrency is not part of Resultar.
      const invalid: ResultAsyncConcurrency = 'inherit'

      equal(invalid, undefined)
    }
  })

  it('exports ResultAsync retry option types', () => {
    const task: ResultAsyncRetryTask<number, 'retry-error'> = () => resultar.errAsync('retry-error')
    const context: ResultAsyncRetryContext = { attempt: 0, nextAttempt: 1, retriesRemaining: 1 }
    const options: ResultAsyncRetryOptions<'retry-error'> = { times: 1 }
    const fallbackOptions: ResultAsyncRetryOrElseOptions<'retry-error', 'fallback-error', string> =
      { orElse: () => resultar.err('fallback-error'), times: 1 }

    equal(typeof task, 'function')
    deepEqual(context, { attempt: 0, nextAttempt: 1, retriesRemaining: 1 })
    deepEqual(options, { times: 1 })
    equal(typeof fallbackOptions.orElse, 'function')
  })
})
