import { deepEqual, equal, ok as assertOk, rejects, throws } from 'node:assert'
import { setImmediate } from 'node:timers/promises'

import { describe, expect, it, vi } from 'vite-plus/test'

import {
  AbortError,
  Cause,
  Clock,
  createTaggedError,
  err,
  Match,
  ok,
  Result,
  ResultTask,
  ResultTaskCauseError,
  Semaphore,
  serviceTag,
  taggedEnum,
  TaskLocal,
  Tracer,
} from '../src/index.js'
import type { Exit } from '../src/index.js'
import { okAsync, ResultAsync, type ResultAsyncRaceTask } from '../src/entries/async.js'
import { startFiber } from '../src/task/fiber-runtime.js'
import { NEVER_ABORTED_SIGNAL } from '../src/task/promise-interruption.js'
import { TaskScope } from '../src/task/scope.js'
import {
  compileTaskChain,
  OP_MAP,
  OP_SUCCESS,
  type TaskJitHelpers,
  type TaskNodeLike,
} from '../src/task/task-jit.js'

describe('TaskScope.finishDrain with multiple failing finalizers', () => {
  it('preserves all failing finalizers from a nested scoped losing fiber in race and timeout', async () => {
    const clock = Clock.virtual()
    const defect1 = new Error('finalizer-1-defect')
    const defect2 = new Error('finalizer-2-defect')

    const makeScopedLoser = () =>
      ResultTask.scoped(
        ResultTask.gen(function* () {
          yield* ResultTask.acquireRelease({
            acquire: ResultTask.ok('r1'),
            release: () => ResultTask.err('rel-1' as const),
          })
          yield* ResultTask.acquireRelease({
            acquire: ResultTask.ok('r2'),
            release: () =>
              ResultTask.sync(() => {
                throw defect1
              }),
          })
          yield* ResultTask.acquireRelease({
            acquire: ResultTask.ok('r3'),
            release: () =>
              ResultTask.sync(() => {
                throw defect2
              }),
          })
          yield* ResultTask.sleep(100)
          return 'loser'
        }),
      )

    const raceExit = await clock.runToCompletion(
      ResultTask.race(ResultTask.sleep(10).as('winner'), makeScopedLoser()),
    )
    equal(raceExit._tag, 'Failure')
    if (raceExit._tag === 'Failure') {
      deepEqual(Cause.defects(raceExit.cause), [defect2, defect1])
      deepEqual(Cause.failures(raceExit.cause), ['rel-1'])
      equal(Cause.hasInterrupts(raceExit.cause), false)
    }

    const timeoutClock = Clock.virtual()
    const timeoutExit = await timeoutClock.runToCompletion(
      ResultTask.timeout(makeScopedLoser(), 10, () => 'timed-out' as const),
    )
    equal(timeoutExit._tag, 'Failure')
    if (timeoutExit._tag === 'Failure') {
      deepEqual(Cause.failures(timeoutExit.cause), ['timed-out', 'rel-1'])
      deepEqual(Cause.defects(timeoutExit.cause), [defect2, defect1])
    }
  })
})

describe('ResultTask.gen try/finally fixes', () => {
  it('closes synchronous try/finally yields synchronously in runSync and runSyncExit', () => {
    const Cleanup = serviceTag<{ readonly close: () => void }>('CleanupSync')
    const events: string[] = []

    const task = ResultTask.gen(function* () {
      try {
        yield* ResultTask.err('boom' as const)
      } finally {
        const svc = yield* Cleanup
        svc.close()
        yield* ResultTask.sync(() => {
          events.push('sync-task')
        })
      }
    })

    const result = ResultTask.runSync(task, {
      services: {
        CleanupSync: {
          close: () => {
            events.push('service-close')
          },
        },
      },
    })
    deepEqual(result, err('boom'))
    deepEqual(events, ['service-close', 'sync-task'])

    const errInFinally = ResultTask.gen(function* () {
      try {
        yield* ResultTask.err('first' as const)
      } finally {
        yield* err('second' as const)
      }
    })
    deepEqual(ResultTask.runSyncExit(errInFinally), {
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'second' },
    })
  })

  it('falls back to async close when a finally yield returns a Promise after a sync yield', async () => {
    const clock = Clock.virtual()
    const events: string[] = []
    const task = ResultTask.gen(function* () {
      try {
        yield* ResultTask.err('stop' as const)
      } finally {
        yield* ResultTask.sync(() => {
          events.push('sync')
        })
        yield* ResultTask.sleep(5)
        yield* ResultTask.sync(() => {
          events.push('async')
        })
      }
    })
    deepEqual(await clock.runToCompletion(task), {
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'stop' },
    })
    deepEqual(events, ['sync', 'async'])
  })

  it('marks finally defects and failures as cleanup causes so race/raceFirst/timeout never swallow them', async () => {
    const directDefect = new Error('direct-finally-throw')
    const yieldedDefect = new Error('yielded-finally-throw')

    const directLoser = ResultTask.gen(function* () {
      try {
        yield* ResultTask.sleep(100)
        return 'loser'
      } finally {
        // eslint-disable-next-line no-unsafe-finally
        throw directDefect
      }
    })
    const yieldedLoser = ResultTask.gen(function* () {
      try {
        yield* ResultTask.sleep(100)
        return 'loser'
      } finally {
        yield* ResultTask.sync(() => {
          throw yieldedDefect
        })
      }
    })
    const failLoser = ResultTask.gen(function* () {
      try {
        yield* ResultTask.sleep(100)
        return 'loser'
      } finally {
        yield* ResultTask.err('finally-fail' as const)
      }
    })

    const clock1 = Clock.virtual()
    const exit1 = await clock1.runToCompletion(
      ResultTask.race(ResultTask.sleep(5).as('win'), directLoser),
    )
    equal(exit1._tag, 'Failure')
    if (exit1._tag === 'Failure') {
      deepEqual(Cause.defects(exit1.cause), [directDefect])
    }

    const clock2 = Clock.virtual()
    const exit2 = await clock2.runToCompletion(
      ResultTask.raceFirst(ResultTask.sleep(5).as('win'), yieldedLoser),
    )
    equal(exit2._tag, 'Failure')
    if (exit2._tag === 'Failure') {
      deepEqual(Cause.defects(exit2.cause), [yieldedDefect])
    }

    const clock3 = Clock.virtual()
    const exit3 = await clock3.runToCompletion(
      ResultTask.timeout(failLoser, 5, () => 'timeout' as const),
    )
    equal(exit3._tag, 'Failure')
    if (exit3._tag === 'Failure') {
      deepEqual(Cause.failures(exit3.cause), ['timeout', 'finally-fail'])
    }
  })

  it('preserves Interrupt when finally fails or dies during external cancellation', async () => {
    const clock = Clock.virtual()
    const controller = new AbortController()
    const task = ResultTask.gen(function* () {
      try {
        yield* ResultTask.sleep(100)
      } finally {
        yield* ResultTask.err('cleanup-fail' as const)
      }
    })
    const running = ResultTask.runExit(task, { clock, signal: controller.signal })
    await clock.flush()
    controller.abort('external-stop')
    const exit = await running
    deepEqual(exit, {
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Interrupt', reason: 'external-stop' },
        right: { _tag: 'Fail', error: 'cleanup-fail' },
      },
    })

    const defect = new Error('finally-die')
    const controller2 = new AbortController()
    const task2 = ResultTask.gen(function* () {
      try {
        yield* ResultTask.sleep(100)
      } finally {
        // eslint-disable-next-line no-unsafe-finally
        throw defect
      }
    })
    const running2 = ResultTask.runExit(task2, { clock, signal: controller2.signal })
    await clock.flush()
    controller2.abort('external-stop-2')
    const exit2 = await running2
    deepEqual(exit2, {
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Interrupt', reason: 'external-stop-2' },
        right: { _tag: 'Die', defect },
      },
    })
  })
})

