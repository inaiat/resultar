import { equal } from 'node:assert'
import { describe, it, vi } from 'vite-plus/test'

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

  it('swallows finally callback errors and preserves the original result', () => {
    const original = new Error('original')
    const okResult = ok<number, Error>(1).finally(() => {
      throw callbackError
    })
    const errResult = err<number, Error>(original).finally(() => {
      throw callbackError
    })

    equal(okResult._unsafeUnwrap(), 1)
    equal(errResult._unsafeUnwrapErr(), original)
  })
})

describe('ResultAsync side-effect callback failures', () => {
  it('swallows tap callback errors and preserves the Ok result', async () => {
    const result = await okAsync<number, Error>(1).tap(() => {
      throw callbackError
    })

    equal(result.isOk(), true)
    equal(result._unsafeUnwrap(), 1)
  })

  it('swallows rejected tap callbacks and preserves the Ok result', async () => {
    const result = await okAsync<number, Error>(1).tap(
      async () => await Promise.reject(callbackError),
    )

    equal(result.isOk(), true)
    equal(result._unsafeUnwrap(), 1)
  })

  it('swallows tapError callback errors and preserves the Err result', async () => {
    const original = new Error('original')
    const result = await errAsync<number, Error>(original).tapError(() => {
      throw callbackError
    })

    equal(result.isErr(), true)
    equal(result._unsafeUnwrapErr(), original)
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

  it('awaits and swallows finally callback errors while preserving the original result', async () => {
    const finalizer = vi.fn(async () => await Promise.reject(callbackError))
    const result = await okAsync<number, Error>(1).finally(finalizer)

    equal(finalizer.mock.calls.length, 1)
    equal(result._unsafeUnwrap(), 1)
  })

  it('swallows finally callback errors on Err results', async () => {
    const original = new Error('original')
    const result = await errAsync<number, Error>(original).finally(() => {
      throw callbackError
    })

    equal(result._unsafeUnwrapErr(), original)
  })
})
