import { getEventListeners } from 'node:events'

import { describe, expect, it, vi } from 'vite-plus/test'

import {
  Cause,
  Clock,
  createTaggedError,
  flow,
  ok,
  pipe,
  redact,
  ResultTask,
  Retry,
  serviceTag,
  Tracer,
} from '../src/index.js'
import type { TaskClock } from '../src/index.js'
import { createTaskLocalsCell, normalizeRuntimeContext } from '../src/task/task-service.js'
import type { ResultTaskRuntimeContext } from '../src/task/task-service.js'

describe('mutation coverage for new ergonomics, retry/repeat, and observability paths', () => {
  describe('normalizeRuntimeContext locals preservation', () => {
    it('creates a locals cell when absent and preserves an existing locals cell', () => {
      const partialWithoutLocals = {
        namedServices: new Map(),
        services: new Map(),
        serviceResolver: undefined,
        signal: new AbortController().signal,
        scope: {} as ResultTaskRuntimeContext['scope'],
        clock: undefined,
        scheduling: undefined,
        cleanup: undefined,
      } as unknown as ResultTaskRuntimeContext

      const normalizedA = normalizeRuntimeContext(partialWithoutLocals)
      expect(normalizedA.locals).toBeDefined()

      const existingLocals = createTaskLocalsCell()
      const partialWithLocals = {
        namedServices: new Map(),
        services: new Map(),
        serviceResolver: undefined,
        signal: new AbortController().signal,
        scope: {} as ResultTaskRuntimeContext['scope'],
        clock: undefined,
        scheduling: undefined,
        cleanup: undefined,
        locals: existingLocals,
      } as unknown as ResultTaskRuntimeContext
      const normalizedB = normalizeRuntimeContext(partialWithLocals)
      expect(normalizedB.locals).toBe(existingLocals)
    })
  })

  describe('ResultTask.retry maxDelayMs / maxElapsedMs and canonical pre-onRetry elapsed check', () => {
    it('caps exponential backoff at maxDelayMs and stops at maxElapsedMs on Retry.policy', async () => {
      const clock = Clock.virtual()
      const timestamps: number[] = []
      const task = ResultTask.sync(() => {
        timestamps.push(clock.now())
      }).andThen(() => ResultTask.err('boom' as const))

      const exit = await clock.runToCompletion(
        task.retry(
          Retry.policy({ times: 5, delayMs: 100, backoff: 2, maxDelayMs: 150, maxElapsedMs: 400 }),
        ),
      )

      expect(exit._tag).toBe('Failure')
      // Delays: 100 (t=100), 150 capped from 200 (t=250), 150 capped from 400 (t=400),
      // then next 150 would reach 550 > 400 so it stops.
      expect(timestamps).toEqual([0, 100, 250, 400])
    })

    it('rejects negative maxDelayMs and maxElapsedMs on Retry.policy', () => {
      expect(() => Retry.policy({ times: 1, maxDelayMs: -1 })).toThrow(RangeError)
      expect(() => Retry.policy({ times: 1, maxElapsedMs: -1 })).toThrow(RangeError)
    })

    it('stops before onRetry in canonical Retry.policy when attempt already exceeded maxElapsedMs', async () => {
      const clock = Clock.virtual()
      let onRetryCalls = 0
      const policy = Retry.policy<string>({
        times: 4,
        delayMs: 10,
        maxElapsedMs: 50,
        onRetry: () => {
          onRetryCalls += 1
        },
      })

      const slowFail = ResultTask.sleep(60).andThen(() => ResultTask.err('slow-err'))
      const exit = await clock.runToCompletion(slowFail.retry(policy))

      expect(exit._tag).toBe('Failure')
      expect(onRetryCalls).toBe(0)
      expect(clock.now()).toBe(60)
    })
  })

  describe('ResultTask.suspend edge cases', () => {
    it('captures synchronous throws as Die defects', async () => {
      const boom = new Error('suspend-boom')
      const exit = await ResultTask.suspend<number, never, never>(() => {
        throw boom
      }).runExit()

      expect(exit._tag).toBe('Failure')
      if (exit._tag === 'Failure') {
        expect(Cause.defects(exit.cause)).toEqual([boom])
      }
    })

    it('returns a descriptive TypeError defect when callback does not return a ResultTask', async () => {
      const exit = await ResultTask.suspend(
        () => 'not-a-task' as unknown as ResultTask<number>,
      ).runExit()

      expect(exit._tag).toBe('Failure')
      if (exit._tag === 'Failure') {
        const defects = Cause.defects(exit.cause)
        expect(defects[0]).toBeInstanceOf(TypeError)
        expect((defects[0] as TypeError).message).toBe(
          'ResultTask.suspend callback must return a ResultTask',
        )
      }
    })
  })

  describe('ResultTask.raceAll and raceFirstAll iterables and messages', () => {
    it('accepts non-array iterables and preserves first-success vs first-settlement semantics', async () => {
      const clock = Clock.virtual()

      const winnerExit = await clock.runToCompletion(
        ResultTask.raceAll(new Set([ResultTask.err('first-err'), ResultTask.sleep(10).as('ok')])),
      )
      expect(winnerExit).toEqual({ _tag: 'Success', value: 'ok' })

      const fastFailExit = await clock.runToCompletion(
        ResultTask.raceFirstAll(
          new Set([ResultTask.err('fast-err'), ResultTask.sleep(10).as('slow-ok')]),
        ),
      )
      expect(fastFailExit._tag).toBe('Failure')
      if (fastFailExit._tag === 'Failure') {
        expect(Cause.failures(fastFailExit.cause)).toEqual(['fast-err'])
      }

      expect(() => ResultTask.raceAll([])).toThrow('ResultTask.raceAll requires at least one task')
      expect(() => ResultTask.raceFirstAll([])).toThrow(
        'ResultTask.raceFirstAll requires at least one task',
      )
    })
  })

  describe('ResultTask.repeat full branch coverage', () => {
    it('validates repeat options eagerly', () => {
      expect(() => ResultTask.ok(1).repeat({ times: -1 })).toThrow(RangeError)
    })

    it('runs purely synchronous zero-delay repeats without Promises via runSync', () => {
      let runsA = 0
      const resultA = ResultTask.sync(() => {
        runsA += 1
        return runsA
      })
        .repeat({ times: 3 })
        .runSync()
      expect(resultA.unwrapOr(0)).toBe(4)

      let runsB = 0
      const resultB = ResultTask.sync(() => {
        runsB += 1
        return runsB
      })
        .repeat({ times: 2, delayMs: 0 })
        .runSync()
      expect(resultB.unwrapOr(0)).toBe(3)

      expect(ResultTask.ok(1).repeat({ times: 1, maxElapsedMs: 100 }).runSync().unwrapOr(0)).toBe(1)
      expect(() => ResultTask.ok(1).repeat({ times: 1, delayMs: 15 }).runSync()).toThrow(
        'ResultTask.runSync cannot execute an asynchronous task',
      )
    })

    it('respects custom clock sleep(0), jittered clock.random(), times bound, and maxElapsedMs', async () => {
      const sleptMs: number[] = []
      let currentTime = 0
      const recordingClock: TaskClock = {
        now: () => currentTime,
        random: () => 0.25,
        sleep: async (ms) => {
          sleptMs.push(ms)
          currentTime += ms
        },
      }

      let count = 0
      const zeroDelayExit = await ResultTask.sync(() => {
        count += 1
        return count
      })
        .repeat({ times: 2, delayMs: 0 })
        .runExit({ clock: recordingClock })
      expect(zeroDelayExit).toEqual({ _tag: 'Success', value: 3 })
      expect(sleptMs).toEqual([0, 0])

      sleptMs.length = 0
      currentTime = 0
      const jitterExit = await ResultTask.ok('tick')
        .repeat({ times: 2, delayMs: 100, jittered: 0.5 })
        .runExit({ clock: recordingClock })
      expect(jitterExit).toEqual({ _tag: 'Success', value: 'tick' })
      // jittered=0.5 with random=0.25 => factor = 1 + (0.25 * 2 - 1) * 0.5 = 0.75 => 75ms
      expect(sleptMs).toEqual([75, 75])

      const clock = Clock.virtual()
      let boundedRuns = 0
      const boundedExit = await clock.runToCompletion(
        ResultTask.sync(() => {
          boundedRuns += 1
          return boundedRuns
        }).repeat({ times: 5, delayMs: 100, maxElapsedMs: 150 }),
      )
      expect(boundedExit).toEqual({ _tag: 'Success', value: 2 })
      expect(clock.now()).toBe(100)

      const slowClock = Clock.virtual()
      let preElapsedObserverCalls = 0
      const preElapsedExit = await slowClock.runToCompletion(
        ResultTask.sleep(60)
          .as('slow')
          .repeat({
            times: 4,
            delayMs: 10,
            maxElapsedMs: 50,
            onRepeat: () => {
              preElapsedObserverCalls += 1
            },
          }),
      )
      expect(preElapsedExit).toEqual({ _tag: 'Success', value: 'slow' })
      expect(preElapsedObserverCalls).toBe(0)
      expect(slowClock.now()).toBe(60)
    })

    it('supports while, until, onRepeat, Retry.policy onRetry, and propagates predicate defects', async () => {
      let val = 0
      const whileRes = await ResultTask.sync(() => {
        val += 1
        return val
      })
        .repeat({ times: 10, while: (v) => v < 3 })
        .runPromise()
      expect(whileRes).toBe(3)

      const whileBoom = new Error('while-boom')
      const whileDefect = await ResultTask.ok(1)
        .repeat({
          times: 2,
          while: () => {
            throw whileBoom
          },
        })
        .runExit()
      expect(whileDefect._tag).toBe('Failure')
      if (whileDefect._tag === 'Failure') {
        expect(Cause.defects(whileDefect.cause)).toEqual([whileBoom])
      }

      const untilBoom = new Error('until-boom')
      const untilDefect = await ResultTask.ok(1)
        .repeat({
          times: 2,
          until: () => {
            throw untilBoom
          },
        })
        .runExit()
      expect(untilDefect._tag).toBe('Failure')
      if (untilDefect._tag === 'Failure') {
        expect(Cause.defects(untilDefect.cause)).toEqual([untilBoom])
      }

      let untilVal = 0
      const untilRes = await ResultTask.sync(() => {
        untilVal += 1
        return untilVal
      })
        .repeat({ times: 5, until: (v) => v >= 2 })
        .runPromise()
      expect(untilRes).toBe(2)

      const repeatedEvents: number[] = []
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      try {
        const onRepeatRes = await ResultTask.sync(() => repeatedEvents.length + 1)
          .repeat({
            times: 2,
            delayMs: 0,
            onRepeat: (v) => {
              repeatedEvents.push(v)
            },
          })
          .runPromise()
        expect(onRepeatRes).toBe(3)
        expect(repeatedEvents).toEqual([1, 2])
        expect(setTimeoutSpy).not.toHaveBeenCalled()
      } finally {
        setTimeoutSpy.mockRestore()
      }

      const policyEvents: number[] = []
      const policyRes = await ResultTask.sync(() => policyEvents.length + 1)
        .repeat(
          Retry.policy<number>({
            times: 2,
            delayMs: 0,
            onRetry: (v) => {
              policyEvents.push(v)
            },
          }),
        )
        .runPromise()
      expect(policyRes).toBe(3)
      expect(policyEvents).toEqual([1, 2])
    })

    it('handles interruption in body, observer, and delay', async () => {
      const controllerBody = new AbortController()
      let bodyRuns = 0
      let delayFnCalls = 0
      const interruptedAfterBody = await ResultTask.sync(() => {
        bodyRuns += 1
        controllerBody.abort('stop-body')
        return bodyRuns
      })
        .repeat({
          times: 5,
          delayMs: () => {
            delayFnCalls += 1
            return 10
          },
        })
        .runExit({ signal: controllerBody.signal })
      expect(interruptedAfterBody._tag).toBe('Failure')
      if (interruptedAfterBody._tag === 'Failure') {
        expect(Cause.isInterruptedOnly(interruptedAfterBody.cause)).toBe(true)
      }
      expect(bodyRuns).toBe(1)
      expect(delayFnCalls).toBe(0)

      const controllerObserver = new AbortController()
      let observerDelayCalls = 0
      const pendingObserver = ResultTask.ok(1)
        .repeat({
          times: 2,
          delayMs: () => {
            observerDelayCalls += 1
            return 10
          },
          onRepeat: () =>
            new Promise<void>(() => {
              controllerObserver.abort('stop-observer')
            }),
        })
        .runExit({ signal: controllerObserver.signal })
      const interruptedObserver = await pendingObserver
      expect(interruptedObserver._tag).toBe('Failure')
      if (interruptedObserver._tag === 'Failure') {
        expect(Cause.isInterruptedOnly(interruptedObserver.cause)).toBe(true)
      }
      expect(observerDelayCalls).toBe(0)

      const controllerSleep = new AbortController()
      const pendingSleep = ResultTask.ok(1)
        .repeat({ times: 3, delayMs: 500 })
        .runExit({ signal: controllerSleep.signal })
      setTimeout(() => controllerSleep.abort('stop-sleep'), 10)
      const interruptedSleep = await pendingSleep
      expect(interruptedSleep._tag).toBe('Failure')
      if (interruptedSleep._tag === 'Failure') {
        expect(Cause.isInterruptedOnly(interruptedSleep.cause)).toBe(true)
      }
    })

    it('propagates defects rejected by custom clock sleep during repeat', async () => {
      const sleepBoom = new Error('sleep-boom')
      let sleepDefectRuns = 0
      const failingClock: TaskClock = {
        now: () => 0,
        random: () => 0.5,
        sleep: () => Promise.reject(sleepBoom),
      }
      const sleepDefect = await ResultTask.sync(() => {
        sleepDefectRuns += 1
        return sleepDefectRuns
      })
        .repeat({ times: 2, delayMs: 10 })
        .runExit({ clock: failingClock })
      expect(sleepDefect._tag).toBe('Failure')
      if (sleepDefect._tag === 'Failure') {
        expect(Cause.defects(sleepDefect.cause)).toEqual([sleepBoom])
      }
      expect(sleepDefectRuns).toBe(1)
    })

    it('awaits async scope finalizers sequentially on sync and async bodies', async () => {
      const syncEvents: string[] = []
      let syncAttempt = 0
      const syncBodyAsyncFinalizer = ResultTask.acquireRelease({
        acquire: ResultTask.sync(() => {
          syncAttempt += 1
          syncEvents.push(`acquire:${syncAttempt}`)
          return syncAttempt
        }),
        release: (id) =>
          ResultTask.sleep(1).map(() => {
            syncEvents.push(`release:${id}`)
            return undefined
          }),
      })
      const syncFinalizerRes = await syncBodyAsyncFinalizer.repeat({ times: 1 }).runPromise()
      expect(syncFinalizerRes).toBe(2)
      expect(syncEvents).toEqual(['acquire:1', 'release:1', 'acquire:2', 'release:2'])

      const releasedAsync: number[] = []
      let asyncAttempt = 0
      const asyncBodyAsyncFinalizer = ResultTask.acquireRelease({
        acquire: ResultTask.sleep(1).map(() => {
          asyncAttempt += 1
          return asyncAttempt
        }),
        release: (id) =>
          ResultTask.sleep(1).map(() => {
            releasedAsync.push(id)
            return undefined
          }),
      })
      const asyncFinalizerRes = await asyncBodyAsyncFinalizer.repeat({ times: 1 }).runPromise()
      expect(asyncFinalizerRes).toBe(2)
      expect(releasedAsync).toEqual([1, 2])
    })
  })

  describe('ResultTask.withSpan curried form and attribute-less frames', () => {
    it('supports curried ResultTask.withSpan in pipe and omits attributes key when not supplied', async () => {
      const tracer = Tracer.memory()
      const value = await pipe(
        ResultTask.ok(42),
        ResultTask.withSpan('curried.span', { env: 'ci' }),
      ).runPromise({ tracer })

      expect(value).toBe(42)
      expect(tracer.spans).toHaveLength(1)
      expect(tracer.spans[0]?.name).toBe('curried.span')
      expect(tracer.spans[0]?.attributes).toEqual({ env: 'ci' })

      const exit = await ResultTask.err('boom').withSpan('bare.span').runExit()
      expect(exit._tag).toBe('Failure')
      if (exit._tag === 'Failure') {
        const frames = Cause.spans(exit.cause)
        expect(frames).toHaveLength(1)
        expect(frames[0]?.name).toBe('bare.span')
        expect(Object.hasOwn(frames[0] as object, 'attributes')).toBe(false)
      }
    })
  })

  describe('ResultTask.runSync option handling and cooperative yield override', () => {
    it('executes >2048 sync steps by default, respects explicit yieldEvery, and forwards services/tracer', () => {
      let manySteps: ResultTask<number> = ResultTask.ok(0)
      for (let i = 0; i < 2100; i += 1) {
        manySteps = manySteps.map((n) => n + 1)
      }
      expect(manySteps.runSync().unwrapOr(0)).toBe(2100)

      let fewSteps: ResultTask<number> = ResultTask.ok(0)
      for (let i = 0; i < 5; i += 1) {
        fewSteps = fewSteps.map((n) => n + 1)
      }
      expect(() => fewSteps.runSync({ yieldEvery: 1 })).toThrow(
        'ResultTask.runSync cannot execute an asynchronous task',
      )

      const Counter = serviceTag<{ readonly value: number }>('Counter')
      const readCounter = ResultTask.gen(function* () {
        const svc = yield* Counter
        return svc.value
      })
      expect(readCounter.runSync({ services: { Counter: { value: 99 } } }).unwrapOr(0)).toBe(99)

      const tracer = Tracer.memory()
      expect(ResultTask.ok('hi').withSpan('sync.span').runSync({ tracer }).unwrapOr('')).toBe('hi')
      expect(tracer.spans.map((s) => s.name)).toEqual(['sync.span'])
    })

    it('disposes parent AbortSignal listeners on sync return, sync option error, and async step abort', async () => {
      // 1. Sync completion disposes listener
      const syncController = new AbortController()
      expect(ResultTask.ok(1).runSyncExit({ signal: syncController.signal })).toEqual({
        _tag: 'Success',
        value: 1,
      })
      expect(getEventListeners(syncController.signal, 'abort')).toHaveLength(0)

      // 2. Synchronous option validation throw disposes listener
      const errController = new AbortController()
      expect(() =>
        ResultTask.ok(1).runSyncExit({ signal: errController.signal, yieldEvery: 0 }),
      ).toThrow(RangeError)
      expect(getEventListeners(errController.signal, 'abort')).toHaveLength(0)

      // 3. Asynchronous step aborts with exact reason and disposes listener after settling
      const asyncController = new AbortController()
      let observedAbortReason: unknown = undefined
      const settled = Promise.withResolvers<void>()
      const asyncTask = ResultTask.fromCallback<number, never>({
        subscribe: ({ signal }) => {
          signal.addEventListener(
            'abort',
            () => {
              observedAbortReason = signal.reason
              settled.resolve()
            },
            { once: true },
          )
          return () => undefined
        },
      })

      expect(() => asyncTask.runSyncExit({ signal: asyncController.signal })).toThrow(
        'ResultTask.runSync cannot execute an asynchronous task',
      )
      await settled.promise
      await Promise.resolve()
      await Promise.resolve()
      expect(observedAbortReason).toBe('ResultTask.runSync encountered an asynchronous step')
      expect(getEventListeners(asyncController.signal, 'abort')).toHaveLength(0)
    })
  })

  describe('pipe, tagged-error fallback, and ResultTask catch continuation mutation coverage', () => {
    it('throws TypeError with exact message when runPipe (>8 args) receives undefined transform', () => {
      const inc = (n: number) => n + 1
      const callPipe = pipe as unknown as (...args: readonly unknown[]) => unknown
      expect(() => callPipe(1, inc, inc, inc, inc, inc, inc, inc, inc, undefined)).toThrow(
        new TypeError('pipe requires transformation functions'),
      )
      const callFlow = flow as unknown as (...args: readonly unknown[]) => (n: number) => unknown
      const invalidFlow = callFlow(inc, inc, inc, inc, inc, inc, inc, inc, inc, undefined)
      expect(() => invalidFlow(1)).toThrow(new TypeError('pipe requires transformation functions'))
    })

    it('covers tagged-error fallback interpolator with undefined, null, and object/redacted values', () => {
      const previous = process.env['RESULTAR_JIT']
      process.env['RESULTAR_JIT'] = '0'
      try {
        const FallbackErr = createTaggedError({
          name: 'FallbackErr',
          message: 'item $id: $meta ($secret)',
        })
        const BareDefaultErr = createTaggedError({ name: 'BareDefaultErr' })
        const RawFallbackErr = FallbackErr as unknown as new (props?: unknown) => Error

        // Undefined and null constructor props keep the raw template verbatim in fallback mode.
        const fromUndefined = new RawFallbackErr()
        // eslint-disable-next-line unicorn/no-null -- Verify null props handling in fallback interpolator.
        const fromNull = new RawFallbackErr(null)
        const fromValues = new RawFallbackErr({
          id: 7,
          meta: { ok: true },
          secret: redact('top-secret'),
        })
        const fromObjectDefault = new (BareDefaultErr as unknown as new (props?: unknown) => Error)(
          { message: { nested: 1 } },
        )

        expect(fromUndefined.message).toBe('item $id: $meta ($secret)')
        expect(fromNull.message).toBe('item $id: $meta ($secret)')
        expect(fromValues.message).toBe('item 7: {"ok":true} (<redacted>)')
        expect(fromObjectDefault.message).toBe('{"nested":1}')
      } finally {
        if (previous === undefined) delete process.env['RESULTAR_JIT']
        else process.env['RESULTAR_JIT'] = previous
      }
    })

    it('turns synchronous throws in catchTag/catchTags into Die and preserves ok() recovery into downstream map', () => {
      const defectA = new Error('catchTag-throw')
      const defectB = new Error('catchTags-throw')

      const tagDefect = ResultTask.ok(1)
        .andThen(() => ResultTask.err({ _tag: 'Boom' as const }))
        .catchTag('Boom', () => {
          throw defectA
        })
        .runSyncExit()
      expect(tagDefect).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: defectA } })

      const tagsDefect = ResultTask.ok(1)
        .andThen(() => ResultTask.err({ _tag: 'Boom' as const }))
        .catchTags({
          Boom: () => {
            throw defectB
          },
        })
        .runSyncExit()
      expect(tagsDefect).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: defectB } })

      // Non-tap failure continuations (like mapErr) must be bypassed on Success in runTaskLoop.
      expect(
        ResultTask.ok(1)
          .map((n) => n + 1)
          .mapErr(() => 'unused')
          .runSyncExit(),
      ).toEqual({ _tag: 'Success', value: 2 })

      // Recovering with a synchronous Result ok(...) must transition hasSuccess=true for subsequent map().
      const recoveredAll = ResultTask.err('fail')
        .orElse(() => ok(10))
        .map((n) => n + 5)
        .runSyncExit()
      expect(recoveredAll).toEqual({ _tag: 'Success', value: 15 })

      const recoveredTag = ResultTask.err({ _tag: 'Boom' as const })
        .catchTag('Boom', () => ok(20))
        .map((n) => n + 2)
        .runSyncExit()
      expect(recoveredTag).toEqual({ _tag: 'Success', value: 22 })
    })
  })
})