describe('JIT/interpreter abort parity and tryPromise late abort', () => {
  it('reports Interrupt on last-step resumeSync abort across warm JIT and interpreter runs', async () => {
    let controller = new AbortController()
    const chain = ResultTask.ok(1)
      .map((n) => n + 1)
      .andThen((n) =>
        ResultTask.sync(() => {
          controller.abort('last-step-sync')
          return n + 1
        }),
      )

    for (let run = 0; run < 4; run += 1) {
      controller = new AbortController()
      const exit = await ResultTask.runExit(chain, { signal: controller.signal, yieldEvery: 8 })
      deepEqual(exit, { _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'last-step-sync' } })
    }
  })

  it('reports Interrupt when last-step async or tryPromise resolves after signal aborts', async () => {
    let controller = new AbortController()
    const asyncChain = ResultTask.ok(1)
      .map((n) => n + 1)
      .andThen((n) =>
        ResultTask.tryPromise({
          try: async () => {
            controller.abort('try-promise-aborted')
            return n + 1
          },
          catch: () => 'err' as const,
        }),
      )

    for (let run = 0; run < 4; run += 1) {
      controller = new AbortController()
      const exit = await ResultTask.runExit(asyncChain, { signal: controller.signal })
      deepEqual(exit, {
        _tag: 'Failure',
        cause: { _tag: 'Interrupt', reason: 'try-promise-aborted' },
      })
    }

    // Verify tryPromise inside a tap / direct execution also respects abort
    const ctrl2 = new AbortController()
    let tapObserved = false
    const tapped = ResultTask.ok(1).tap(() =>
      ResultTask.tryPromise({
        try: async () => {
          ctrl2.abort('tap-aborted')
          tapObserved = true
          return 'ok'
        },
        catch: () => 'err' as const,
      }),
    )
    const tappedExit = await ResultTask.runExit(tapped, { signal: ctrl2.signal })
    equal(tapObserved, true)
    deepEqual(tappedExit, { _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'tap-aborted' } })
  })
})

describe('catchTag and catchTags throwing _tag getter safety', () => {
  it('turns throwing _tag getters into Die causes in fast path, interpreter, and JIT', async () => {
    const getterBoom = new Error('tag-getter-boom')
    const poison = Object.defineProperty({}, '_tag', {
      enumerable: true,
      get() {
        throw getterBoom
      },
    })

    // Fast path (#tryFastCatchTag)
    const fastExit = await ResultTask.err(poison)
      .catchTag('A' as never, () => ResultTask.ok('nope'))
      .runExit()
    deepEqual(fastExit, { _tag: 'Failure', cause: { _tag: 'Die', defect: getterBoom } })

    // Warm chain (interpreter on run 1, JIT on runs 2-3 when JIT=1)
    const catchTagChain = ResultTask.ok(1)
      .andThen(() => ResultTask.err(poison))
      .catchTag('A' as never, () => ResultTask.ok('nope'))
    const catchTagsChain = ResultTask.ok(1)
      .andThen(() => ResultTask.err(poison))
      .catchTags({ A: () => ResultTask.ok('nope') } as never)

    for (let run = 0; run < 4; run += 1) {
      deepEqual(await catchTagChain.runExit(), {
        _tag: 'Failure',
        cause: { _tag: 'Die', defect: getterBoom },
      })
      deepEqual(await catchTagsChain.runExit(), {
        _tag: 'Failure',
        cause: { _tag: 'Die', defect: getterBoom },
      })
    }
  })
})

describe('Cause.pretty safety and shared non-circular references', () => {
  it('handles throwing Error.stack getters, BigInt/circular span attributes, and shared non-circular refs', async () => {
    const brokenError = new Error('broken')
    Object.defineProperty(brokenError, 'stack', {
      get() {
        throw new Error('stack getter exploded')
      },
    })
    equal(Cause.pretty(Cause.die(brokenError)), 'Die: [Unserializable value]')

    const shared = { x: 1 }
    equal(Cause.pretty(Cause.fail({ a: shared, b: shared })), 'Fail: {"a":{"x":1},"b":{"x":1}}')
    equal(Cause.pretty(Cause.fail([shared, shared])), 'Fail: [{"x":1},{"x":1}]')

    const circularAttr: { self?: unknown } = {}
    circularAttr.self = circularAttr
    const tracedExit = await ResultTask.err('bad')
      .withSpan('unsafe-span', {
        big: 42n as unknown as number,
        circ: circularAttr as unknown as string,
      })
      .runExit()
    equal(tracedExit._tag, 'Failure')
    if (tracedExit._tag === 'Failure') {
      const rendered = Cause.pretty(tracedExit.cause)
      assertOk(rendered.includes('big="42n"'))
      assertOk(rendered.includes('circ={"self":"[Circular]"}'))
    }

    // Composite cause with throwing-stack Error does not throw when wrapped in ResultTaskCauseError via catchAll
    const compositeTask = ResultTask.err(
      Cause.sequential(Cause.fail('first'), Cause.die(brokenError)),
    )
      .unsandbox()
      .orElse(() => ResultTask.ok('recovered'))
    const compositeExit = await compositeTask.runExit()
    equal(compositeExit._tag, 'Failure')
    if (compositeExit._tag === 'Failure' && compositeExit.cause._tag === 'Die') {
      assertOk(compositeExit.cause.defect instanceof ResultTaskCauseError)
      assertOk(compositeExit.cause.defect.message.includes('[Unserializable value]'))
    }
  })
})

