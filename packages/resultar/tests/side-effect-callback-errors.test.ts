/* eslint-disable @typescript-eslint/no-deprecated -- These compatibility tests exercise supported legacy APIs. */
import { equal, rejects } from 'node:assert'
import { describe, it } from 'vite-plus/test'

import { err, errAsync, ok, okAsync } from '../src/index.js'

const callbackError = new Error('side effect failed')

describe('Result side-effect callback failures', () => {
  it('swallows tap callback errors and preserves the Ok result', () => {
    const result = ok<number, Error>(1).tap(() => {
      throw callbackError
    })

    equal(result.isOk(), true)
    equal(result._unsafeUnwrap(), 1)
  })

  it('swallows tapError callback errors and preserves the Err result', () => {
    const original = new Error('original')
    const result = err<number, Error>(original).tapError(() => {
      throw callbackError
    })

    equal(result.isErr(), true)
    equal(result._unsafeUnwrapErr(), original)
  })

  it('swallows log callback errors on Ok and Err results', () => {
    const original = new Error('original')
    const okResult = ok<number, Error>(1).log(() => {
      throw callbackError
    })
    const errResult = err<number, Error>(original).log(() => {
      throw callbackError
    })

    equal(okResult._unsafeUnwrap(), 1)
    equal(errResult._unsafeUnwrapErr(), original)
  })

  it('swallows disposable callback errors and preserves the original result', () => {
    const disposable = ok<number, Error>(1).toDisposable(() => {
      throw callbackError
    })

    disposable[Symbol.dispose]()

    equal(disposable._unsafeUnwrap(), 1)
  })
})

describe('ResultAsync side-effect callback failures', () => {
  it('swallows inspect callback errors and propagates tap callback defects', async () => {
    const result = await okAsync<number, Error>(1).inspect(() => {
      throw callbackError
    })

    equal(result.isOk(), true)
    equal(result._unsafeUnwrap(), 1)

    await rejects(
      async () =>
        await okAsync<number, Error>(1).tap(() => {
          throw callbackError
        }),
      callbackError,
    )
  })

  it('swallows rejected inspect callbacks and propagates rejected tap callbacks', async () => {
    const result = await okAsync<number, Error>(1).inspect(
      async () => await Promise.reject(callbackError),
    )

    equal(result.isOk(), true)
    equal(result._unsafeUnwrap(), 1)

    await rejects(
      async () =>
        await okAsync<number, Error>(1).tap(async () => await Promise.reject(callbackError)),
      callbackError,
    )
  })

  it('swallows inspectError callback errors and propagates tapError callback defects', async () => {
    const original = new Error('original')
    const result = await errAsync<number, Error>(original).inspectError(() => {
      throw callbackError
    })

    equal(result.isErr(), true)
    equal(result._unsafeUnwrapErr(), original)

    await rejects(
      async () =>
        await errAsync<number, Error>(original).tapError(() => {
          throw callbackError
        }),
      callbackError,
    )
  })

  it('swallows log callback errors on Ok and Err results', async () => {
    const original = new Error('original')
    const okResult = await okAsync<number, Error>(1).log(() => {
      throw callbackError
    })
    const errResult = await errAsync<number, Error>(original).log(() => {
      throw callbackError
    })

    equal(okResult._unsafeUnwrap(), 1)
    equal(errResult._unsafeUnwrapErr(), original)
  })

  it('swallows async disposable callback errors and preserves the original result', async () => {
    const disposable = okAsync<number, Error>(1).toAsyncDisposable(
      async () => await Promise.reject(callbackError),
    )

    await disposable[Symbol.asyncDispose]()

    equal((await disposable)._unsafeUnwrap(), 1)
  })
})
