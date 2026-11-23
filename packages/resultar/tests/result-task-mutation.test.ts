import { describe, expect, it, vi } from 'vite-plus/test'

import { Cause, Clock, err, ok, ResultTask, Retry } from '../src/index.js'
import type { Exit, Result } from '../src/index.js'
import { isCleanupCause } from '../src/task/cleanup-cause.js'
import { runRuntimeTask } from '../src/task/task-runtime-bridge.js'
import type { ResultTaskRuntimeContext } from '../src/task/task-service.js'

// Internal fixtures exercise interpreter inputs that public factories normalize before execution.
const InternalPromiseTask = ResultTask as unknown as new <A, E>(
  promise: Promise<Result<A, E>>,
) => ResultTask<A, E>

const InternalCustomTask = ResultTask as unknown as new <A, E>(instruction: {
  readonly _tag: 'Custom'
  readonly execute: (context: ResultTaskRuntimeContext) => Exit<A, E> | Promise<Exit<A, E>>
}) => ResultTask<A, E>

describe('ResultTask mutation regressions', () => {
  it('recovers rejected internal executions in cause handlers, finalizers and workers', async () => {
    const defect = new Error('executor rejected')
    const rejectingTask = (): ResultTask<never> =>
      new InternalCustomTask({ _tag: 'Custom', execute: () => Promise.reject(defect) })
    const failedTask = ResultTask.err('original')
    expect(await failedTask.catchCause(rejectingTask).runExit()).toEqual({
      _tag: 'Failure',
      cause: Cause.die(defect),
    })

    for (const finalize of [rejectingTask, () => Promise.reject(defect)]) {
      // eslint-disable-next-line no-await-in-loop -- Exercise each finalizer return form.
      expect(await failedTask.ensuring(finalize).runExit()).toEqual({
        _tag: 'Failure',
        cause: Cause.sequential(Cause.fail('original'), Cause.die(defect)),
      })
    }
    // eslint-disable-next-line unicorn/no-array-for-each -- This is ResultTask.forEach.
    expect(await ResultTask.forEach([1], rejectingTask).runExit()).toEqual({
      _tag: 'Failure',
      cause: Cause.die(defect),
    })
  })

  it('waits for asynchronous tapCause failures and keeps the original cause', async () => {
    const defect = new Error('tapCause rejected')
    const task = ResultTask.err('original')
    expect(await task.tapCause(() => Promise.reject(defect)).runExit()).toEqual({
      _tag: 'Failure',
      cause: Cause.sequential(Cause.fail('original'), Cause.die(defect)),
    })
    expect(task.tapCause(() => undefined).runSync()).toEqual(err('original'))
  })

  it('schedules synchronous work without an async boundary when only one worker is requested', async () => {
    const visited: number[] = []
    // eslint-disable-next-line unicorn/no-array-for-each -- This is ResultTask.forEach.
    const pending = ResultTask.forEach(
      [1, 2],
      (item) => {
        visited.push(item)
        return ResultTask.ok(item)
      },
      { concurrency: 1 },
    ).runPromise()
    expect(visited).toEqual([1, 2])
    expect(await pending).toEqual([1, 2])
  })

  it('observes only simple typed failures and waits for callable thenables', async () => {
    const observed: unknown[] = []
    const observeError = (error: unknown): void => {
      observed.push(error)
    }
    const metadata = Cause.fail('unrelated metadata')
    const extendedSuccess = { _tag: 'Success', value: 1, cause: metadata } as const
    const completed = new InternalCustomTask({ _tag: 'Custom', execute: () => extendedSuccess })
    const task = completed.inspectError(observeError)
    expect(task.runSync()).toEqual(ok(1))
    ResultTask.err('original').inspectError(observeError).runSync()
    const defect = new Error('defect')
    ResultTask.sync(() => {
      throw defect
    })
      .inspectError(observeError)
      .runSyncExit()
    expect(observed).toEqual(['original'])

    const thenable = Object.assign(() => undefined, {
      then: (resolve: () => void): void => {
        observed.push('thenable')
        resolve()
      },
    })
    expect(
      await ResultTask.ok(2)
        .inspect(() => thenable)
        .runPromise(),
    ).toBe(2)
    expect(observed).toEqual(['original', 'thenable'])
    expect(
      ResultTask.ok(3)
        .inspect(() => ({ then: 'ordinary property' }))
        .runSync(),
    ).toEqual(ok(3))
  })

  it('does not transfer cleanup provenance to extra data on a successful recovery', () => {
    const metadata = Cause.fail('unrelated metadata')
    const successful = { _tag: 'Success', value: 1, cause: metadata } as const
    const recovery = new InternalCustomTask({ _tag: 'Custom', execute: () => successful })
    const value = ResultTask.ok(0)
      .ensuring(() => ResultTask.err('cleanup error'))
      .catchCause(() => recovery)
      .runSync()
    expect(value).toEqual(ok(1))
    expect(isCleanupCause(metadata)).toBe(false)
  })

  it('interrupts an interpreted synchronous task that cancels during its last instruction', async () => {
    const controller = new AbortController()
    const recorded: Exit<unknown, unknown>[] = []
    const task = ResultTask.suspend(() =>
      ResultTask.sync(() => {
        controller.abort('last instruction')
        return 1
      }),
    )
    const parent = new InternalCustomTask({
      _tag: 'Custom',
      execute: async (context) => {
        recorded.push(await runRuntimeTask(ResultTask, task, context))
        return { _tag: 'Success', value: undefined }
      },
    })
    await parent.runExit({ signal: controller.signal })
    expect(recorded).toEqual([{ _tag: 'Failure', cause: Cause.interrupt('last instruction') }])
  })

  it('continues after an asynchronous repeat predicate and retains rejected predicate defects', async () => {
    let attempts = 0
    const increment = ResultTask.sync(() => {
      attempts += 1
      return attempts
    })
    const completed = await increment
      .repeat({ times: 3, while: async (value) => value < 2 })
      .runExit()
    expect(completed).toEqual({ _tag: 'Success', value: 2 })
    const defect = new Error('predicate rejected')
    const failed = await increment
      .repeat({ times: 1, while: () => Promise.reject(defect) })
      .runExit()
    expect(failed).toEqual({ _tag: 'Failure', cause: Cause.die(defect) })
    expect(attempts).toBe(3)
  })

  it('checks the repeat budget even with no observer or delay', () => {
    let attempts = 0
    const clock = { now: () => attempts * 10, sleep: Clock.live.sleep, random: Clock.live.random }
    const exit = ResultTask.sync(() => {
      attempts += 1
      return attempts
    })
      .repeat({ times: 3, maxElapsedMs: 5 })
      .runSyncExit({ clock })
    expect(exit).toEqual({ _tag: 'Success', value: 1 })
    expect(attempts).toBe(1)
  })

  it('skips reading the retry clock again when an immediate repetition has no hooks or budget', async () => {
    const now = vi.fn(() => 0)
    const clock = { now, sleep: vi.fn(async () => undefined), random: Clock.live.random }
    expect(await ResultTask.ok(1).repeat({ times: 1 }).runPromise({ clock })).toBe(1)
    expect(now).toHaveBeenCalledOnce()
  })

  it('stops before checking the repeat budget when the body aborts synchronously', async () => {
    const controller = new AbortController()
    const now = vi.fn(() => 0)
    const clock = { now, sleep: Clock.live.sleep, random: Clock.live.random }
    const body = ResultTask.sync(() => {
      controller.abort('body-aborted')
      return 1
    })
    const exit = await body
      .repeat({ times: 1, maxElapsedMs: 5 })
      .runExit({ clock, signal: controller.signal })
    expect(exit).toEqual({ _tag: 'Failure', cause: Cause.interrupt('body-aborted') })
    expect(now).toHaveBeenCalledOnce()
  })

  it('stops before the repeat observer when reading the elapsed budget aborts', async () => {
    const controller = new AbortController()
    const observer = vi.fn()
    let reads = 0
    const clock = {
      sleep: Clock.live.sleep,
      random: Clock.live.random,
      now: () => {
        reads += 1
        if (reads === 2) controller.abort('clock-aborted')
        return 0
      },
    }
    const exit = await ResultTask.ok(1)
      .repeat({ times: 1, maxElapsedMs: 5, onRepeat: observer })
      .runExit({ clock, signal: controller.signal })
    expect(exit).toEqual({ _tag: 'Failure', cause: Cause.interrupt('clock-aborted') })
    expect(observer).not.toHaveBeenCalled()
  })

  it('does not compute a delay when reading the repeat budget aborts with no observer', async () => {
    const controller = new AbortController()
    const delay = vi.fn(() => 1)
    const clock = {
      sleep: Clock.live.sleep,
      random: Clock.live.random,
      now: vi
        .fn(() => 0)
        .mockImplementationOnce(() => 0)
        .mockImplementationOnce(() => {
          controller.abort('clock-aborted')
          return 0
        }),
    }
    const exit = await ResultTask.ok(1)
      .repeat({ times: 1, maxElapsedMs: 5, delayMs: delay })
      .runExit({ clock, signal: controller.signal })
    expect(exit).toEqual({ _tag: 'Failure', cause: Cause.interrupt('clock-aborted') })
    expect(delay).not.toHaveBeenCalled()
  })

  it('consumes a predicate promise returned by a hook that aborts synchronously', async () => {
    const controller = new AbortController()
    const promise = Promise.resolve(true)
    const then = vi.spyOn(promise, 'then')
    const exit = await ResultTask.ok(1)
      .repeat({
        times: 1,
        while: () => {
          controller.abort('predicate-aborted')
          return promise
        },
      })
      .runExit({ signal: controller.signal })
    expect(exit).toEqual({ _tag: 'Failure', cause: Cause.interrupt('predicate-aborted') })
    expect(then).toHaveBeenCalledOnce()
  })

  it('advances asynchronous firstSuccessOf failures and closes on the first success', async () => {
    const events: string[] = []
    const candidates = (function* () {
      try {
        yield ResultTask.tryPromise({
          try: async () => {
            throw new Error('miss')
          },
          catch: () => 'miss',
        })
        yield ResultTask.tryPromise({ try: async () => 42, catch: () => 'unexpected' })
        events.push('advanced-after-success')
      } finally {
        events.push('closed')
      }
    })()
    expect(await ResultTask.firstSuccessOf(candidates).runPromise()).toBe(42)
    expect(events).toEqual(['closed'])
  })

  it('closes firstSuccessOf without requesting another candidate after cancellation', async () => {
    const controller = new AbortController()
    const pending = Promise.withResolvers<Exit<never, string>>()
    const candidate = new InternalCustomTask({ _tag: 'Custom', execute: () => pending.promise })
    const events: string[] = []
    const candidates = (function* () {
      try {
        yield candidate
        events.push('advanced')
      } finally {
        events.push('closed')
      }
    })()
    const running = ResultTask.firstSuccessOf(candidates).runExit({ signal: controller.signal })
    controller.abort('cancelled')
    pending.resolve({ _tag: 'Failure', cause: Cause.fail('miss') })
    expect(await running).toEqual({ _tag: 'Failure', cause: Cause.interrupt('cancelled') })
    expect(events).toEqual(['closed'])
  })

  it('returns an already fulfilled Promise for a synchronous success', async () => {
    const events: string[] = []
    const result = ResultTask.sync(() => 42)
      .runPromise()
      .then((value) => {
        events.push('result')
        return value
      })
    await Promise.resolve().then(() => {
      events.push('peer')
    })
    expect(await result).toBe(42)
    expect(events).toEqual(['result', 'peer'])
  })

  it('interprets successful and failed Promise constructor inputs', async () => {
    const successTask = new InternalPromiseTask(Promise.resolve(ok(42)))
    const failureTask = new InternalPromiseTask(Promise.resolve(err('not-found')))

    expect(await ResultTask.runExit(successTask)).toEqual({ _tag: 'Success', value: 42 })
    expect(await ResultTask.runExit(failureTask)).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'not-found' },
    })
  })

  it('preserves Promise constructor rejections as defects', async () => {
    const defect = new Error('raw promise rejection')
    const task = new InternalPromiseTask(Promise.reject<Result<never, never>>(defect))

    expect(await ResultTask.runExit(task)).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Die', defect },
    })
  })

  it('interrupts a Promise constructor input aborted before its result resolves', async () => {
    const controller = new AbortController()
    const task = new InternalPromiseTask(
      new Promise<Result<number, string>>((resolve) => {
        setImmediate(() => {
          controller.abort('promise-interrupted')
          resolve(err('superseded'))
        })
      }),
    )

    expect(await ResultTask.runExit(task, { signal: controller.signal })).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'promise-interrupted' },
    })
  })

  it('applies continuations to synchronous Custom instruction results', async () => {
    let executions = 0
    const task = new InternalCustomTask<number, never>({
      _tag: 'Custom',
      execute: () => {
        executions += 1
        return { _tag: 'Success', value: 21 }
      },
    })

    expect(await ResultTask.runExit(task.map((value) => value * 2))).toEqual({
      _tag: 'Success',
      value: 42,
    })
    expect(executions).toBe(1)
  })

  it('applies continuations to asynchronous Custom instruction results', async () => {
    const task = new InternalCustomTask<number, string>({
      _tag: 'Custom',
      execute: () => Promise.resolve({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'raw' } }),
    })

    expect(await ResultTask.runExit(task.mapErr((error) => `mapped:${error}`))).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'mapped:raw' },
    })
  })

  it('collects only actual validation errors when earlier items succeeded', async () => {
    const task = ResultTask.validateAll([0, 1, 2, 3], (value) =>
      value % 2 === 0 ? ResultTask.ok(value) : ResultTask.err(`invalid:${value}`),
    )

    expect(await ResultTask.runExit(task)).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: ['invalid:1', 'invalid:3'] },
    })
  })

  it('logs the original success and error in separate callback arguments', async () => {
    const calls: [number | undefined, string | undefined][] = []
    const log = (value: number | undefined, error: string | undefined): void => {
      calls.push([value, error])
    }
    const successTask = ResultTask.ok<number, string>(42).log(log)
    const failureTask = ResultTask.err<number, string>('missing').log(log)

    expect(calls).toEqual([])
    expect(await ResultTask.runExit(successTask)).toEqual({ _tag: 'Success', value: 42 })
    expect(await ResultTask.runExit(failureTask)).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'missing' },
    })
    expect(calls).toEqual([
      [42, undefined],
      [undefined, 'missing'],
    ])
  })

  it('selects only the matching fluent if branch when executed', async () => {
    const calls: string[] = []
    const branch = (value: number) =>
      ResultTask.ok(value)
        .if((current) => {
          calls.push(`predicate:${current}`)
          return current > 0
        })
        .true((current) => {
          calls.push(`true:${current}`)
          return ok(current + 10)
        })
        .false((current) => {
          calls.push(`false:${current}`)
          return ResultTask.err(`negative:${current}`)
        })
    const positive = branch(2)
    const negative = branch(-2)

    expect(calls).toEqual([])
    expect(await ResultTask.runExit(positive)).toEqual({ _tag: 'Success', value: 12 })
    expect(await ResultTask.runExit(negative)).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'negative:-2' },
    })
    expect(calls).toEqual(['predicate:2', 'true:2', 'predicate:-2', 'false:-2'])
  })

  it('preserves upstream failures without invoking fluent if callbacks', async () => {
    let calls = 0
    const task = ResultTask.err<number, string>('upstream')
      .if(() => {
        calls += 1
        return true
      })
      .true(() => {
        calls += 1
        return ok(1)
      })
      .false(() => {
        calls += 1
        return ok(2)
      })

    expect(await ResultTask.runExit(task)).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'upstream' },
    })
    expect(calls).toBe(0)
  })

  it('maps errors through direct and curried static mapErr', async () => {
    const task = ResultTask.err('missing')
    const direct = ResultTask.mapErr(task, (error) => error.length)
    const curried = task.pipe(ResultTask.mapErr((error: string) => `mapped:${error}`))

    expect(await ResultTask.runExit(direct)).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 7 },
    })
    expect(await ResultTask.runExit(curried)).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'mapped:missing' },
    })
  })

  it('executes uninterruptible synchronous retries in the synchronous retry loop', async () => {
    let attempts = 0
    const task = ResultTask.ok(0)
      .andThen(() => {
        attempts += 1
        return attempts < 3 ? ResultTask.err('retry') : ResultTask.ok(attempts)
      })
      .retry(Retry.policy({ times: 2 }))

    const pending = ResultTask.runExit(task)
    expect(attempts).toBe(3)
    expect(await pending).toEqual({ _tag: 'Success', value: 3 })
  })
})
