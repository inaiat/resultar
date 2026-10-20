import { equal } from 'node:assert'
import { describe, it } from 'vite-plus/test'

import { errAsync, okAsync, ResultTask } from '../src/index.js'

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

  it('does not await ResultTask values returned from inspect callbacks', async () => {
    let thenCalled = false
    const task = Object.assign(ResultTask.ok(1), {
      // oxlint-disable-next-line unicorn/no-thenable -- testing that ResultTask values are never awaited as thenables
      then(resolve: () => void) {
        thenCalled = true
        resolve()
      },
    })
    const result = await okAsync<number, Error>(1).inspect(() => task)

    equal(result.isOk(), true)
    equal(result._unsafeUnwrap(), 1)
    equal(thenCalled, false)
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
