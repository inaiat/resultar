import type { Tests } from 'cronometro'

import { cronometro } from 'cronometro'
import * as neverthrow from 'neverthrow'
import { deepStrictEqual, fail, strictEqual } from 'node:assert'

import * as resultar from 'resultar'

type InspectableResult = {
  readonly error?: unknown
  readonly value?: unknown
  isErr(): boolean
  isOk(): boolean
}

const okValue = 10
const errValue = 3
const payload = { id: 1 }
const errorPayload = { code: 'boom' }

let sink: unknown

const consume = (value: unknown): void => {
  sink = value
}

const assertOkValue = (result: unknown, expected: unknown): void => {
  const inspected = result as InspectableResult

  if (!inspected.isOk()) {
    fail('Expected Ok')
  }

  if (typeof expected === 'object' && expected !== null) {
    deepStrictEqual(inspected.value, expected)
    return
  }

  strictEqual(inspected.value, expected)
}

const assertErrValue = (result: unknown, expected: unknown): void => {
  const inspected = result as InspectableResult

  if (!inspected.isErr()) {
    fail('Expected Err')
  }

  strictEqual(inspected.error, expected)
}

const double = (value: number): number => value * 2
const doublePromise = async (value: number): Promise<number> => value * 2

const neverthrowOk = neverthrow.ok<number, number>(okValue)
const neverthrowErr = neverthrow.err<number, number>(errValue)
const resultarOk = resultar.ok<number, number>(okValue)
const resultarErr = resultar.err<number, number>(errValue)

const neverthrowRecoveredOk = neverthrow.ok<number, number>(errValue)
const resultarRecoveredOk = resultar.ok<number, number>(errValue)

const neverthrowJsonParse = neverthrow.fromThrowable(JSON.parse, () => 'JSON parse error')
const resultarJsonParse = resultar.fromThrowable(JSON.parse, () => 'JSON parse error')

const asyncCanBeThrown = async (value: number): Promise<number> => {
  await Promise.resolve()

  if (value % 2 === 0) {
    return value
  }

  throw new Error('odd')
}

const asyncNeverthrowOddNumber = neverthrow.fromAsyncThrowable(asyncCanBeThrown, String)
const asyncResultarOddNumber = resultar.fromThrowableAsync(asyncCanBeThrown, String)

const doubleAsyncNeverthrow = (value: number): neverthrow.ResultAsync<number, number> =>
  neverthrow.okAsync(value * 2)
const doubleAsyncResultar = (value: number): resultar.ResultAsync<number, number> =>
  resultar.okAsync(value * 2)

const neverthrowAllOkList = [neverthrow.ok(1), neverthrow.ok(2), neverthrow.ok(3)]
const resultarAllOkList = [resultar.ok(1), resultar.ok(2), resultar.ok(3)]
const neverthrowWithErrList = [neverthrow.ok(1), neverthrow.err(2), neverthrow.ok(3)]
const resultarWithErrList = [resultar.ok(1), resultar.err(2), resultar.ok(3)]

