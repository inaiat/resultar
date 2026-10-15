import { deepEqual, equal, throws } from 'node:assert/strict'
import { describe, expectTypeOf, it } from 'vite-plus/test'

import { Fiber } from '../src/task/fiber.js'
import type { Fiber as StructuralFiber, FiberHandle, FiberJoinOptions } from '../src/task/fiber.js'
import { ResultTask } from '../src/task/result-task.js'
import type { Exit } from '../src/task/result-task.js'
import { Clock } from '../src/task/task-clock.js'

describe('native fiber diagnostics', () => {
  it('assigns unique IDs and publishes the exit only after finalization', async () => {
    const clock = Clock.virtual()
    const owner = ResultTask.makeScope()
    let released = false
    const child = ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.ok('resource'),
        release: () =>
          ResultTask.sleep(2).andThen(() =>
            ResultTask.sync(() => {
              released = true
            }),
          ),
      })
      yield* ResultTask.sleep(1)
      return 42
    })
    const fiber = await ResultTask.runPromise(owner.use(ResultTask.forkChild(child)), { clock })
    const second = await ResultTask.runPromise(
      owner.use(ResultTask.forkChild(ResultTask.ok('second'))),
      { clock },
    )
    expectTypeOf(fiber).toEqualTypeOf<FiberHandle<number, never>>()
    expectTypeOf(Fiber.poll(fiber)).toEqualTypeOf<Exit<number, never> | undefined>()
    equal(Number.isSafeInteger(fiber.id), true)
    equal(fiber.id > 0, true)
    equal(fiber.id === second.id, false)
    equal(fiber.poll(), undefined)
    const exits: Exit<number, never>[] = []
    Fiber.addObserver(fiber, (exit) => {
      equal(released, true)
      exits.push(exit)
    })
    await clock.advanceBy(1)
    equal(Fiber.poll(fiber), undefined)
    deepEqual(exits, [])
    await clock.advanceBy(2)
    deepEqual(Fiber.poll(fiber), { _tag: 'Success', value: 42 })
    deepEqual(exits, [{ _tag: 'Success', value: 42 }])
    deepEqual(await ResultTask.runExit(owner.close()), { _tag: 'Success', value: undefined })
  })

  it('supports removing and late observers while isolating observer failures', async () => {
    const clock = Clock.virtual()
    const owner = ResultTask.makeScope()
    const fiber = await ResultTask.runPromise(
      owner.use(ResultTask.forkChild(ResultTask.sleep(1).as(42))),
      { clock },
    )
    const events: string[] = []
    const removed = fiber.addObserver(() => events.push('removed'))
    removed()
    removed()
    fiber.addObserver(() => {
      events.push('throw')
      throw new Error('observer defect')
    })
    fiber.addObserver(async () => {
      events.push('reject')
      throw new Error('observer rejection')
    })
    fiber.addObserver(() => ResultTask.sync(() => events.push('returned task')))
    const observer = (): void => {
      events.push('same callback')
    }
    fiber.addObserver(observer)
    fiber.addObserver(observer)
    await clock.advanceBy(1)
    fiber.addObserver(() => events.push('late'))
    deepEqual(events, ['throw', 'reject', 'same callback', 'same callback', 'late'])
    deepEqual(await ResultTask.runExit(Fiber.join(fiber)), { _tag: 'Success', value: 42 })
    await ResultTask.runPromise(owner.close())
  })

  it('does not consume an owned failure by polling or registering observers', async () => {
    const clock = Clock.virtual()
    const owner = ResultTask.makeScope()
    const fiber = await ResultTask.runPromise(
      owner.use(ResultTask.forkChild(ResultTask.sleep(1).andThen(() => ResultTask.err('child')))),
      { clock },
    )
    const exits: Exit<never, 'child'>[] = []
    const remove = Fiber.addObserver(fiber, (exit) => exits.push(exit))
    await clock.advanceBy(1)
    deepEqual(Fiber.poll(fiber), { _tag: 'Failure', cause: { _tag: 'Fail', error: 'child' } })
    remove()
    deepEqual(exits, [{ _tag: 'Failure', cause: { _tag: 'Fail', error: 'child' } }])
    deepEqual(await ResultTask.runExit(owner.close()), {
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'child' },
    })
  })
})

