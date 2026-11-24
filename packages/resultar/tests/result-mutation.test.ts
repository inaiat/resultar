import { deepEqual, equal, throws } from 'node:assert'
import { describe, it } from 'vite-plus/test'
import { Result, ok } from '../src/index.js'

it('combines record entries as writable and configurable own properties', () => {
  const input = { ['__proto__']: ok(42) }
  for (const result of [Result.all(input), Result.validateAll(input)]) {
    const combined = result.unwrapOrThrow()
    equal(Object.getPrototypeOf(combined), Object.prototype)
    deepEqual(Object.getOwnPropertyDescriptor(combined, '__proto__'), {
      value: 42,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
})

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