const assertBenchmarkBehavior = async (): Promise<void> => {
  assertOkValue(neverthrow.ok(payload), payload)
  assertOkValue(resultar.ok(payload), payload)
  assertErrValue(neverthrow.err(errorPayload), errorPayload)
  assertErrValue(resultar.err(errorPayload), errorPayload)

  strictEqual(neverthrowOk.isOk(), true)
  strictEqual(resultarOk.isOk(), true)
  strictEqual(neverthrowErr.isOk(), false)
  strictEqual(resultarErr.isOk(), false)
  strictEqual(neverthrowOk.isErr(), false)
  strictEqual(resultarOk.isErr(), false)
  strictEqual(neverthrowErr.isErr(), true)
  strictEqual(resultarErr.isErr(), true)

  assertOkValue(neverthrowOk.map(double), 20)
  assertOkValue(resultarOk.map(double), 20)
  assertErrValue(neverthrowErr.map(double), errValue)
  assertErrValue(resultarErr.map(double), errValue)

  assertOkValue(neverthrowErr.orElse(() => neverthrowRecoveredOk), errValue)
  assertOkValue(resultarErr.orElse(() => resultarRecoveredOk), errValue)
  assertOkValue(neverthrowOk.andThen((value) => neverthrow.ok(value * 2)), 20)
  assertOkValue(resultarOk.andThen((value) => resultar.ok(value * 2)), 20)
  strictEqual(neverthrowOk.match(double, (error) => error), 20)
  strictEqual(resultarOk.match(double, (error) => error), 20)
  strictEqual(neverthrowErr.match(double, (error) => error), errValue)
  strictEqual(resultarErr.match(double, (error) => error), errValue)

  assertOkValue(neverthrow.Result.combine(neverthrowAllOkList), [1, 2, 3])
  assertOkValue(resultar.Result.combine(resultarAllOkList), [1, 2, 3])
  assertErrValue(neverthrow.Result.combine(neverthrowWithErrList), 2)
  assertErrValue(resultar.Result.combine(resultarWithErrList), 2)

  assertOkValue(neverthrowJsonParse('42'), 42)
  assertOkValue(resultarJsonParse('42'), 42)
  assertErrValue(neverthrowJsonParse('boom'), 'JSON parse error')
  assertErrValue(resultarJsonParse('boom'), 'JSON parse error')

  assertOkValue(await neverthrow.okAsync(okValue), okValue)
  assertOkValue(await resultar.okAsync(okValue), okValue)
  assertErrValue(await neverthrow.errAsync(errValue), errValue)
  assertErrValue(await resultar.errAsync(errValue), errValue)

  assertOkValue(await neverthrow.okAsync(okValue).map(double), 20)
  assertOkValue(await resultar.okAsync(okValue).map(double), 20)
  assertErrValue(await neverthrow.errAsync<number, number>(errValue).map(double), errValue)
  assertErrValue(await resultar.errAsync<number, number>(errValue).map(double), errValue)

  assertOkValue(await neverthrow.okAsync(okValue).andThen(doubleAsyncNeverthrow), 20)
  assertOkValue(await resultar.okAsync(okValue).andThen(doubleAsyncResultar), 20)
  assertErrValue(
    await neverthrow.errAsync<number, number>(errValue).andThen(doubleAsyncNeverthrow),
    errValue,
  )
  assertErrValue(await resultar.errAsync<number, number>(errValue).andThen(doubleAsyncResultar), errValue)

  assertOkValue(await neverthrow.errAsync<number, number>(errValue).orElse(() => neverthrowRecoveredOk), errValue)
  assertOkValue(await resultar.errAsync<number, number>(errValue).orElse(() => resultarRecoveredOk), errValue)

  assertOkValue(await neverthrowOk.asyncMap(doublePromise), 20)
  assertOkValue(await resultarOk.asyncMap(doublePromise), 20)
  assertErrValue(await neverthrowErr.asyncMap(doublePromise), errValue)
  assertErrValue(await resultarErr.asyncMap(doublePromise), errValue)
  assertOkValue(await neverthrowOk.asyncAndThen(doubleAsyncNeverthrow), 20)
  assertOkValue(await resultarOk.asyncAndThen(doubleAsyncResultar), 20)
  assertErrValue(await neverthrowErr.asyncAndThen(doubleAsyncNeverthrow), errValue)
  assertErrValue(await resultarErr.asyncAndThen(doubleAsyncResultar), errValue)

  assertOkValue(await asyncNeverthrowOddNumber(42), 42)
  assertOkValue(await asyncResultarOddNumber(42), 42)
  assertErrValue(await asyncNeverthrowOddNumber(3), 'Error: odd')
  assertErrValue(await asyncResultarOddNumber(3), 'Error: odd')
}

