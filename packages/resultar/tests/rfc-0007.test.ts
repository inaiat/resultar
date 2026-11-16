import { expect, expectTypeOf, test } from 'vite-plus/test'
import { ResultTask } from '../src/index.js'

test('Promise factories are lazy, repeatable and have no typed failures', async () => {
  let runs = 0
  const task = ResultTask.fromPromise(async () => {
    runs += 1
    return runs
  })
  expectTypeOf(task).toEqualTypeOf<ResultTask<number, never, never>>()
  expect(runs).toBe(0)
  expect(await task.runPromise()).toBe(1)
  expect(await task.runPromise()).toBe(2)
})

for (const synchronous of [true, false]) {
  test(`Promise failure is a defect: synchronous=${synchronous}`, async () => {
    const error = new Error('SDK')
    const task = ResultTask.fromPromise<number>(() => {
      if (synchronous) throw error
      return Promise.reject(error)
    })
    expect(await task.runExit()).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: error } })
    await expect(task.runPromise()).rejects.toBe(error)
    expect(await task.catchCause(() => ResultTask.ok(42)).runPromise()).toBe(42)
  })
}

test('pre-aborted runs never start a Promise factory', async () => {
  let calls = 0
  const controller = new AbortController()
  controller.abort('stop')
  const task = ResultTask.fromPromise(async () => {
    calls += 1
    return calls
  })
  expect(await task.runExit({ signal: controller.signal })).toEqual({
    _tag: 'Failure',
    cause: { _tag: 'Interrupt', reason: 'stop' },
  })
  expect(calls).toBe(0)
})

for (const reject of [false, true]) {
  test(`concurrent runs preserve late settlement precedence: reject=${reject}`, async () => {
    const pending = [Promise.withResolvers<number>(), Promise.withResolvers<number>()] as const
    const started = Promise.withResolvers<void>()
    const signals: AbortSignal[] = []
    const task = ResultTask.fromPromise((signal) => {
      signals.push(signal)
      if (signals.length === 2) started.resolve()
      return pending[signals.length === 1 ? 0 : 1].promise
    })
    const controller = new AbortController()
    const first = task.runExit({ signal: controller.signal })
    const second = task.runPromise()
    await started.promise
    controller.abort('stop')
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
    const error = new DOMException('stopped', 'AbortError')
    if (reject) pending[0].reject(error)
    else pending[0].resolve(1)
    pending[1].resolve(2)
    expect(await second).toBe(2)
    expect(await first).toEqual({
      _tag: 'Failure',
      cause: reject ? { _tag: 'Die', defect: error } : { _tag: 'Interrupt', reason: 'stop' },
    })
  })
}

test('adopts structural thenables and preserves thrown adoption failures', async () => {
  const thenable: PromiseLike<number> = {
    then: (resolve, reject) => Promise.resolve(42).then(resolve, reject),
  }
  expect(await ResultTask.fromPromise(() => thenable).runPromise()).toBe(42)
  const error = new Error('then getter')
  const poisoned: PromiseLike<number> = {
    get then(): PromiseLike<number>['then'] {
      throw error
    },
  }
  await expect(ResultTask.fromPromise(() => poisoned).runPromise()).rejects.toBe(error)
})