describe('ResultTask.acquireDisposable fallback', () => {
  it('falls back to Symbol.dispose synchronously when Symbol.asyncDispose is undefined', () => {
    let disposed = false
    const task = ResultTask.scoped(
      ResultTask.acquireDisposable(
        ResultTask.sync(() => ({
          value: 'sync-resource',
          [Symbol.asyncDispose]: undefined as unknown as () => Promise<void>,
          [Symbol.dispose]() {
            disposed = true
          },
        })),
      ).map((r) => r.value),
    )

    deepEqual(task.runSync(), ok('sync-resource'))
    equal(disposed, true)
  })
})

describe('ResultTask.acquireRelease under cancellation', () => {
  it.each(['provideServices', 'withSpan'])(
    'releases a late acquisition wrapped in %s',
    async (wrapper) => {
      const controller = new AbortController()
      const started = Promise.withResolvers<void>()
      const produced = Promise.withResolvers<{ id: number }>()
      const resource = { id: 1 }
      const released: (typeof resource)[] = []
      const acquire = ResultTask.tryPromise(() => {
        started.resolve()
        return produced.promise
      })
      const workflow = ResultTask.acquireRelease({
        acquire: wrapper === 'withSpan' ? acquire.withSpan('acquire') : acquire.provideServices({}),
        release: (value) => ResultTask.sync(() => void released.push(value)),
      }).scoped()

      const running = workflow.runExit({
        signal: controller.signal,
        tracer: Tracer.memory().tracer,
      })
      await started.promise
      controller.abort('cancel acquisition')
      produced.resolve(resource)

      deepEqual(await running, {
        _tag: 'Failure',
        cause: { _tag: 'Interrupt', reason: 'cancel acquisition' },
      })
      deepEqual(released, [resource])
    },
  )
})

describe('External cancellation of ResultTask.race and raceAll', () => {
  it('collapses pure external interruption into a single Interrupt and rejects runResult/runPromise with AbortError', async () => {
    for (const makeTask of [
      () => ResultTask.race(ResultTask.sleep(100).as('a'), ResultTask.sleep(200).as('b')),
      () =>
        ResultTask.raceAll([
          ResultTask.sleep(100).as('a'),
          ResultTask.sleep(200).as('b'),
          ResultTask.sleep(300).as('c'),
        ]),
    ]) {
      const clock = Clock.virtual()
      const controller = new AbortController()
      const exitPromise = ResultTask.runExit(makeTask(), { clock, signal: controller.signal })
      await clock.flush()
      controller.abort('cancel-race')
      deepEqual(await exitPromise, {
        _tag: 'Failure',
        cause: { _tag: 'Interrupt', reason: 'cancel-race' },
      })

      const controller2 = new AbortController()
      const resultPromise = ResultTask.runResult(makeTask(), { clock, signal: controller2.signal })
      await clock.flush()
      controller2.abort('cancel-race-result')
      await rejects(resultPromise, AbortError)

      const controller3 = new AbortController()
      const valuePromise = ResultTask.runPromise(makeTask(), { clock, signal: controller3.signal })
      await clock.flush()
      controller3.abort('cancel-race-promise')
      await rejects(valuePromise, AbortError)
    }
  })
})

describe('ResultTask.tapCause sync return', () => {
  it('stays synchronous in runSync when callback returns a non-undefined non-Promise value', () => {
    const seen: Cause<string>[] = []
    const task = ResultTask.err('oops').tapCause((cause) => {
      seen.push(cause)
      return seen.length as unknown as void
    })
    deepEqual(task.runSync(), err('oops'))
    deepEqual(seen, [{ _tag: 'Fail', error: 'oops' }])
  })
})

