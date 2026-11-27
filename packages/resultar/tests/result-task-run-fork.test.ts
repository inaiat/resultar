import { deepEqual, equal, ok as assertOk } from 'node:assert/strict'
import { describe, expectTypeOf, it, vi } from 'vite-plus/test'
import { Cause, Clock, Fiber, ResultTask } from '../src/index.js'
import type { Exit, FiberHandle, ResultTaskScope } from '../src/index.js'

describe('ResultTask.runFork', () => {
  it('starts a root execution and publishes its exit only after resource cleanup', async () => {
    const clock = Clock.virtual()
    const events: string[] = []
    const fiber = ResultTask.runFork(
      ResultTask.gen(function* () {
        yield* ResultTask.acquireRelease({
          acquire: ResultTask.sync(() => events.push('acquire')),
          release: () => ResultTask.sleep(2).inspect(() => events.push('release')),
        })
        yield* ResultTask.sleep(3)
        return 'ready'
      }),
      { clock },
    )
    const observed: Exit<string, never>[] = []
    const remove = Fiber.addObserver(fiber, (exit) => observed.push(exit))
    equal(Fiber.poll(fiber), undefined)
    await clock.advanceBy(3)
    deepEqual(events, ['acquire'])
    equal(fiber.poll(), undefined)
    deepEqual(observed, [])
    await clock.advanceBy(2)
    deepEqual(await ResultTask.runPromise(Fiber.await(fiber)), { _tag: 'Success', value: 'ready' })
    deepEqual(events, ['acquire', 'release'])
    deepEqual(observed, [{ _tag: 'Success', value: 'ready' }])
    deepEqual(Fiber.poll(fiber), { _tag: 'Success', value: 'ready' })
    remove()
    expectTypeOf(fiber).toEqualTypeOf<FiberHandle<string, never>>()
  })

  it('interruption closes owned children before releasing parent resources', async () => {
    const clock = Clock.virtual()
    const events: string[] = []
    const child = ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.ok('child'),
        release: () => ResultTask.sleep(2).inspect(() => events.push('child release')),
      })
      yield* ResultTask.sleep(100)
    })
    const fiber = ResultTask.runFork(
      ResultTask.gen(function* () {
        yield* ResultTask.acquireRelease({
          acquire: ResultTask.ok('parent'),
          release: () => ResultTask.sync(() => events.push('parent release')).as(undefined),
        })
        yield* ResultTask.forkChild(child)
        yield* ResultTask.sleep(100)
      }),
      { clock },
    )
    await clock.flush()
    const interrupted = ResultTask.runPromise(Fiber.interrupt(fiber, 'shutdown'))
    await clock.flush()
    equal(fiber.poll(), undefined)
    await clock.advanceBy(2)
    deepEqual(await interrupted, {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'shutdown' },
    })
    deepEqual(events, ['child release', 'parent release'])
    equal(clock.pending, 0)
  })

  it('forwards external cancellation once and removes its listener on completion', async () => {
    for (const abort of [false, true]) {
      const clock = Clock.virtual()
      const controller = new AbortController()
      const added = vi.spyOn(controller.signal, 'addEventListener')
      const removed = vi.spyOn(controller.signal, 'removeEventListener')
      try {
        const fiber = ResultTask.runFork(ResultTask.sleep(1).as(42), {
          clock,
          signal: controller.signal,
        })
        await clock.flush()
        if (abort) controller.abort('external cancellation')
        else await clock.advanceBy(1)
        const exit = await ResultTask.runPromise(Fiber.await(fiber))
        deepEqual(
          exit,
          abort
            ? { _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'external cancellation' } }
            : { _tag: 'Success', value: 42 },
        )
        equal(added.mock.calls.length, 1)
        equal(removed.mock.calls.length, 1)
        equal(added.mock.calls[0]?.[1], removed.mock.calls[0]?.[1])
      } finally {
        added.mockRestore()
        removed.mockRestore()
      }
    }
  })

  it('does not execute pre-aborted runs and retains configuration defects as exits', async () => {
    let executed = 0
    const controller = new AbortController()
    controller.abort('already canceled')
    const fiber = ResultTask.runFork(
      ResultTask.sync(() => {
        executed += 1
      }),
      { signal: controller.signal },
    )
    deepEqual(await ResultTask.runPromise(Fiber.await(fiber)), {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'already canceled' },
    })
    equal(executed, 0)
    const invalid = ResultTask.runFork(ResultTask.ok(1), { yieldEvery: 0 })
    const exit = await ResultTask.runPromise(Fiber.await(invalid))
    assertOk(exit._tag === 'Failure')
    equal(Cause.hasDies(exit.cause), true)
  })

  it('keeps requirements and deferred release failures in the handle type', async () => {
    const Config = ResultTask.service<{ readonly value: number }>()('config')
    const workflow = ResultTask.gen(function* () {
      const config = yield* Config
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.ok(config.value),
        release: () => ResultTask.err('release failed' as const),
      })
      return config.value
    })
    expectTypeOf(workflow).toEqualTypeOf<
      ResultTask<number, never, typeof Config | ResultTaskScope<'release failed'>>
    >()
    const fiber = ResultTask.runFork(workflow, { services: { config: { value: 42 } } })
    expectTypeOf(fiber).toEqualTypeOf<FiberHandle<number, 'release failed'>>()
    deepEqual(await ResultTask.runPromise(Fiber.await(fiber)), {
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'release failed' },
    })
    if (false) {
      // @ts-expect-error Required services cannot be omitted at root execution.
      void ResultTask.runFork(workflow)
      // @ts-expect-error Service values must match their declared contracts.
      void ResultTask.runFork(workflow, { services: { config: { value: 'wrong' } } })
      // @ts-expect-error Run options cannot widen the task's declared service requirement.
      void ResultTask.runExit(workflow, { services: { config: { value: 'wrong' } } })
      // @ts-expect-error Simplified Result execution preserves the same requirement contract.
      void ResultTask.runResult(workflow, { services: { config: { value: 'wrong' } } })
      // @ts-expect-error Promise execution preserves the same requirement contract.
      void ResultTask.runPromise(workflow, { services: { config: { value: 'wrong' } } })
      // @ts-expect-error A requirement-free task does not accept unrelated services.
      void ResultTask.runFork(ResultTask.ok(1), { services: { config: { value: 1 } } })
    }
  })

  it('captures option getters once and does not leak listeners when configuration fails', async () => {
    const controller = new AbortController()
    const added = vi.spyOn(controller.signal, 'addEventListener')
    const removed = vi.spyOn(controller.signal, 'removeEventListener')
    const defect = new Error('clock getter failed')
    let signalReads = 0
    try {
      const failed = ResultTask.runFork(ResultTask.ok(1), {
        signal: controller.signal,
        get clock(): never {
          throw defect
        },
      })
      deepEqual(await ResultTask.runPromise(Fiber.await(failed)), {
        _tag: 'Failure',
        cause: { _tag: 'Die', defect },
      })
      equal(added.mock.calls.length, 0)
      const fiber = ResultTask.runFork(ResultTask.ok(42), {
        get signal() {
          signalReads += 1
          return controller.signal
        },
      })
      equal(await ResultTask.runPromise(Fiber.join(fiber)), 42)
      equal(signalReads, 1)
      equal(added.mock.calls.length, 1)
      equal(removed.mock.calls.length, 1)
    } finally {
      added.mockRestore()
      removed.mockRestore()
    }
  })

  it('runs the same task independently and delivers defects through the full exit', async () => {
    let executions = 0
    const task = ResultTask.sync(() => {
      executions += 1
      return executions
    })
    const first = ResultTask.runFork(task)
    const second = ResultTask.runFork(task)
    assertOk(first.id !== second.id)
    equal(await ResultTask.runPromise(Fiber.join(first)), 1)
    equal(await ResultTask.runPromise(Fiber.join(second)), 2)
    const defect = new Error('broken callback')
    const broken = ResultTask.runFork(
      ResultTask.sync(() => {
        throw defect
      }),
    )
    deepEqual(await ResultTask.runPromise(Fiber.await(broken)), {
      _tag: 'Failure',
      cause: { _tag: 'Die', defect },
    })
  })

  it('supports pooled runFork with tryPromise, inspectCause, interruption, and async cleanup', async () => {
    const observed: Cause<string>[] = []

    const okFiber = ResultTask.tryPromise({
      try: () => Promise.resolve(21),
      catch: () => 'unexpected',
    })
      .map((value) => value * 2)
      .inspectCause((cause) => observed.push(cause))
      .runFork()
    equal(await Fiber.join(okFiber).runPromise(), 42)
    equal(observed.length, 0)

    const failFiber = ResultTask.tryPromise<number, string>({
      try: () => Promise.reject(new Error('boom')),
      catch: () => 'mapped-error',
    })
      .asVoid()
      .inspectCause((cause) => observed.push(cause))
      .runFork()
    deepEqual(await Fiber.await(failFiber).runPromise(), {
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'mapped-error' },
    })
    deepEqual(observed, [{ _tag: 'Fail', error: 'mapped-error' }])

    const defect = new Error('map-defect')
    const defectObserved: Cause<string>[] = []
    const defectFiber = ResultTask.tryPromise<number, string>({
      try: () => Promise.resolve(1),
      catch: () => 'unused',
    })
      .map(() => {
        throw defect
      })
      .inspectCause((cause) => defectObserved.push(cause))
      .runFork()
    deepEqual(await Fiber.await(defectFiber).runPromise(), {
      _tag: 'Failure',
      cause: { _tag: 'Die', defect },
    })
    deepEqual(defectObserved, [{ _tag: 'Die', defect }])

    const deferred = Promise.withResolvers<number>()
    const receivedSignals: AbortSignal[] = []
    const interruptObserved: Cause<string>[] = []
    const interruptedFiber = ResultTask.tryPromise<number, string>({
      try: (signal) => {
        receivedSignals.push(signal)
        return deferred.promise
      },
      catch: () => 'unused',
    })
      .inspectCause((cause) => interruptObserved.push(cause))
      .runFork()
    const interruptExitPromise = Fiber.interrupt(interruptedFiber, 'stop-now').runPromise()
    equal(receivedSignals[0]?.aborted, true)
    deferred.resolve(99)
    deepEqual(await interruptExitPromise, {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'stop-now' },
    })
    deepEqual(interruptObserved, [{ _tag: 'Interrupt', reason: 'stop-now' }])

    const releaseDeferred = Promise.withResolvers<void>()
    let released = false
    const syncAcquireAsyncRelease = ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.ok('res'),
        release: () =>
          ResultTask.fromPromise(() =>
            releaseDeferred.promise.then(() => {
              released = true
            }),
          ),
      })
      return 'done'
    }).runFork()
    equal(syncAcquireAsyncRelease.poll(), undefined)
    releaseDeferred.resolve()
    deepEqual(await Fiber.await(syncAcquireAsyncRelease).runPromise(), {
      _tag: 'Success',
      value: 'done',
    })
    equal(released, true)
  })

  it('removes external abort listeners across sync/async scoped releases and config errors, and preserves inspectCause exits', async () => {
    // 1. Config error (invalid yieldEvery) still disposes the attached external signal listener.
    {
      const controller = new AbortController()
      const added = vi.spyOn(controller.signal, 'addEventListener')
      const removed = vi.spyOn(controller.signal, 'removeEventListener')
      try {
        const invalid = ResultTask.runFork(ResultTask.ok(1), {
          signal: controller.signal,
          yieldEvery: 0,
        })
        const exit = await Fiber.await(invalid).runPromise()
        assertOk(exit._tag === 'Failure')
        equal(added.mock.calls.length, 1)
        equal(removed.mock.calls.length, 1)
      } finally {
        added.mockRestore()
        removed.mockRestore()
      }
    }

    // 2. Sync & async bodies with sync & async releases all dispose their external signal listener.
    for (const asyncBody of [false, true]) {
      for (const asyncRelease of [false, true]) {
        const controller = new AbortController()
        const added = vi.spyOn(controller.signal, 'addEventListener')
        const removed = vi.spyOn(controller.signal, 'removeEventListener')
        const releaseGate = Promise.withResolvers<void>()
        try {
          const task = ResultTask.gen(function* () {
            yield* ResultTask.acquireRelease({
              acquire: ResultTask.ok('r'),
              release: () =>
                asyncRelease
                  ? ResultTask.fromPromise(() => releaseGate.promise)
                  : ResultTask.ok(undefined),
            })
            if (asyncBody) {
              return yield* ResultTask.fromPromise(() => Promise.resolve('async-body'))
            }
            return 'sync-body'
          })
          const fiber = task.runFork({ signal: controller.signal })
          if (asyncRelease) {
            equal(fiber.poll(), undefined)
            releaseGate.resolve()
          }
          deepEqual(await Fiber.await(fiber).runPromise(), {
            _tag: 'Success',
            value: asyncBody ? 'async-body' : 'sync-body',
          })
          equal(added.mock.calls.length, 1)
          equal(removed.mock.calls.length, 1)
        } finally {
          added.mockRestore()
          removed.mockRestore()
        }
      }
    }

    // 3. inspectCause stays synchronous for sync observers and unexecuted ResultTask returns,
    //    and preserves the failure exit when an async observer rejects.
    const seenSync: Cause<string>[] = []
    deepEqual(
      ResultTask.err('sync-err')
        .inspectCause((cause) => {
          seenSync.push(cause)
        })
        .runSyncExit(),
      { _tag: 'Failure', cause: { _tag: 'Fail', error: 'sync-err' } },
    )
    deepEqual(seenSync, [{ _tag: 'Fail', error: 'sync-err' }])

    deepEqual(
      ResultTask.err('task-ret')
        .inspectCause(() => ResultTask.ok('ignored-task'))
        .runSyncExit(),
      { _tag: 'Failure', cause: { _tag: 'Fail', error: 'task-ret' } },
    )

    deepEqual(
      await ResultTask.err('reject-obs')
        .inspectCause(() => Promise.reject(new Error('observer rejection')))
        .runExit(),
      { _tag: 'Failure', cause: { _tag: 'Fail', error: 'reject-obs' } },
    )
  })
})
