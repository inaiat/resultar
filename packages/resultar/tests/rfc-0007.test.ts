import { expect, expectTypeOf, test } from 'vite-plus/test'
import {
  ResultTask,
  ResultAsync,
  ok,
  err,
  type Result,
  type ResultTaskScope,
} from '../src/index.js'

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
    await expect(Promise.resolve(task.runResult())).rejects.toBe(error)
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

const genericFactory = <A>(factory: (signal: AbortSignal) => PromiseLike<A>) =>
  ResultTask.fromPromise(factory)
const checkTypes = () => {
  const union = genericFactory(() => Promise.resolve(Math.random() > 0.5 ? 1 : 'value'))
  expectTypeOf(union).toEqualTypeOf<ResultTask<number | string, never, never>>()
  const generic = <A>(value: A): ResultTask<A, never, never> =>
    genericFactory(() => Promise.resolve(value))
  expectTypeOf(generic({ name: 'account' })).toEqualTypeOf<ResultTask<{ name: string }>>()
  const nested = (value: Result<number, 'failed'>) =>
    ResultTask.fromPromise(() => Promise.resolve(value))
  expectTypeOf<ReturnType<typeof nested>>().toEqualTypeOf<ResultTask<Result<number, 'failed'>>>()
  // @ts-expect-error An eager Promise is not a factory.
  ResultTask.fromPromise(Promise.resolve(1))
  // @ts-expect-error Defect boundaries do not accept error mappers.
  ResultTask.fromPromise(() => Promise.resolve(1), String)
  // @ts-expect-error Wait-only boundaries do not accept interruption options.
  ResultTask.fromPromise(() => Promise.resolve(1), { interruption: 'detach' })
  // @ts-expect-error Object try/catch belongs to tryPromise.
  ResultTask.fromPromise({ try: () => Promise.resolve(1), catch: String })
  // @ts-expect-error Synchronous values are not PromiseLike.
  ResultTask.fromPromise(() => 1)
}
expectTypeOf(checkTypes).toBeFunction()

test('fulfilled Results remain ordinary success values and captured Promises remain shared', async () => {
  for (const value of [ok(42), err('expected')]) {
    const captured = Promise.resolve(value)
    const task = ResultTask.fromPromise(() => captured)
    expect(await task.runPromise()).toBe(value)
    expect(await task.runPromise()).toBe(value)
    const result = await task.runResult()
    expect(result.isOk() && result.value).toBe(value)
  }
})

test('native adoption keeps the first settlement and ignores subsequent throws', async () => {
  const defect = new Error('after settlement')
  const multiple: PromiseLike<number> = {
    then(resolve, reject) {
      resolve?.(42)
      reject?.(defect)
      resolve?.(99)
      throw defect
    },
  }
  expect(await ResultTask.fromPromise(() => multiple).runPromise()).toBe(42)
  const throwing: PromiseLike<number> = {
    then() {
      throw defect
    },
  }
  await expect(ResultTask.fromPromise(() => throwing).runPromise()).rejects.toBe(defect)
})

for (const adapter of ['direct', 'bridge'] as const) {
  const adapt = <A>(factory: (signal: AbortSignal) => PromiseLike<A>) =>
    adapter === 'direct'
      ? ResultTask.fromPromise(factory)
      : ResultTask.fromResultAsync((signal) => ResultAsync.fromSafePromise(factory(signal)))
  for (const cancelled of [false, true]) {
    for (const outcome of ['fulfill', 'reject', 'throw'] as const) {
      test(`${adapter}: ${outcome}, cancelled=${cancelled} preserves defect bridge precedence`, async () => {
        const controller = new AbortController()
        const entered = Promise.withResolvers<void>()
        const pending = Promise.withResolvers<number>()
        const defect = new Error('driver')
        const running = adapt((signal) => {
          expect(signal).toBeInstanceOf(AbortSignal)
          entered.resolve()
          if (outcome === 'throw') {
            if (cancelled) controller.abort('stop')
            throw defect
          }
          return pending.promise
        }).runExit({ signal: controller.signal })
        await entered.promise
        if (cancelled) controller.abort('stop')
        if (outcome === 'reject') pending.reject(defect)
        else pending.resolve(42)
        const exit = await running
        if (outcome === 'fulfill') {
          expect(exit).toEqual(
            cancelled
              ? { _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'stop' } }
              : { _tag: 'Success', value: 42 },
          )
        } else expect(exit).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect } })
      })
    }
  }
  for (const cleanup of ['success', 'typed', 'defect'] as const) {
    test(`${adapter}: late acquisition waits for ${cleanup} cleanup, exactly once`, async () => {
      const controller = new AbortController()
      const entered = Promise.withResolvers<void>()
      const pending = Promise.withResolvers<number>()
      const releasing = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      const defect = new Error('cleanup')
      let releases = 0
      let uses = 0
      let finished = false
      const running = ResultTask.scoped(
        ResultTask.acquireRelease({
          acquire: adapt(() => {
            entered.resolve()
            return pending.promise
          }),
          release: () =>
            ResultTask.fromPromise(async (signal) => {
              expect(signal.aborted).toBe(false)
              releases += 1
              releasing.resolve()
              await released.promise
              if (cleanup === 'defect') throw defect
            }).andThen(() =>
              cleanup === 'typed' ? ResultTask.err('close') : ResultTask.ok(undefined),
            ),
        }).andThen(() =>
          ResultTask.sync(() => {
            uses += 1
          }),
        ),
      ).runExit({ signal: controller.signal })
      void running.then(() => {
        finished = true
      })
      await entered.promise
      controller.abort('stop')
      pending.resolve(1)
      await releasing.promise
      expect(finished).toBe(false)
      released.resolve()
      const interrupt = { _tag: 'Interrupt', reason: 'stop' }
      expect(await running).toEqual({
        _tag: 'Failure',
        cause:
          cleanup === 'success'
            ? interrupt
            : {
                _tag: 'Sequential',
                left: interrupt,
                right:
                  cleanup === 'typed' ? { _tag: 'Fail', error: 'close' } : { _tag: 'Die', defect },
              },
      })
      expect(releases).toBe(1)
      expect(uses).toBe(0)
    })
  }
}

test('inner generators retain the documented ownership-before-composition requirement', async () => {
  const pending = Promise.withResolvers<number>()
  const entered = Promise.withResolvers<void>()
  const controller = new AbortController()
  let releases = 0
  const base = ResultTask.fromPromise(() => {
    entered.resolve()
    return pending.promise
  })
  const task = ResultTask.acquireRelease({
    acquire: ResultTask.gen(function* () {
      return yield* base
    }),
    release: () =>
      ResultTask.sync(() => {
        releases += 1
      }),
  })
  expectTypeOf(task).toEqualTypeOf<ResultTask<number, never, ResultTaskScope<never>>>()
  expectTypeOf(ResultTask.scoped(task)).toEqualTypeOf<ResultTask<number>>()
  const running = task.runExit({ signal: controller.signal })
  await entered.promise
  controller.abort('stop')
  pending.resolve(42)
  expect(await running).toEqual({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'stop' } })
  expect(releases).toBe(0)
})