describe('ResultTask.memoize cancellation and span isolation', () => {
  it('aborts the shared run when its initial caller cancels during startup', async () => {
    const controller = new AbortController()
    const underlyingAbort = vi.fn()
    const pending = Promise.withResolvers<number>()
    const memo = ResultTask.memoize(
      ResultTask.tryPromise((signal) => {
        signal.addEventListener('abort', underlyingAbort, { once: true })
        controller.abort('stop')
        return pending.promise
      }),
    )
    const running = memo.runExit({ signal: controller.signal })
    expect(underlyingAbort).toHaveBeenCalledOnce()
    pending.resolve(42)
    expect(await running).toEqual({ _tag: 'Failure', cause: Cause.interrupt('stop') })
  })

  it('installs a one-shot cancellation listener and removes it when a waiter finishes', async () => {
    const controller = new AbortController()
    const added = vi.spyOn(controller.signal, 'addEventListener')
    const removed = vi.spyOn(controller.signal, 'removeEventListener')
    const underlyingAbort = vi.fn()
    const pending = Promise.withResolvers<number>()
    const memo = ResultTask.memoize(
      ResultTask.tryPromise((signal) => {
        signal.addEventListener('abort', underlyingAbort, { once: true })
        return pending.promise
      }),
    )
    const running = memo.runPromise({ signal: controller.signal })
    expect(added).toHaveBeenCalledExactlyOnceWith('abort', expect.any(Function), { once: true })
    pending.resolve(42)
    expect(await running).toBe(42)
    expect(removed).toHaveBeenCalledExactlyOnceWith('abort', added.mock.calls[0]?.[1])
    controller.abort('already finished')
    expect(underlyingAbort).not.toHaveBeenCalled()
  })

  it('preserves an asynchronous cleanup failure when the last waiter cancels', async () => {
    const controller = new AbortController()
    const pending = Promise.withResolvers<number>()
    const resource = ResultTask.acquireRelease({
      acquire: ResultTask.ok(1),
      release: () =>
        ResultTask.tryPromise({
          try: () => Promise.reject(new Error('release failed')),
          catch: () => 'release failed',
        }),
    })
    const memo = ResultTask.memoize(
      resource.andThen(() => ResultTask.tryPromise(() => pending.promise)),
    )
    const running = memo.runExit({ signal: controller.signal })
    controller.abort('stop')
    pending.resolve(42)
    expect(await running).toEqual({
      _tag: 'Failure',
      cause: Cause.sequential(Cause.interrupt('stop'), Cause.fail('release failed')),
    })
  })

  it('shares cleanup with new waiters and retries a failed asynchronous memoized run', async () => {
    const cleanupStarted = vi.fn()
    const finishCleanup = Promise.withResolvers<void>()
    let starts = 0
    const resource = ResultTask.acquireRelease({
      acquire: ResultTask.sync(() => {
        starts += 1
      }),
      release: () =>
        ResultTask.tryPromise(() => {
          cleanupStarted()
          return finishCleanup.promise
        }),
    })
    const memo = ResultTask.memoize(
      resource.andThen(() =>
        starts === 1
          ? ResultTask.tryPromise({
              try: () => Promise.reject(new Error('first attempt failed')),
              catch: () => 'first attempt failed',
            })
          : ResultTask.ok(42),
      ),
    )

    const first = memo.runResult()
    await setImmediate()
    expect(cleanupStarted).toHaveBeenCalledOnce()
    const joined = memo.runResult()
    expect(starts).toBe(1)
    finishCleanup.resolve()
    expect(await Promise.all([first, joined])).toEqual([
      err('first attempt failed'),
      err('first attempt failed'),
    ])

    const retry = memo.runResult()
    expect(starts).toBe(2)
    expect(await retry).toEqual(ok(42))
  })

  it('keeps a replacement run in flight when the cancelled run settles', async () => {
    const controller = new AbortController()
    const first = Promise.withResolvers<number>()
    const replacement = Promise.withResolvers<number>()
    let starts = 0
    const memo = ResultTask.memoize(
      ResultTask.tryPromise(() => {
        starts += 1
        return starts === 1 ? first.promise : replacement.promise
      }),
    )
    const cancelled = memo.runExit({ signal: controller.signal })
    controller.abort('stop')
    const next = memo.runExit()
    expect(starts).toBe(2)
    first.resolve(1)
    expect(await cancelled).toEqual({ _tag: 'Failure', cause: Cause.interrupt('stop') })

    const joined = memo.runExit()
    expect(starts).toBe(2)
    replacement.resolve(42)
    expect(await Promise.all([next, joined])).toEqual([
      { _tag: 'Success', value: 42 },
      { _tag: 'Success', value: 42 },
    ])
    expect(await memo.runPromise()).toBe(42)
    expect(starts).toBe(2)
  })

  it.each([false, true])(
    'shares an asynchronous startup with a reentrant caller (cancel: %s)',
    async (cancel) => {
      const controller = new AbortController()
      const pending = Promise.withResolvers<number>()
      const reentrant = Promise.withResolvers<Exit<number, unknown>>()
      let starts = 0
      const memo: ResultTask<number, unknown> = ResultTask.memoize(
        ResultTask.tryPromise(() => {
          starts += 1
          if (starts === 1) {
            reentrant.resolve(memo.runExit({ signal: controller.signal }))
            if (cancel) controller.abort('stop reentrant caller')
          }
          return pending.promise
        }),
      )
      const running = memo.runExit()
      const joined = memo.runExit()
      expect(starts).toBe(1)

      pending.resolve(42)
      const success = { _tag: 'Success', value: 42 }
      expect(await reentrant.promise).toEqual(
        cancel ? { _tag: 'Failure', cause: Cause.interrupt('stop reentrant caller') } : success,
      )
      expect(await Promise.all([running, joined])).toEqual([success, success])
    },
  )

  it('shares a synchronous startup without making the first caller asynchronous', async () => {
    const reentrant = Promise.withResolvers<Exit<number, never>>()
    let starts = 0
    const memo: ResultTask<number> = ResultTask.memoize(
      ResultTask.sync(() => {
        starts += 1
        if (starts === 1) reentrant.resolve(memo.runExit())
        return 42
      }),
    )

    expect(memo.runSync()).toEqual(ok(42))
    expect(await reentrant.promise).toEqual({ _tag: 'Success', value: 42 })
    expect(starts).toBe(1)
  })

  it.each([false, true])(
    'keeps a reentrant resource in the first caller scope (async: %s)',
    async (asyncAcquire) => {
      const observer = Promise.withResolvers<Exit<number, unknown>>()
      const keepUsing = Promise.withResolvers<number>()
      const release = vi.fn<(value: number) => void>()
      let starts = 0
      const acquire = (): number => {
        starts += 1
        if (starts === 1) observer.resolve(memo.runExit())
        return 42
      }
      const memo = ResultTask.memoize(
        ResultTask.acquireRelease({
          acquire: asyncAcquire
            ? ResultTask.tryPromise(async () => acquire())
            : ResultTask.sync(acquire),
          release: (value) => ResultTask.sync(() => release(value)),
        }),
      )
      const running = memo
        .andThen(() => ResultTask.tryPromise(() => keepUsing.promise))
        .runPromise()
      expect(await observer.promise).toEqual({ _tag: 'Success', value: 42 })
      expect(starts).toBe(1)
      expect(release).not.toHaveBeenCalled()
      keepUsing.resolve(42)
      expect(await running).toBe(42)
      expect(release).toHaveBeenCalledExactlyOnceWith(42)
    },
  )

  it.each([false, true])(
    'moves resource ownership when the first caller cancels (during startup: %s)',
    async (duringStartup) => {
      const controller = new AbortController()
      const pending = Promise.withResolvers<number>()
      const observer = Promise.withResolvers<Exit<number, unknown>>()
      const release = vi.fn<(value: number) => void>()
      let starts = 0
      const memo = ResultTask.memoize(
        ResultTask.acquireRelease({
          acquire: ResultTask.tryPromise(() => {
            starts += 1
            if (starts === 1) {
              observer.resolve(memo.runExit())
              if (duringStartup) controller.abort('stop first')
            }
            return pending.promise
          }),
          release: (value) => ResultTask.sync(() => release(value)),
        }),
      )

      const first = memo.runExit({ signal: controller.signal })
      if (!duringStartup) controller.abort('stop first')
      expect(starts).toBe(1)
      expect(await first).toEqual({ _tag: 'Failure', cause: Cause.interrupt('stop first') })
      pending.resolve(42)
      expect(await observer.promise).toEqual({ _tag: 'Success', value: 42 })
      expect(release).toHaveBeenCalledExactlyOnceWith(42)
    },
  )

  it('preserves the first caller scope when a reentrant observer cancels', async () => {
    const controller = new AbortController()
    const resource = Promise.withResolvers<number>()
    const keepUsing = Promise.withResolvers<number>()
    const observing = Promise.withResolvers<Exit<number, unknown>>()
    const cancelling = Promise.withResolvers<Exit<number, unknown>>()
    const release = vi.fn<(value: number) => void>()
    let starts = 0
    const memo = ResultTask.memoize(
      ResultTask.acquireRelease({
        acquire: ResultTask.tryPromise(() => {
          starts += 1
          if (starts === 1) {
            cancelling.resolve(memo.runExit({ signal: controller.signal }))
            observing.resolve(memo.runExit())
          }
          return resource.promise
        }),
        release: (value) => ResultTask.sync(() => release(value)),
      }),
    )
    const first = memo.andThen(() => ResultTask.tryPromise(() => keepUsing.promise)).runPromise()
    controller.abort('stop observer')
    expect(starts).toBe(1)
    expect(await cancelling.promise).toEqual({
      _tag: 'Failure',
      cause: Cause.interrupt('stop observer'),
    })

    resource.resolve(42)
    expect(await observing.promise).toEqual({ _tag: 'Success', value: 42 })
    expect(release).not.toHaveBeenCalled()
    keepUsing.resolve(42)
    expect(await first).toBe(42)
    expect(release).toHaveBeenCalledExactlyOnceWith(42)
  })

  it.each([false, true])(
    'retries a synchronous memoized failure while its cleanup is pending (reentrant cancellation: %s)',
    async (reenter) => {
      const controller = new AbortController()
      const finishCleanup = Promise.withResolvers<void>()
      const cancelled = Promise.withResolvers<Exit<number, unknown>>()
      let starts = 0
      const acquire = (): number => {
        starts += 1
        if (starts === 1 && reenter) {
          cancelled.resolve(memo.runExit({ signal: controller.signal }))
          controller.abort('stop observer')
        }
        return starts
      }
      const memo = ResultTask.memoize(
        ResultTask.acquireRelease({
          acquire: ResultTask.sync(acquire),
          release: (attempt) =>
            attempt === 1
              ? ResultTask.tryPromise(() => finishCleanup.promise)
              : ResultTask.ok(undefined),
        }).andThen((attempt) =>
          attempt === 1 ? ResultTask.err('first failed') : ResultTask.ok(42),
        ),
      )

      const first = memo.runResult()
      const retry = memo.runResult()
      expect(starts).toBe(2)
      finishCleanup.resolve()
      expect(await first).toEqual(err('first failed'))
      expect(await retry).toEqual(ok(42))
      if (reenter)
        expect(await cancelled.promise).toEqual({
          _tag: 'Failure',
          cause: Cause.interrupt('stop observer'),
        })
    },
  )

  it.each(['sync', 'async'] as const)(
    'keeps a resource owned by the caller after a successful %s memoized run',
    async (mode) => {
      const events: string[] = []
      const acquire = mode === 'sync' ? ResultTask.ok(42) : ResultTask.tryPromise(async () => 42)
      const memo = ResultTask.memoize(
        ResultTask.acquireRelease({
          acquire,
          release: (value) =>
            ResultTask.sync(() => {
              events.push(`release:${value}`)
            }),
        }),
      )
      const use = memo.map((value) => {
        events.push(`use:${value}`)
        return value
      })
      expect(await use.runPromise()).toBe(42)
      expect(events).toEqual(['use:42', 'release:42'])
    },
  )

  it.each(['sync', 'async'] as const)(
    'appends cleanup failure after a %s memoized failure',
    async (mode) => {
      const resource = ResultTask.acquireRelease({
        acquire: ResultTask.ok(42),
        release: () => ResultTask.err('release failed'),
      })
      const fail =
        mode === 'sync'
          ? ResultTask.err('use failed')
          : ResultTask.tryPromise({
              try: () => Promise.reject(new Error('use failed')),
              catch: () => 'use failed',
            })
      const memo = ResultTask.memoize(resource.andThen(() => fail))
      expect(await memo.runExit()).toEqual({
        _tag: 'Failure',
        cause: Cause.sequential(Cause.fail('use failed'), Cause.fail('release failed')),
      })
    },
  )

  it('interrupts an aborting waiter immediately without killing other active waiters, and aborts underlying when all waiters abort', async () => {
    const clock = Clock.virtual()
    let starts = 0
    let underlyingAborted = false
    const slow = ResultTask.tryPromise({
      try: (signal) =>
        new Promise<number>((resolve, reject) => {
          starts += 1
          signal.addEventListener(
            'abort',
            () => {
              underlyingAborted = true
              reject(new Error('aborted'))
            },
            { once: true },
          )
          void ResultTask.sleep(50)
            .runPromise({ clock, signal })
            .then(
              () => resolve(starts * 10),
              () => undefined,
            )
        }),
      catch: () => 'failed' as const,
    })

    const memo = ResultTask.memoize(slow)
    const ctrlA = new AbortController()
    const ctrlB = new AbortController()

    const waiterA = ResultTask.runExit(memo, { clock, signal: ctrlA.signal })
    const waiterB = ResultTask.runExit(memo, { clock, signal: ctrlB.signal })
    await clock.flush()

    // Aborting A interrupts A immediately while B continues
    ctrlA.abort('abort-A')
    deepEqual(await waiterA, { _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'abort-A' } })
    equal(underlyingAborted, false)
    equal(starts, 1)

    await clock.advanceBy(50)
    deepEqual(await waiterB, { _tag: 'Success', value: 10 })
    equal(underlyingAborted, false)

    // Test timeout & all-waiters-aborted path on a fresh memo
    let starts2 = 0
    let aborted2 = false
    const memo2 = ResultTask.memoize(
      ResultTask.tryPromise({
        try: (signal) =>
          new Promise<number>((_resolve, reject) => {
            starts2 += 1
            signal.addEventListener(
              'abort',
              () => {
                aborted2 = true
                reject(new Error('aborted'))
              },
              { once: true },
            )
          }),
        catch: () => 'err' as const,
      }),
    )

    const timed = ResultTask.runExit(
      ResultTask.timeout(memo2, 10, () => 'timed-out' as const),
      { clock },
    )
    await clock.flush()
    await clock.advanceBy(10)
    deepEqual(await timed, { _tag: 'Failure', cause: { _tag: 'Fail', error: 'timed-out' } })
    equal(starts2, 1)
    equal(aborted2, true)
  })

  it('isolates failure cause span traces across concurrent memoize observers', async () => {
    const clock = Clock.virtual()
    const memo = ResultTask.memoize(ResultTask.sleep(10).andThen(() => ResultTask.err('boom')))

    const pA = ResultTask.runExit(memo.withSpan('caller-A'), { clock })
    const pB = ResultTask.runExit(memo.withSpan('caller-B'), { clock })
    await clock.advanceBy(10)

    const [exitA, exitB] = await Promise.all([pA, pB])
    equal(exitA._tag, 'Failure')
    equal(exitB._tag, 'Failure')
    if (exitA._tag === 'Failure' && exitB._tag === 'Failure') {
      deepEqual(
        Cause.spans(exitA.cause).map((f) => f.name),
        ['caller-A'],
      )
      deepEqual(
        Cause.spans(exitB.cause).map((f) => f.name),
        ['caller-B'],
      )
    }
  })
})

