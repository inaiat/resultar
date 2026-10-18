import { deepEqual, equal } from 'node:assert/strict'
import { afterEach, describe, it, vi } from 'vite-plus/test'
import { Retry } from '../src/core/retry.js'
import { ok } from '../src/result/result.js'
import { ResultTask } from '../src/task/result-task.js'
import { Clock } from '../src/task/task-clock.js'
import type { TaskClock } from '../src/task/task-clock.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('ResultTask retry with zero delay', () => {
  it.each([
    ['canonical default', Retry.policy<string>({ times: 2 })],
    ['canonical explicit', Retry.policy<string>({ times: 2, delayMs: 0 })],
    ['canonical callback', Retry.policy<string>({ times: 2, delayMs: () => 0 })],
    ['legacy default', { times: 2 }],
    ['legacy explicit', { times: 2, delayMs: 0 }],
    ['legacy callback', { times: 2, delayMs: () => 0 }],
  ] as const)('retries without live timers for %s delay', async (_name, options) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    let attempts = 0
    const task = ResultTask.sync(() => {
      attempts += 1
      return attempts
    })
      .andThen((attempt) => (attempt < 3 ? ResultTask.err('offline') : ResultTask.ok(attempt)))
      .retry(options)

    equal(attempts, 0)
    const running = ResultTask.runResult(task)
    await vi.runAllTimersAsync()
    deepEqual(await running, ok(3))
    equal(attempts, 3)
    equal(timeout.mock.calls.length, 0)
  })

  it('awaits attempt cleanup and async hooks before the next immediate attempt', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    const events: string[] = []
    let attempts = 0
    const task = ResultTask.gen(function* () {
      const attempt = yield* ResultTask.acquireRelease({
        acquire: ResultTask.sync(() => {
          attempts += 1
          events.push(`attempt:${attempts}`)
          return attempts
        }),
        release: (attempt) =>
          ResultTask.tryPromise(async () => {
            await Promise.resolve()
            events.push(`release:${attempt}`)
          }),
      })
      if (attempt === 1) return yield* ResultTask.err('offline')
      return attempt
    }).retry(
      Retry.policy({
        times: 1,
        while: async () => {
          await Promise.resolve()
          events.push('while')
          return true
        },
        onRetry: async () => {
          await Promise.resolve()
          events.push('onRetry')
        },
        delayMs: () => {
          events.push('delay')
          return 0
        },
      }),
    )
    const running = ResultTask.runResult(task)
    await vi.runAllTimersAsync()
    deepEqual(await running, ok(2))
    deepEqual(events, [
      'attempt:1',
      'release:1',
      'while',
      'onRetry',
      'delay',
      'attempt:2',
      'release:2',
    ])
    equal(timeout.mock.calls.length, 0)
  })

  it.each(['onRetry', 'canonical delay', 'legacy delay'] as const)(
    'does not restart the body after cancellation in %s',
    async (location) => {
      const controller = new AbortController()
      let attempts = 0
      const delay = (): number => {
        if (location !== 'onRetry') controller.abort(location)
        return 0
      }
      const options =
        location === 'legacy delay'
          ? { times: 1, delayMs: delay }
          : Retry.policy({
              times: 1,
              onRetry: async () => {
                if (location === 'onRetry') controller.abort(location)
              },
              delayMs: delay,
            })
      const task = ResultTask.sync(() => {
        attempts += 1
      })
        .andThen(() => ResultTask.err('offline'))
        .retry(options)

      deepEqual(await ResultTask.runExit(task, { signal: controller.signal }), {
        _tag: 'Failure',
        cause: { _tag: 'Interrupt', reason: location },
      })
      equal(attempts, 1)
    },
  )

  it('does not compute a delay when cancellation follows an accepted predicate', async () => {
    const controller = new AbortController()
    const started = Promise.withResolvers<void>()
    const decision = Promise.withResolvers<boolean>()
    const delay = vi.fn(() => 0)
    let attempts = 0
    const task = ResultTask.sync(() => {
      attempts += 1
    })
      .andThen(() => ResultTask.err('offline'))
      .retry(
        Retry.policy({
          times: 1,
          while: () => {
            started.resolve()
            return decision.promise
          },
          delayMs: delay,
        }),
      )

    const running = ResultTask.runExit(task, { signal: controller.signal })
    await started.promise
    decision.resolve(true)
    // Cancel after the predicate settles, before the retry continuation computes its delay.
    queueMicrotask(() => {
      controller.abort('stop after predicate')
    })
    deepEqual(await running, {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'stop after predicate' },
    })
    equal(attempts, 1)
    equal(delay.mock.calls.length, 0)
  })

  it('preserves a virtual clock zero sleeper until that clock advances', async () => {
    const clock = Clock.virtual()
    let attempts = 0
    const task = ResultTask.sync(() => {
      attempts += 1
      return attempts
    })
      .andThen((attempt) => (attempt === 1 ? ResultTask.err('offline') : ResultTask.ok(attempt)))
      .retry(Retry.policy({ times: 1 }))
    const running = ResultTask.runResult(task, { clock })
    await clock.flush()
    equal(clock.pending, 1)
    equal(attempts, 1)
    await clock.advanceBy(0)
    deepEqual(await running, ok(2))
    equal(clock.pending, 0)
  })

  it('cancels while a custom clock is sleeping at zero', async () => {
    const controller = new AbortController()
    const clock = Clock.virtual()
    let attempts = 0
    const task = ResultTask.sync(() => {
      attempts += 1
    })
      .andThen(() => ResultTask.err('offline'))
      .retry(Retry.policy({ times: 1, delayMs: 0 }))
    const running = ResultTask.runExit(task, { clock, signal: controller.signal })
    await clock.flush()
    equal(clock.pending, 1)
    controller.abort('stop during zero sleep')
    deepEqual(await running, {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'stop during zero sleep' },
    })
    equal(attempts, 1)
    equal(clock.pending, 0)
  })

  it.each(['throw', 'reject'] as const)(
    'preserves a custom zero sleeper %s as a defect',
    async (mode) => {
      const defect = new Error('clock failed')
      const sleep = vi.fn<TaskClock['sleep']>(() => {
        if (mode === 'throw') throw defect
        return Promise.reject(defect)
      })
      const clock: TaskClock = { now: () => 0, random: () => 0.5, sleep }
      let attempts = 0
      const task = ResultTask.sync(() => {
        attempts += 1
      })
        .andThen(() => ResultTask.err('offline'))
        .retry(Retry.policy({ times: 1 }))

      deepEqual(await ResultTask.runExit(task, { clock }), {
        _tag: 'Failure',
        cause: { _tag: 'Die', defect },
      })
      equal(attempts, 1)
      equal(sleep.mock.calls.length, 1)
      equal(sleep.mock.calls[0]?.[0], 0)
    },
  )

  it('keeps a positive live delay cancelable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    const controller = new AbortController()
    let attempts = 0
    const task = ResultTask.sync(() => {
      attempts += 1
    })
      .andThen(() => ResultTask.err('offline'))
      .retry(Retry.policy({ times: 1, delayMs: 100 }))
    const running = ResultTask.runExit(task, { signal: controller.signal })
    await vi.advanceTimersByTimeAsync(0)
    equal(attempts, 1)
    equal(timeout.mock.calls.length, 1)
    equal(vi.getTimerCount(), 1)
    controller.abort('stop during backoff')
    deepEqual(await running, {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'stop during backoff' },
    })
    equal(attempts, 1)
    equal(vi.getTimerCount(), 0)
  })

  it('yields long immediate retries so external cancellation can stop the run', async () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    const controller = new AbortController()
    let attempts = 0
    const task = ResultTask.sync(() => {
      attempts += 1
    })
      .andThen(() => ResultTask.err('offline'))
      .retry(Retry.policy({ times: 100_000 }))
    setImmediate(() => {
      controller.abort('external cancellation')
    })

    deepEqual(await ResultTask.runExit(task, { signal: controller.signal, yieldEvery: 32 }), {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'external cancellation' },
    })
    equal(attempts > 1, true)
    equal(attempts < 100_000, true)
    equal(timeout.mock.calls.length, 0)
  })
})
