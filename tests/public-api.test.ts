import { deepEqual, equal } from 'node:assert'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import type { DisposableResult, DisposableResultAsync, Result, ResultAsync } from '../src/index.js'

import * as resultar from '../src/index.js'

describe('public API', () => {
  it('exports the intended runtime entrypoint surface', () => {
    deepEqual(Object.keys(resultar).toSorted(), [
      'DisposableResult',
      'DisposableResultAsync',
      'Result',
      'ResultAsync',
      'createTaggedError',
      'err',
      'errAsync',
      'findCause',
      'fromPromise',
      'fromSafePromise',
      'fromThrowable',
      'fromThrowableAsync',
      'isError',
      'matchError',
      'matchErrorPartial',
      'ok',
      'okAsync',
      'safeTry',
      'tryCatch',
      'tryCatchAsync',
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
      // @ts-expect-error Result#finally was removed before 2.0.0 stable.
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
      // @ts-expect-error ResultAsync#finally was removed before 2.0.0 stable.
      void result.finally
      // @ts-expect-error ResultAsync#safeUnwrap was removed before 2.0.0 stable.
      void result.safeUnwrap
      // @ts-expect-error safeTryAsync was removed before 2.0.0 stable.
      void resultar.safeTryAsync
    }
  })
})
