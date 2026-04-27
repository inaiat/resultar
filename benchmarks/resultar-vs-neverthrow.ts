import type { Tests } from 'cronometro'

import { cronometro } from 'cronometro'
import * as neverthrow from 'neverthrow'
import { fail, strictEqual } from 'node:assert'

import * as resultar from '../dist/index.js'

const maybeResultNeverthrow = (value: number): neverthrow.Result<number, number> =>
  value % 2 === 0 ? neverthrow.ok(value) : neverthrow.err(value)

const maybeResultResultar = (value: number): resultar.Result<number, number> =>
  value % 2 === 0 ? resultar.ok(value) : resultar.err(value)

const maybeAsyncNeverthrow = (value: number): neverthrow.ResultAsync<number, number> =>
  value % 2 === 0 ? neverthrow.okAsync(value) : neverthrow.errAsync(value)

const maybeAsyncResultar = (value: number): resultar.ResultAsync<number, number> =>
  value % 2 === 0 ? resultar.okAsync(value) : resultar.errAsync(value)

const asyncCanBeThrown = async (value: number): Promise<number> => {
  await Promise.resolve()
  if (value % 2 === 0) {
    return value
  }
  throw new Error('odd')
}

const neverthrowJsonParse = neverthrow.fromThrowable(JSON.parse, () => 'JSON parse error')
const resultarJsonParse = resultar.fromThrowable(JSON.parse, () => 'JSON parse error')

const asyncNeverthrowOddNumber = neverthrow.fromAsyncThrowable(asyncCanBeThrown, String)
const asyncResultarOddNumber = resultar.fromThrowableAsync(asyncCanBeThrown, String)
const doubleAsyncNeverthrow = (value: number): neverthrow.ResultAsync<number, number> =>
  neverthrow.okAsync(value * 2)
const doubleAsyncResultar = (value: number): resultar.ResultAsync<number, number> =>
  resultar.okAsync(value * 2)
const doublePromise = async (value: number): Promise<number> => {
  await Promise.resolve()
  return value * 2
}
const neverthrowAllOkList = [neverthrow.ok(1), neverthrow.ok(2), neverthrow.ok(3)]
const resultarAllOkList = [resultar.ok(1), resultar.ok(2), resultar.ok(3)]
const neverthrowWithErrList = [neverthrow.ok(1), neverthrow.err(2), neverthrow.ok(3)]
const resultarWithErrList = [resultar.ok(1), resultar.err(2), resultar.ok(3)]