describe('Semaphore compaction and aborted waiter cleanup', () => {
  it('compacts waiter queue and releases permits cleanly across >100 queued and aborted waiters', async () => {
    const clock = Clock.virtual()
    const sem = Semaphore.make(1)
    const gate = Promise.withResolvers<void>()

    const holder = ResultTask.runPromise(
      sem.withPermit(ResultTask.fromPromise(() => gate.promise)),
      { clock },
    )
    await clock.flush()

    const abortedWaiters: Promise<unknown>[] = []
    for (let index = 0; index < 80; index += 1) {
      const controller = new AbortController()
      const pending = ResultTask.runExit(sem.withPermit(ResultTask.ok(index)), {
        clock,
        signal: controller.signal,
      })
      controller.abort('cancel')
      abortedWaiters.push(pending)
    }
    await Promise.all(abortedWaiters)

    const results: Promise<number>[] = []
    for (let index = 0; index < 80; index += 1) {
      results.push(ResultTask.runPromise(sem.withPermit(ResultTask.ok(index)), { clock }))
    }

    gate.resolve()
    await holder
    const resolved = await Promise.all(results)
    equal(resolved.length, 80)
    equal(resolved[0], 0)
    equal(resolved[79], 79)
    equal(sem.available(), 1)
  })
})

