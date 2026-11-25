import { equal } from 'node:assert'
import { describe, it } from 'vite-plus/test'

import { errAsync, okAsync } from '../src/entries/async.js'
import { err, ok } from '../src/index.js'

const callbackError = new Error('side effect failed')

describe('Result side-effect callback failures', () => {
  it('swallows inspect callback errors and preserves the Ok result', () => {
    const result = ok<number, Error>(1).inspect(() => {
      throw callbackError
    })

    equal(result.isOk(), true)
    equal(result._unsafeUnwrap(), 1)
  })

  it('swallows inspectError callback errors and preserves the Err result', () => {
    const original = new Error('original')
    const result = err<number, Error>(original).inspectError(() => {
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
  it('swallows inspect callback errors and preserves the Ok result', async () => {
    const result = await okAsync<number, Error>(1).inspect(() => {
      throw callbackError
    })

    equal(result.isOk(), true)
    equal(result._unsafeUnwrap(), 1)
  })

  it('swallows rejected inspect callbacks and preserves the Ok result', async () => {
    const result = await okAsync<number, Error>(1).inspect(
      async () => await Promise.reject(callbackError),
    )

    equal(result.isOk(), true)
    equal(result._unsafeUnwrap(), 1)
  })

  it('swallows inspectError callback errors and preserves the Err result', async () => {
    const original = new Error('original')
    const result = await errAsync<number, Error>(original).inspectError(() => {
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
})
