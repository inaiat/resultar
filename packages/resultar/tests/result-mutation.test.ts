import { equal, throws } from 'node:assert'
import { describe, it } from 'vite-plus/test'
import { Result, ok } from '../src/index.js'

describe('Result.gen callable factories', () => {
  it('propagates generator defects without treating a factory catch property as options', () => {
    const defect = new Error('generator defect')
    let catchCalls = 0
    const body = Object.assign(
      function* () {
        yield* ok(1)
        throw defect
      },
      {
        catch: () => {
          catchCalls += 1
          return 'mapped error'
        },
      },
    )

    throws(
      () => Result.gen(body),
      (error: unknown) => error === defect,
    )
    equal(catchCalls, 0)
  })
})