describe('ManagedFiber unjoined child scope cleanup', () => {
  it('unregisters completed unjoined Success and pure-Interrupt forkChild fibers while retaining failed ones', async () => {
    const clock = Clock.virtual()
    const owner = ResultTask.makeScope()

    const fibers = []
    for (let index = 0; index < 50; index += 1) {
      const fiber = await ResultTask.runPromise(
        owner.use(ResultTask.forkChild(ResultTask.ok(index))),
        { clock },
      )
      fibers.push(fiber)
    }
    await clock.flush()
    for (const fiber of fibers) {
      equal(fiber.poll()?._tag, 'Success')
    }
    // Verify via a pure-Interrupt child too (pure Interrupt should also unregister)
    const interruptedFiber = await ResultTask.runPromise(
      owner.use(
        ResultTask.forkChild(ResultTask.err(Cause.interrupt('pure-interrupt')).unsandbox()),
      ),
      { clock },
    )
    await clock.flush()
    equal(interruptedFiber.poll()?._tag, 'Failure')

    // An unobserved failing child is still retained and reported on close
    await ResultTask.runPromise(
      owner.use(ResultTask.forkChild(ResultTask.err('unobserved-child' as const))),
      { clock },
    )
    await clock.flush()

    const closeExit = await ResultTask.runExit(owner.close(), { clock })
    deepEqual(closeExit, { _tag: 'Failure', cause: { _tag: 'Fail', error: 'unobserved-child' } })

    // Directly verify TaskScope has 0 retained children once unjoined Success & Interrupt fibers settle
    const directScope = new TaskScope()
    const okFiber = startFiber({
      scope: directScope,
      signal: NEVER_ABORTED_SIGNAL,
      prepare: () => ({
        execute: () => ({ _tag: 'Success', value: 'done' }),
        complete: (exit) => exit,
      }),
    })
    const intFiber = startFiber({
      scope: directScope,
      signal: NEVER_ABORTED_SIGNAL,
      prepare: () => ({
        execute: () => ({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'done' } }),
        complete: (exit) => exit,
      }),
    })
    await Promise.all([okFiber.outcome, intFiber.outcome])
    // If any child were still registered, closeSyncOrAsync would return a Promise instead of a sync Exit.
    const syncClosed = directScope.closeSyncOrAsync({ _tag: 'Success', value: undefined })
    assertOk('_tag' in syncClosed)
    deepEqual(syncClosed, { _tag: 'Success', value: undefined })
  })
})

