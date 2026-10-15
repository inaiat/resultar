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
})