describe('Fiber.join interruption', () => {
  it('preserves default and explicit wait behavior without interrupting the target', async () => {
    for (const options of [undefined, { interruption: 'wait' }] as const) {
      const clock = Clock.virtual()
      const owner = ResultTask.makeScope()
      const controller = new AbortController()
      const fiber = await ResultTask.runPromise(
        owner.use(ResultTask.forkChild(ResultTask.sleep(2).as(42))),
        { clock },
      )
      let finished = false
      const waiting = ResultTask.runExit(Fiber.join(fiber, options), {
        clock,
        signal: controller.signal,
      }).then((exit) => {
        finished = true
        return exit
      })
      await clock.flush()
      controller.abort('waiter stopped')
      await clock.flush()
      equal(finished, false)
      equal(clock.pending, 1)
      await clock.advanceBy(2)
      deepEqual(await waiting, {
        _tag: 'Failure',
        cause: { _tag: 'Interrupt', reason: 'waiter stopped' },
      })
      deepEqual(fiber.poll(), { _tag: 'Success', value: 42 })
      await ResultTask.runPromise(owner.close())
    }
  })

  it('detaches only the waiter and preserves unobserved child failure for its owner', async () => {
    const clock = Clock.virtual()
    const owner = ResultTask.makeScope()
    const controller = new AbortController()
    const fiber = await ResultTask.runPromise(
      owner.use(ResultTask.forkChild(ResultTask.sleep(2).andThen(() => ResultTask.err('child')))),
      { clock },
    )
    const joined = fiber.join({ interruption: 'detach' })
    expectTypeOf(joined).toEqualTypeOf<ResultTask<never, 'child'>>()
    const waiting = ResultTask.runExit(joined, { clock, signal: controller.signal })
    await clock.flush()
    controller.abort('waiter stopped')
    deepEqual(await waiting, {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'waiter stopped' },
    })
    equal(clock.pending, 1)
    equal(fiber.poll(), undefined)
    await clock.advanceBy(2)
    deepEqual(await ResultTask.runExit(owner.close()), {
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'child' },
    })
  })

  it('observes a delivered failure in detach mode after all child cleanup', async () => {
    const clock = Clock.virtual()
    const owner = ResultTask.makeScope()
    let released = false
    const child = ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.ok('resource'),
        release: () =>
          ResultTask.sleep(1).andThen(() =>
            ResultTask.sync(() => {
              released = true
            }),
          ),
      })
      return yield* ResultTask.err('child')
    })
    const fiber = await ResultTask.runPromise(owner.use(ResultTask.forkChild(child)), { clock })
    const waiting = ResultTask.runExit(Fiber.join(fiber, { interruption: 'detach' }), { clock })
    await clock.advanceBy(1)
    deepEqual(await waiting, { _tag: 'Failure', cause: { _tag: 'Fail', error: 'child' } })
    equal(released, true)
    deepEqual(await ResultTask.runExit(owner.close()), { _tag: 'Success', value: undefined })
  })

  it('leaves a failure owned when interruption wins at the delivery boundary', async () => {
    const clock = Clock.virtual()
    const owner = ResultTask.makeScope()
    const controller = new AbortController()
    const fiber = await ResultTask.runPromise(
      owner.use(ResultTask.forkChild(ResultTask.sleep(1).andThen(() => ResultTask.err('child')))),
      { clock },
    )
    fiber.addObserver(() => {
      controller.abort('delivery canceled')
    })
    const waiting = ResultTask.runExit(Fiber.join(fiber, { interruption: 'detach' }), {
      clock,
      signal: controller.signal,
    })
    await clock.advanceBy(1)
    deepEqual(await waiting, {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'delivery canceled' },
    })
    deepEqual(await ResultTask.runExit(owner.close()), {
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'child' },
    })
  })

  it('runs the detached waiter finalizers without interrupting its target', async () => {
    const clock = Clock.virtual()
    const owner = ResultTask.makeScope()
    const controller = new AbortController()
    const fiber = await ResultTask.runPromise(
      owner.use(ResultTask.forkChild(ResultTask.sleep(2).as(42))),
      { clock },
    )
    let released = 0
    const waiter = ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.ok('waiter resource'),
        release: () =>
          ResultTask.sync(() => {
            released += 1
          }).andThen(() => ResultTask.err('waiter cleanup')),
      })
      return yield* Fiber.join(fiber, { interruption: 'detach' })
    })
    const waiting = ResultTask.runExit(waiter, { clock, signal: controller.signal })
    await clock.flush()
    controller.abort('waiter stopped')
    deepEqual(await waiting, {
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Interrupt', reason: 'waiter stopped' },
        right: { _tag: 'Fail', error: 'waiter cleanup' },
      },
    })
    equal(released, 1)
    equal(clock.pending, 1)
    await clock.advanceBy(2)
    deepEqual(fiber.poll(), { _tag: 'Success', value: 42 })
    await ResultTask.runPromise(owner.close())
  })

  it('keeps the existing target failure when a waiting join is interrupted', async () => {
    const clock = Clock.virtual()
    const owner = ResultTask.makeScope()
    const controller = new AbortController()
    const fiber = await ResultTask.runPromise(
      owner.use(ResultTask.forkChild(ResultTask.sleep(1).andThen(() => ResultTask.err('child')))),
      { clock },
    )
    const waiting = ResultTask.runExit(Fiber.join(fiber), { clock, signal: controller.signal })
    await clock.flush()
    controller.abort('waiter stopped')
    await clock.advanceBy(1)
    deepEqual(await waiting, { _tag: 'Failure', cause: { _tag: 'Fail', error: 'child' } })
    deepEqual(await ResultTask.runExit(owner.close()), { _tag: 'Success', value: undefined })
  })

  it('preserves structural handles and executes detached fallback in the waiter runtime', async () => {
    const clock = Clock.virtual(20)
    const controller = new AbortController()
    let joins = 0
    const fiber: StructuralFiber<number, 'failure'> = {
      join: () => {
        joins += 1
        return ResultTask.sleep(2).andThen(() => ResultTask.now())
      },
      interrupt: () => ResultTask.ok({ _tag: 'Success', value: 0 }),
    }
    const defaultJoin = Fiber.join(fiber)
    equal(joins, 1)
    const defaultRunning = ResultTask.runPromise(defaultJoin, { clock })
    await clock.advanceBy(2)
    equal(await defaultRunning, 22)
    const detached = Fiber.join(fiber, { interruption: 'detach' })
    equal(joins, 1)
    const running = ResultTask.runExit(detached, { clock, signal: controller.signal })
    await clock.flush()
    equal(joins, 2)
    controller.abort('fallback stopped')
    deepEqual(await running, {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'fallback stopped' },
    })
    equal(clock.pending, 0)
    expectTypeOf(defaultJoin).toEqualTypeOf<ResultTask<number, 'failure'>>()
  })

  it('rejects invalid interruption options before constructing a join task', async () => {
    const owner = ResultTask.makeScope()
    const fiber = await ResultTask.runPromise(owner.use(ResultTask.forkChild(ResultTask.ok(1))))
    const join = (options: FiberJoinOptions): ResultTask<number> => Fiber.join(fiber, options)
    for (const interruption of [null, false, 'invalid', 0])
      throws(() => Reflect.apply(join, undefined, [{ interruption }]), TypeError)
    for (const options of [null, false, 'detach'])
      throws(() => Reflect.apply(join, undefined, [options]), TypeError)
    if (false) {
      // @ts-expect-error Interruption mode is a closed set of literals.
      void fiber.join({ interruption: 'invalid' })
      // @ts-expect-error Diagnostics require a native handle, not a structural join-only handle.
      void Fiber.poll({ join: () => ResultTask.ok(1), interrupt: fiber.interrupt })
    }
    await ResultTask.runPromise(owner.close())
  })
})
