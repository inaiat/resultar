import { equal } from 'node:assert'
import { describe, expectTypeOf, it } from 'vite-plus/test'

import { Result, err, ok } from '../src/result.js'

describe('Result type narrowing', () => {
  it('exposes only value after isOk', () => {
    const result = ok<number, string>(123)

    if (result.isOk()) {
      expectTypeOf(result.value).toEqualTypeOf<number>()
      // @ts-expect-error Ok results do not expose an error property.
      equal(result.error, undefined)
    }
  })

  it('exposes only error after isErr', () => {
    const result = err<number, string>('failure')

    if (result.isErr()) {
      expectTypeOf(result.error).toEqualTypeOf<string>()
      // @ts-expect-error Err results do not expose a value property.
      equal(result.value, undefined)
    }
  })

  it('does not expose value in an Err branch from fromThrowable', () => {
    const resultarJsonParse = Result.fromThrowable(JSON.parse, () => 'JSON parse error')
    const result = resultarJsonParse('boom')

    if (result.isErr()) {
      expectTypeOf(result.error).toEqualTypeOf<string>()
      // @ts-expect-error Err results do not expose a value property.
      equal(result.value, undefined)
    }
  })
})