const tests: Tests = {
  'sync/ok construction/neverthrow'() {
    consume(neverthrow.ok(payload))
  },

  'sync/ok construction/resultar'() {
    consume(resultar.ok(payload))
  },

  'sync/err construction/neverthrow'() {
    consume(neverthrow.err(errorPayload))
  },

  'sync/err construction/resultar'() {
    consume(resultar.err(errorPayload))
  },

  'sync/isOk on Ok/neverthrow'() {
    consume(neverthrowOk.isOk())
  },

  'sync/isOk on Ok/resultar'() {
    consume(resultarOk.isOk())
  },

  'sync/isOk on Err/neverthrow'() {
    consume(neverthrowErr.isOk())
  },

  'sync/isOk on Err/resultar'() {
    consume(resultarErr.isOk())
  },

  'sync/isErr on Ok/neverthrow'() {
    consume(neverthrowOk.isErr())
  },

  'sync/isErr on Ok/resultar'() {
    consume(resultarOk.isErr())
  },

  'sync/isErr on Err/neverthrow'() {
    consume(neverthrowErr.isErr())
  },

  'sync/isErr on Err/resultar'() {
    consume(resultarErr.isErr())
  },

  'sync/map on Ok/neverthrow'() {
    consume(neverthrowOk.map(double))
  },

  'sync/map on Ok/resultar'() {
    consume(resultarOk.map(double))
  },

  'sync/map on Err/neverthrow'() {
    consume(neverthrowErr.map(double))
  },

  'sync/map on Err/resultar'() {
    consume(resultarErr.map(double))
  },

  'sync/orElse on Err/neverthrow'() {
    consume(neverthrowErr.orElse(() => neverthrowRecoveredOk))
  },

  'sync/orElse on Err/resultar'() {
    consume(resultarErr.orElse(() => resultarRecoveredOk))
  },

  'sync/andThen on Ok/neverthrow'() {
    consume(neverthrowOk.andThen((value) => neverthrow.ok(value * 2)))
  },

  'sync/andThen on Ok/resultar'() {
    consume(resultarOk.andThen((value) => resultar.ok(value * 2)))
  },

  'sync/match on Ok/neverthrow'() {
    consume(neverthrowOk.match(double, (error) => error))
  },

  'sync/match on Ok/resultar'() {
    consume(resultarOk.match(double, (error) => error))
  },

  'sync/match on Err/neverthrow'() {
    consume(neverthrowErr.match(double, (error) => error))
  },

  'sync/match on Err/resultar'() {
    consume(resultarErr.match(double, (error) => error))
  },

  'sync/combine all Ok/neverthrow'() {
    consume(neverthrow.Result.combine(neverthrowAllOkList))
  },

  'sync/combine all Ok/resultar'() {
    consume(resultar.Result.combine(resultarAllOkList))
  },

  'sync/combine with Err/neverthrow'() {
    consume(neverthrow.Result.combine(neverthrowWithErrList))
  },

  'sync/combine with Err/resultar'() {
    consume(resultar.Result.combine(resultarWithErrList))
  },

  'sync/fromThrowable on Ok/neverthrow'() {
    consume(neverthrowJsonParse('42'))
  },

  'sync/fromThrowable on Ok/resultar'() {
    consume(resultarJsonParse('42'))
  },

  'sync/fromThrowable on Err/neverthrow'() {
    consume(neverthrowJsonParse('boom'))
  },

  'sync/fromThrowable on Err/resultar'() {
    consume(resultarJsonParse('boom'))
  },

  async 'result-async/okAsync await/neverthrow'() {
    consume(await neverthrow.okAsync(okValue))
  },

  async 'result-async/okAsync await/resultar'() {
    consume(await resultar.okAsync(okValue))
  },

  async 'result-async/errAsync await/neverthrow'() {
    consume(await neverthrow.errAsync(errValue))
  },

  async 'result-async/errAsync await/resultar'() {
    consume(await resultar.errAsync(errValue))
  },

  async 'result-async/map on Ok/neverthrow'() {
    consume(await neverthrow.okAsync(okValue).map(double))
  },

  async 'result-async/map on Ok/resultar'() {
    consume(await resultar.okAsync(okValue).map(double))
  },

  async 'result-async/map on Err/neverthrow'() {
    consume(await neverthrow.errAsync<number, number>(errValue).map(double))
  },

  async 'result-async/map on Err/resultar'() {
    consume(await resultar.errAsync<number, number>(errValue).map(double))
  },

  async 'result-async/andThen on Ok/neverthrow'() {
    consume(await neverthrow.okAsync(okValue).andThen(doubleAsyncNeverthrow))
  },

  async 'result-async/andThen on Ok/resultar'() {
    consume(await resultar.okAsync(okValue).andThen(doubleAsyncResultar))
  },

  async 'result-async/andThen on Err/neverthrow'() {
    consume(await neverthrow.errAsync<number, number>(errValue).andThen(doubleAsyncNeverthrow))
  },

  async 'result-async/andThen on Err/resultar'() {
    consume(await resultar.errAsync<number, number>(errValue).andThen(doubleAsyncResultar))
  },

  async 'result-async/orElse on Err/neverthrow'() {
    consume(await neverthrow.errAsync<number, number>(errValue).orElse(() => neverthrowRecoveredOk))
  },

  async 'result-async/orElse on Err/resultar'() {
    consume(await resultar.errAsync<number, number>(errValue).orElse(() => resultarRecoveredOk))
  },

  async 'result/asyncMap on Ok/neverthrow'() {
    consume(await neverthrowOk.asyncMap(doublePromise))
  },

  async 'result/asyncMap on Ok/resultar'() {
    consume(await resultarOk.asyncMap(doublePromise))
  },

  async 'result/asyncMap on Err/neverthrow'() {
    consume(await neverthrowErr.asyncMap(doublePromise))
  },

  async 'result/asyncMap on Err/resultar'() {
    consume(await resultarErr.asyncMap(doublePromise))
  },

  async 'result/asyncAndThen on Ok/neverthrow'() {
    consume(await neverthrowOk.asyncAndThen(doubleAsyncNeverthrow))
  },

  async 'result/asyncAndThen on Ok/resultar'() {
    consume(await resultarOk.asyncAndThen(doubleAsyncResultar))
  },

  async 'result/asyncAndThen on Err/neverthrow'() {
    consume(await neverthrowErr.asyncAndThen(doubleAsyncNeverthrow))
  },

  async 'result/asyncAndThen on Err/resultar'() {
    consume(await resultarErr.asyncAndThen(doubleAsyncResultar))
  },

  async 'result-async/fromThrowable on Ok/neverthrow'() {
    consume(await asyncNeverthrowOddNumber(42))
  },

  async 'result-async/fromThrowable on Ok/resultar'() {
    consume(await asyncResultarOddNumber(42))
  },

  async 'result-async/fromThrowable on Err/neverthrow'() {
    consume(await asyncNeverthrowOddNumber(3))
  },

  async 'result-async/fromThrowable on Err/resultar'() {
    consume(await asyncResultarOddNumber(3))
  },
}

const selectTests = (allTests: Tests): Tests => {
  const filter = process.env.BENCH_FILTER

  if (!filter) {
    return allTests
  }

  const selected = Object.fromEntries(
    Object.entries(allTests).filter(([name]) => name.includes(filter)),
  ) as Tests

  if (Object.keys(selected).length === 0) {
    throw new Error(`No benchmark tests matched BENCH_FILTER=${filter}`)
  }

  return selected
}

const parseIterations = (): number => {
  const rawIterations = process.env.BENCH_ITERATIONS

  if (!rawIterations) {
    return 10_000
  }

  const iterations = Number.parseInt(rawIterations, 10)

  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new Error(`Invalid BENCH_ITERATIONS=${rawIterations}`)
  }

  return iterations
}

await assertBenchmarkBehavior()

cronometro(
  selectTests(tests),
  {
    iterations: parseIterations(),
    print: { colors: process.env.BENCH_COLORS === '1' },
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

    void sink
  },
)