describe('ResultTask.makeScope runtime context and sync-abort fixes', () => {
  it('propagates close() clock, tracer, and TaskLocal context into addFinalizer tasks', async () => {
    const clock = Clock.virtual()
    const memory = Tracer.memory()
    const RequestId = TaskLocal.make('none')
    let observedLocal = ''
    let finishedAt = -1

    const owner = ResultTask.makeScope()
    owner.addFinalizer(() =>
      ResultTask.gen(function* () {
        observedLocal = yield* RequestId.get()
        yield* ResultTask.sleep(25)
        finishedAt = yield* ResultTask.now()
      }).withSpan('scope.finalizer'),
    )

    const closeExit = await clock.runToCompletion(RequestId.locally('req-99', owner.close()), {
      tracer: memory.tracer,
    })
    deepEqual(closeExit, { _tag: 'Success', value: undefined })
    equal(observedLocal, 'req-99')
    equal(finishedAt, 25)
    assertOk(memory.spans.some((span) => span.name === 'scope.finalizer'))
  })

  it('does not hang in scope.use when task aborts caller signal synchronously before suspending', async () => {
    const owner = ResultTask.makeScope()
    const controller = new AbortController()
    const syncAbortThenHang = ResultTask.tryPromise({
      try: (scopeSignal) => {
        controller.abort('sync-abort')
        return new Promise<void>((resolve) => {
          scopeSignal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
      catch: () => 'err' as const,
    })

    const exit = await ResultTask.runExit(owner.use(syncAbortThenHang), {
      signal: controller.signal,
    })
    deepEqual(exit, { _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'sync-abort' } })
    deepEqual(await ResultTask.runExit(owner.close()), { _tag: 'Success', value: undefined })
  })
})

describe('Collection and iterator edge cases', () => {
  it('checks Symbol.iterator is a function in ResultTask.all', () => {
    const record = { [Symbol.iterator]: undefined, a: ResultTask.ok(1), b: ResultTask.ok('two') }
    deepEqual(
      ResultTask.all(record as unknown as Record<string, ResultTask<number | string>>).runSync(),
      ok({ a: 1, b: 'two' }),
    )
  })

  it('materializes non-array iterables lazily in raceAll and raceFirstAll', async () => {
    let iterations = 0
    const lazyIterable: Iterable<ResultTask<number>> = {
      *[Symbol.iterator]() {
        iterations += 1
        yield ResultTask.ok(iterations)
      },
    }

    const racedAll = ResultTask.raceAll(lazyIterable)
    const racedFirst = ResultTask.raceFirstAll(lazyIterable)
    equal(iterations, 0)

    deepEqual(await racedAll.runResult(), ok(1))
    equal(iterations, 1)
    deepEqual(await racedFirst.runResult(), ok(2))
    equal(iterations, 2)

    const emptyIterable: Iterable<ResultTask<number>> = {
      *[Symbol.iterator]() {
        // yields nothing
      },
    }
    const emptyExit = await ResultTask.raceAll(emptyIterable).runExit()
    equal(emptyExit._tag, 'Failure')
    if (emptyExit._tag === 'Failure') {
      equal(emptyExit.cause._tag, 'Die')
      if (emptyExit.cause._tag === 'Die') {
        assertOk(emptyExit.cause.defect instanceof RangeError)
      }
    }
  })

  it('does not clobber Success when firstSuccessOf iterator.return() throws', async () => {
    function* candidates() {
      try {
        yield ResultTask.ok(42)
        yield ResultTask.ok(99)
      } finally {
        // eslint-disable-next-line no-unsafe-finally
        throw new Error('iterator cleanup failed')
      }
    }
    deepEqual(await ResultTask.firstSuccessOf(candidates()).runResult(), ok(42))
  })

  it('preserves a single Die directly in ResultTask.validateAll without wrapping in ResultTaskCauseError', async () => {
    const bug = new Error('single-defect')
    const task = ResultTask.validateAll([1, 2], (n) =>
      n === 1
        ? ResultTask.sync(() => {
            throw bug
          })
        : ResultTask.ok(n),
    )
    const exit = await task.runExit()
    deepEqual(exit, { _tag: 'Failure', cause: { _tag: 'Die', defect: bug } })
    await rejects(task.runPromise(), (error) => error === bug)
  })
})

describe('JIT non-string tag and prefix guards', () => {
  it('handles non-string catchTag tags across multiple executions without throwing', async () => {
    const numChain = ResultTask.ok(1)
      .andThen(() => ResultTask.err({ _tag: 123 as unknown as string }))
      .catchTag(123 as unknown as string, () => ResultTask.ok('matched-num'))

    const undefChain = ResultTask.ok(1)
      .andThen(() => ResultTask.err({ _tag: undefined as unknown as string }))
      .catchTag(undefined as unknown as string, () => ResultTask.ok('matched-undef'))

    for (let run = 0; run < 4; run += 1) {
      deepEqual(await numChain.runResult(), ok('matched-num'))
      deepEqual(await undefChain.runResult(), ok('matched-undef'))
    }
  })

  it('handles non-string tagStartsWith prefix in Match.type without throwing during compilation', () => {
    const matcher = Match.type<{ readonly _tag: string }>().pipe(
      Match.tagStartsWith(undefined as unknown as string, () => 'hit'),
      Match.orElse(() => 'miss'),
    )
    equal(matcher({ _tag: 'alpha' }), 'miss')
  })

  it('bails out before allocating resumers or codegen when RESULTAR_JIT=0', () => {
    const previous = process.env['RESULTAR_JIT']
    process.env['RESULTAR_JIT'] = '0'
    try {
      let resumerBuilt = false
      const leaf: TaskNodeLike = {
        op: OP_SUCCESS,
        value: 1,
        continuation: undefined,
        run: () => ({ _tag: 'Success', value: 1 }),
      }
      const step1: TaskNodeLike = {
        op: OP_MAP,
        value: leaf,
        continuation: (n: number) => n + 1,
        run: () => ({ _tag: 'Success', value: 2 }),
      }
      const step2: TaskNodeLike = {
        op: OP_MAP,
        value: step1,
        continuation: (n: number) => n + 1,
        run: () => ({ _tag: 'Success', value: 3 }),
      }
      const helpers = {
        createAsyncResumer: () => {
          resumerBuilt = true
          throw new Error('should not allocate resumer when JIT disabled')
        },
        createSyncResumer: () => {
          resumerBuilt = true
          throw new Error('should not allocate resumer when JIT disabled')
        },
      } as unknown as TaskJitHelpers
      equal(compileTaskChain(step2, helpers), undefined)
      equal(resumerBuilt, false)
    } finally {
      if (previous === undefined) delete process.env['RESULTAR_JIT']
      else process.env['RESULTAR_JIT'] = previous
    }
  })
})

describe('Prototype safety, TaggedError, taggedEnum, Tracer, Result, ResultAsync, TaskLocal, and Match', () => {
  it('preserves __proto__ as an own data property in Result.all, Result.validateAll, ResultAsync.all, and Tracer.memory', async () => {
    const rawProtoRecord = JSON.parse('{"__proto__":1,"a":2}') as Record<string, number>
    const resultRecord: Record<string, Result<number, string>> = {}
    for (const [k, v] of Object.entries(rawProtoRecord)) {
      Object.defineProperty(resultRecord, k, {
        value: ok(v),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }

    const allRes = Result.all(resultRecord)
    assertOk(allRes.isOk())
    equal(Object.getPrototypeOf(allRes.value), Object.prototype)
    equal(Object.getOwnPropertyDescriptor(allRes.value, '__proto__')?.value, 1)

    const valRes = Result.validateAll(resultRecord)
    assertOk(valRes.isOk())
    equal(Object.getPrototypeOf(valRes.value), Object.prototype)
    equal(Object.getOwnPropertyDescriptor(valRes.value, '__proto__')?.value, 1)

    const asyncRecord: Record<string, ResultAsync<number, string>> = {}
    for (const [k, v] of Object.entries(rawProtoRecord)) {
      Object.defineProperty(asyncRecord, k, {
        value: okAsync(v),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    const asyncAll = await ResultAsync.all(asyncRecord)
    assertOk(asyncAll.isOk())
    equal(Object.getPrototypeOf(asyncAll.value), Object.prototype)
    equal(Object.getOwnPropertyDescriptor(asyncAll.value, '__proto__')?.value, 1)

    const memory = Tracer.memory()
    const attrs = JSON.parse('{"__proto__":"data","ok":true}') as Record<string, string | boolean>
    await ResultTask.ok(1).withSpan('proto.span', attrs).runPromise({ tracer: memory.tracer })
    const recorded = memory.spans[0]
    assertOk(recorded !== undefined)
    equal(Object.getPrototypeOf(recorded.attributes), Object.prototype)
    equal(Object.getOwnPropertyDescriptor(recorded.attributes, '__proto__')?.value, 'data')
  })

  it('protects TaggedError metadata, template interpolation, BigInt/circular values, and circular/nested toJSON', () => {
    const ProtoTemplate = createTaggedError({
      name: 'ProtoTemplate',
      message: '$__proto__ $constructor $toString $payload',
    })
    const circular: { self?: unknown } = {}
    circular.self = circular
    const errNoOwnProtoKeys = new (ProtoTemplate as unknown as new (
      props: Record<string, unknown>,
    ) => Error)({ payload: { big: 1n } })
    equal(errNoOwnProtoKeys.message, '$__proto__ $constructor $toString [object Object]')

    class CustomGetterProps {
      private readonly raw = 'from-getter'
      public get payload(): string {
        return this.raw
      }
    }
    const errWithCustomGetter = new (ProtoTemplate as unknown as new (props: object) => Error)(
      new CustomGetterProps(),
    )
    equal(errWithCustomGetter.message, '$__proto__ $constructor $toString from-getter')

    const err1 = new (ProtoTemplate as unknown as new (
      props: Record<string, unknown>,
    ) => Error & {
      readonly then?: unknown
      readonly toJSON: () => object
      readonly findCause: unknown
    })({
      payload: { big: 1n },
      then: () => 'hijack',
      toJSON: 'hijack',
      findCause: 'hijack',
      constructor: 'hijack',
    })
    equal('then' in err1, false)
    equal(typeof err1.toJSON, 'function')
    equal(typeof err1.findCause, 'function')
    equal(err1.constructor, ProtoTemplate)

    const errCircularVal = new (ProtoTemplate as unknown as new (
      props: Record<string, unknown>,
    ) => Error)({ payload: circular })
    equal(errCircularVal.message, '$__proto__ $constructor $toString [object Object]')

    // Self-referential cause should mark [Circular] immediately without unrolling twice
    const SelfErr = createTaggedError({ name: 'SelfErr', message: 'self' })
    const selfErr = new SelfErr()
    Object.defineProperty(selfErr, 'cause', { value: selfErr, configurable: true })
    const selfJson = selfErr.toJSON() as { readonly cause: { readonly cause: unknown } }
    equal(selfJson.cause.cause, '[Circular]')

    // Nested TaggedError cause delegates to toJSON() and handles mutual cycles safely
    const InnerErr = createTaggedError({ name: 'InnerErr', message: 'Inner $code' })
    const OuterErr = createTaggedError({ name: 'OuterErr', message: 'Outer $id' })
    const inner = new InnerErr({ code: 500 })
    const outer = new OuterErr({ id: 'req-1', cause: inner })
    const outerJson = outer.toJSON() as {
      readonly _tag: string
      readonly cause: { readonly _tag: string; readonly code: number }
    }
    equal(outerJson._tag, 'OuterErr')
    equal(outerJson.cause._tag, 'InnerErr')
    equal(outerJson.cause.code, 500)

    // Mutually circular TaggedErrors
    Object.defineProperty(inner, 'cause', { value: outer, configurable: true })
    const mutualJson = outer.toJSON() as {
      readonly cause: { readonly _tag: string; readonly cause: { readonly cause: unknown } }
    }
    equal(mutualJson.cause._tag, 'InnerErr')
    equal(mutualJson.cause.cause.cause, '[Circular]')
  })

  it('guards taggedEnum.$match on nullish inputs and copies own enumerable symbols in constructors', () => {
    const sym = Symbol('meta')
    const hiddenSym = Symbol('hidden')
    const State = taggedEnum<{ Ready: { readonly id: string; readonly [sym]?: string } }>()

    throws(
      () => State.$match(null as never, { Ready: () => 'ok' }),
      /No tagged enum handler for null/u,
    )
    throws(
      () => State.$match(undefined as never, { Ready: () => 'ok' }),
      /No tagged enum handler for undefined/u,
    )

    const props: Record<PropertyKey, unknown> = { id: '1', [sym]: 'visible' }
    Object.defineProperty(props, hiddenSym, { value: 'secret', enumerable: false })
    const ready = State.Ready(props as { readonly id: string; readonly [sym]?: string })
    equal(ready[sym], 'visible')
    equal(hiddenSym in ready, false)
  })

  it('rejects cleanly when ResultAsync race/raceAll/raceFirst/raceWith tasks or handlers reject/throw', async () => {
    const boom = new Error('race-reject')
    const rejectingTask: ResultAsyncRaceTask<number, string> = () =>
      new ResultAsync<number, string>(Promise.reject(boom))
    const pendingTask: ResultAsyncRaceTask<number, string> = (signal) =>
      new ResultAsync<number, string>(
        new Promise<Result<number, string>>((resolve) => {
          signal.addEventListener('abort', () => resolve(err('aborted')), { once: true })
        }),
      )

    await rejects(Promise.resolve(ResultAsync.race(rejectingTask, pendingTask)), (e) => e === boom)
    await rejects(
      Promise.resolve(ResultAsync.raceAll([rejectingTask, pendingTask])),
      (e) => e === boom,
    )
    await rejects(
      Promise.resolve(ResultAsync.raceFirst(rejectingTask, pendingTask)),
      (e) => e === boom,
    )
    await rejects(
      Promise.resolve(
        ResultAsync.raceWith(rejectingTask, pendingTask, {
          onLeftDone: () => okAsync(1),
          onRightDone: () => okAsync(2),
        }),
      ),
      (e) => e === boom,
    )
    await rejects(
      Promise.resolve(
        ResultAsync.raceWith(() => okAsync(1), pendingTask, {
          onLeftDone: () => {
            throw boom
          },
          onRightDone: () => okAsync(2),
        }),
      ),
      (e) => e === boom,
    )
    await rejects(
      Promise.resolve(
        ResultAsync.raceWith(() => okAsync(1), pendingTask, {
          onLeftDone: () => new ResultAsync<number, string>(Promise.reject(boom)),
          onRightDone: () => okAsync(2),
        }),
      ),
      (e) => e === boom,
    )
  })

  it('preserves this binding in ResultAsync.fromThrowable', async () => {
    const service = {
      prefix: 'svc',
      load: ResultAsync.fromThrowable(async function (
        this: { readonly prefix: string },
        id: number,
      ) {
        return `${this.prefix}:${id}`
      }),
    }
    deepEqual(await service.load(7), ok('svc:7'))
  })

  it('keeps Ok.prototype and Err.prototype methods non-enumerable', () => {
    const okKeys: string[] = []
    // eslint-disable-next-line guard-for-in -- Explicitly testing prototype non-enumerability in for..in.
    for (const key in ok(1)) {
      okKeys.push(key)
    }
    deepEqual(okKeys, ['value'])

    const errKeys: string[] = []
    // eslint-disable-next-line guard-for-in -- Explicitly testing prototype non-enumerability in for..in.
    for (const key in err('e')) {
      errKeys.push(key)
    }
    deepEqual(errKeys, ['error'])
  })

  it('validates TaskLocal.locally and locallyWith in curried form', () => {
    const local = TaskLocal.make(0)
    throws(() => local.locally(1)(null as never), TypeError)
    throws(() => local.locallyWith((n) => n + 1)(null as never), TypeError)
  })

  it('reads Match.valueTags handler properties strictly once', () => {
    let getterReads = 0
    const handlers = {
      get A() {
        getterReads += 1
        return (value: { readonly _tag: 'A'; readonly n: number }) => value.n * 2
      },
    }
    equal(Match.valueTags({ _tag: 'A' as const, n: 21 }, handlers), 42)
    equal(getterReads, 1)
  })

  it('preserves Result.zip direct semantics without silently skipping undefined', () => {
    deepEqual(Result.zip(ok(1), ok('a')), ok([1, 'a']))
    deepEqual(Result.zip(err('left'), ok('a')), err('left'))
    deepEqual(Result.zip(ok(1), err('right')), err('right'))
    throws(() => Result.zip(ok(1), undefined as never), TypeError)
  })
})