const tests: Tests = {
  'sync/ok construction/neverthrow'() {
    const date = new Date()
    const { value } = neverthrow.ok(date)

    strictEqual(value, date)
  },

  'sync/ok construction/resultar'() {
    const date = new Date()
    const { value } = resultar.ok(date)

    strictEqual(value, date)
  },

  'sync/err construction/neverthrow'() {
    const boom = new Error('boom')
    const { error } = neverthrow.err(boom)

    strictEqual(error, boom)
  },

  'sync/err construction/resultar'() {
    const boom = new Error('boom')
    const { error } = resultar.err(boom)

    strictEqual(error, boom)
  },

  'sync/isOk on Ok/neverthrow'() {
    const result = maybeResultNeverthrow(10)

    strictEqual(result.isOk(), true)
  },

  'sync/isOk on Ok/resultar'() {
    const result = maybeResultResultar(10)

    strictEqual(result.isOk(), true)
  },

  'sync/isOk on Err/neverthrow'() {
    const result = maybeResultNeverthrow(3)

    strictEqual(result.isOk(), false)
  },

  'sync/isOk on Err/resultar'() {
    const result = maybeResultResultar(3)

    strictEqual(result.isOk(), false)
  },

  'sync/isErr on Ok/neverthrow'() {
    const result = maybeResultNeverthrow(10)

    strictEqual(result.isErr(), false)
  },

  'sync/isErr on Ok/resultar'() {
    const result = maybeResultResultar(10)

    strictEqual(result.isErr(), false)
  },

  'sync/isErr on Err/neverthrow'() {
    const result = maybeResultNeverthrow(3)

    strictEqual(result.isErr(), true)
  },

  'sync/isErr on Err/resultar'() {
    const result = maybeResultResultar(3)

    strictEqual(result.isErr(), true)
  },

  'sync/map on Ok/neverthrow'() {
    const result = maybeResultNeverthrow(10).map((number) => number * 2)

    if (result.isOk()) {
      strictEqual(result.value, 20)
    } else {
      fail()
    }
  },

  'sync/map on Ok/resultar'() {
    const result = maybeResultResultar(10).map((number) => number * 2)

    if (result.isOk()) {
      strictEqual(result.value, 20)
    } else {
      fail()
    }
  },

  'sync/map on Err/neverthrow'() {
    const result = maybeResultNeverthrow(3).map((number) => number * 2)

    if (result.isErr()) {
      strictEqual(result.error, 3)
    } else {
      fail()
    }
  },

  'sync/map on Err/resultar'() {
    const result = maybeResultResultar(3).map((number) => number * 2)

    if (result.isErr()) {
      strictEqual(result.error, 3)
    } else {
      fail()
    }
  },

  'sync/orElse on Err/neverthrow'() {
    const result = maybeResultNeverthrow(3).orElse(() => neverthrow.ok(3))

    if (result.isOk()) {
      strictEqual(result.value, 3)
    } else {
      fail()
    }
  },

  'sync/orElse on Err/resultar'() {
    const result = maybeResultResultar(3).orElse(() => resultar.ok(3))

    if (result.isOk()) {
      strictEqual(result.value, 3)
    } else {
      fail()
    }
  },

  'sync/andThen on Ok/neverthrow'() {
    const result = maybeResultNeverthrow(2)
      .andThen((value) => neverthrow.ok(value * 2))
      .andThen((value) => neverthrow.ok(value * 2))

    if (result.isOk()) {
      strictEqual(result.value, 8)
    } else {
      fail()
    }
  },

  'sync/andThen on Ok/resultar'() {
    const result = maybeResultResultar(2)
      .andThen((value) => resultar.ok(value * 2))
      .andThen((value) => resultar.ok(value * 2))

    if (result.isOk()) {
      strictEqual(result.value, 8)
    } else {
      fail()
    }
  },

  'sync/match on Ok/neverthrow'() {
    const value = maybeResultNeverthrow(10).match(
      (number) => number * 2,
      (error) => error,
    )

    strictEqual(value, 20)
  },

  'sync/match on Ok/resultar'() {
    const value = maybeResultResultar(10).match(
      (number) => number * 2,
      (error) => error,
    )

    strictEqual(value, 20)
  },

  'sync/match on Err/neverthrow'() {
    const value = maybeResultNeverthrow(3).match(
      (number) => number * 2,
      (error) => error,
    )

    strictEqual(value, 3)
  },

  'sync/match on Err/resultar'() {
    const value = maybeResultResultar(3).match(
      (number) => number * 2,
      (error) => error,
    )

    strictEqual(value, 3)
  },

  async 'async/asyncAndThen on Ok/neverthrow'() {
    const result = await maybeResultNeverthrow(10).asyncAndThen(doubleAsyncNeverthrow)

    if (result.isOk()) {
      strictEqual(result.value, 20)
    } else {
      fail()
    }
  },

  async 'async/asyncAndThen on Ok/resultar'() {
    const result = await maybeResultResultar(10).asyncAndThen(doubleAsyncResultar)

    if (result.isOk()) {
      strictEqual(result.value, 20)
    } else {
      fail()
    }
  },

  async 'async/asyncAndThen on Err/neverthrow'() {
    const result = await maybeResultNeverthrow(3).asyncAndThen(doubleAsyncNeverthrow)

    if (result.isErr()) {
      strictEqual(result.error, 3)
    } else {
      fail()
    }
  },

  async 'async/asyncAndThen on Err/resultar'() {
    const result = await maybeResultResultar(3).asyncAndThen(doubleAsyncResultar)

    if (result.isErr()) {
      strictEqual(result.error, 3)
    } else {
      fail()
    }
  },

  async 'async/asyncMap on Ok/neverthrow'() {
    const result = await maybeResultNeverthrow(10).asyncMap(doublePromise)

    if (result.isOk()) {
      strictEqual(result.value, 20)
    } else {
      fail()
    }
  },

  async 'async/asyncMap on Ok/resultar'() {
    const result = await maybeResultResultar(10).asyncMap(doublePromise)

    if (result.isOk()) {
      strictEqual(result.value, 20)
    } else {
      fail()
    }
  },

  async 'async/asyncMap on Err/neverthrow'() {
    const result = await maybeResultNeverthrow(3).asyncMap(doublePromise)

    if (result.isErr()) {
      strictEqual(result.error, 3)
    } else {
      fail()
    }
  },

  async 'async/asyncMap on Err/resultar'() {
    const result = await maybeResultResultar(3).asyncMap(doublePromise)

    if (result.isErr()) {
      strictEqual(result.error, 3)
    } else {
      fail()
    }
  },

  'sync/combine all Ok/neverthrow'() {
    const result = neverthrow.Result.combine(neverthrowAllOkList)

    if (result.isOk()) {
      strictEqual(result.value.length, 3)
    } else {
      fail()
    }
  },

  'sync/combine all Ok/resultar'() {
    const result = resultar.Result.combine(resultarAllOkList)

    if (result.isOk()) {
      strictEqual(result.value.length, 3)
    } else {
      fail()
    }
  },

  'sync/combine with Err/neverthrow'() {
    const result = neverthrow.Result.combine(neverthrowWithErrList)

    if (result.isErr()) {
      strictEqual(result.error, 2)
    } else {
      fail()
    }
  },

  'sync/combine with Err/resultar'() {
    const result = resultar.Result.combine(resultarWithErrList)

    if (result.isErr()) {
      strictEqual(result.error, 2)
    } else {
      fail()
    }
  },

  'sync/fromThrowable on Ok/neverthrow'() {
    const result = neverthrowJsonParse('42')

    if (result.isOk()) {
      strictEqual(result.value, 42)
    } else {
      fail()
    }
  },

  'sync/fromThrowable on Ok/resultar'() {
    const result = resultarJsonParse('42')

    if (result.isOk()) {
      strictEqual(result.value, 42)
    } else {
      fail()
    }
  },

  'sync/fromThrowable on Err/neverthrow'() {
    const result = neverthrowJsonParse('boom')

    if (result.isErr()) {
      strictEqual(result.error, 'JSON parse error')
    } else {
      fail()
    }
  },

  'sync/fromThrowable on Err/resultar'() {
    const result = resultarJsonParse('boom')

    if (result.isErr()) {
      strictEqual(result.error, 'JSON parse error')
    } else {
      fail()
    }
  },

  async 'async/fromThrowable on Ok/neverthrow'() {
    const result = await asyncNeverthrowOddNumber(42)

    if (result.isOk()) {
      strictEqual(result.value, 42)
    } else {
      fail()
    }
  },

  async 'async/fromThrowable on Ok/resultar'() {
    const result = await asyncResultarOddNumber(42)

    if (result.isOk()) {
      strictEqual(result.value, 42)
    } else {
      fail()
    }
  },

  async 'async/fromThrowable on Err/neverthrow'() {
    const result = await asyncNeverthrowOddNumber(3)

    if (result.isErr()) {
      strictEqual(result.error, 'Error: odd')
    } else {
      fail()
    }
  },

  async 'async/fromThrowable on Err/resultar'() {
    const result = await asyncResultarOddNumber(3)

    if (result.isErr()) {
      strictEqual(result.error, 'Error: odd')
    } else {
      fail()
    }
  },

  async 'async/orElse on Err/neverthrow'() {
    const result = await maybeAsyncNeverthrow(3).orElse(() => neverthrow.ok(3))

    if (result.isOk()) {
      strictEqual(result.value, 3)
    } else {
      fail()
    }
  },

  async 'async/orElse on Err/resultar'() {
    const result = await maybeAsyncResultar(3).orElse(() => resultar.ok(3))

    if (result.isOk()) {
      strictEqual(result.value, 3)
    } else {
      fail()
    }
  },

  async 'async/map on Ok/neverthrow'() {
    const result = await maybeAsyncNeverthrow(10)

    if (result.isOk()) {
      strictEqual(result.value, 10)
    } else {
      fail()
    }
  },

  async 'async/map on Ok/resultar'() {
    const result = await maybeAsyncResultar(10)

    if (result.isOk()) {
      strictEqual(result.value, 10)
    } else {
      fail()
    }
  },

  async 'async/map on Err/neverthrow'() {
    const result = await maybeAsyncNeverthrow(3)

    if (result.isErr()) {
      strictEqual(result.error, 3)
    } else {
      fail()
    }
  },

  async 'async/map on Err/resultar'() {
    const result = await maybeAsyncResultar(3)

    if (result.isErr()) {
      strictEqual(result.error, 3)
    } else {
      fail()
    }
  },
}

cronometro(
  tests,
  {
    iterations: 10_000,
    print: { colors: true },
    setup: {
      single(callback) {
        callback()
      },
    },
    warmup: true,
  },
  (error) => {
    if (error) {
      throw error
    }
  },
)
