import { equal } from 'node:assert'
import { describe, it } from 'vite-plus/test'

import { errAsync, okAsync } from '../src/index.js'

const callbackError = new Error('side effect failed')

describe('ResultAsync inspect callback failures', () => {
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
})
