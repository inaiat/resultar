import { deepEqual, equal, throws } from 'node:assert/strict'
import { describe, expectTypeOf, it, vi } from 'vite-plus/test'
import { Fiber, ResultTask } from '../src/task/result-task.js'
import type {
  Exit,
  Fiber as FiberHandle,
  ResultTaskScope,
  ResultTaskTryPromiseOptions,
} from '../src/task/result-task.js'
import { Clock } from '../src/task/task-clock.js'
import { err, ok } from '../src/result.js'

describe('ResultTask promise interruption', () => {
  it('preserves waiting for the function overload and explicit wait mode', async () => {
    for (const mode of ['function', 'wait'] as const) {
      const clock = Clock.virtual()
      const controller = new AbortController()
      const pending = Promise.withResolvers<number>()
      let mapped = 0
      let continued = 0
      let finished = false
      const task = (
        mode === 'function'
          ? ResultTask.tryPromise(() => pending.promise)
          : ResultTask.tryPromise({
              try: () => pending.promise,
              catch: () => {
                mapped += 1
                return 'mapped'
              },
              interruption: 'wait',
            })
      ).inspect(() => {
        continued += 1
      })
      const running = ResultTask.runExit(task, { clock, signal: controller.signal }).then(
        (exit) => {
          finished = true
          return exit
        },
      )
      await clock.flush()
      controller.abort('stop')
      await clock.flush()
      equal(finished, false)
      pending.reject(new Error('foreign rejection'))
      deepEqual(await running, { _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'stop' } })
      equal(mapped, 0)
      equal(continued, 0)
    }
  })

  it('detaches an unresolved promise without running catch or continuations', async () => {
    const clock = Clock.virtual()
    const controller = new AbortController()
    const pending = Promise.withResolvers<number>()
    let forwarded: AbortSignal | undefined = undefined
    let mapped = 0
    let continued = 0
    const task = ResultTask.tryPromise({
      try: (signal) => {
        forwarded = signal
        return pending.promise
      },
      catch: () => {
        mapped += 1
        return 'mapped'
      },
      interruption: 'detach',
    }).andThen(() =>
      ResultTask.sync(() => {
        continued += 1
      }),
    )
    const running = ResultTask.runExit(task, { clock, signal: controller.signal })
    await clock.flush()
    equal(forwarded, controller.signal)
    controller.abort('stop waiting')
    deepEqual(await running, {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'stop waiting' },
    })
    pending.reject(new Error('late rejection'))
    await clock.flush()
    equal(mapped, 0)
    equal(continued, 0)
    expectTypeOf(task).toEqualTypeOf<ResultTask<void, string>>()
  })

  it('ignores late success after detachment and handles synchronous abort plus rejection', async () => {
    const clock = Clock.virtual()
    const controller = new AbortController()
    const pending = Promise.withResolvers<number>()
    let continued = 0
    const running = ResultTask.runExit(
      ResultTask.tryPromise({
        try: () => pending.promise,
        catch: () => 'mapped',
        interruption: 'detach',
      }).inspect(() => {
        continued += 1
      }),
      { clock, signal: controller.signal },
    )
    await clock.flush()
    controller.abort('stop')
    await running
    pending.resolve(42)
    await clock.flush()
    equal(continued, 0)

    const synchronous = new AbortController()
    let mapped = 0
    const rejected = ResultTask.tryPromise({
      try: () => {
        synchronous.abort('synchronous abort')
        return Promise.reject(new Error('late'))
      },
      catch: () => {
        mapped += 1
        return 'mapped'
      },
      interruption: 'detach',
    })
    deepEqual(await ResultTask.runExit(rejected, { signal: synchronous.signal }), {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'synchronous abort' },
    })
    await clock.flush()
    equal(mapped, 0)
  })

  it('still maps rejection and factory throws, and preserves mapper defects', async () => {
    const external = new Error('external')
    deepEqual(
      await ResultTask.runResult(
        ResultTask.tryPromise({
          try: () => Promise.reject(external),
          catch: (error) => (error === external ? 'mapped' : 'unexpected'),
          interruption: 'detach',
        }),
      ),
      err('mapped'),
    )
    deepEqual(
      await ResultTask.runResult(
        ResultTask.tryPromise({
          try: (): Promise<number> => {
            throw external
          },
          catch: () => 'factory failure',
          interruption: 'detach',
        }),
      ),
      err('factory failure'),
    )
    const defect = new Error('mapper defect')
    deepEqual(
      await ResultTask.runExit(
        ResultTask.tryPromise({
          try: () => Promise.reject(external),
          catch: (): never => {
            throw defect
          },
          interruption: 'detach',
        }),
      ),
      { _tag: 'Failure', cause: { _tag: 'Die', defect } },
    )
  })

  it('adopts native promises safely even with an own then getter', async () => {
    const pending = Promise.withResolvers<number>()
    void Object.defineProperty(pending.promise, 'then', {
      get: () => {
        throw new Error('poisoned own then')
      },
    })
    const running = ResultTask.runResult(
      ResultTask.tryPromise({
        try: () => pending.promise,
        catch: () => 'mapped',
        interruption: 'detach',
      }),
    )
    pending.resolve(42)
    deepEqual(await running, ok(42))
  })

  it('removes its abort listener on success, failure and interruption', async () => {
    for (const outcome of ['success', 'failure', 'interrupt'] as const) {
      const clock = Clock.virtual()
      const controller = new AbortController()
      const pending = Promise.withResolvers<number>()
      const added = vi.spyOn(controller.signal, 'addEventListener')
      const removed = vi.spyOn(controller.signal, 'removeEventListener')
      try {
        const running = ResultTask.runExit(
          ResultTask.tryPromise({
            try: () => pending.promise,
            catch: () => 'mapped',
            interruption: 'detach',
          }),
          { clock, signal: controller.signal },
        )
        await clock.flush()
        if (outcome === 'success') pending.resolve(42)
        else if (outcome === 'failure') pending.reject(new Error('rejected'))
        else controller.abort('stop')
        await running
        equal(added.mock.calls.length, 1)
        equal(removed.mock.calls.length, 1)
        equal(removed.mock.calls[0]?.[1], added.mock.calls[0]?.[1])
      } finally {
        added.mockRestore()
        removed.mockRestore()
      }
    }
  })

  it('preserves registered finalizers and cleanup failures after detached interruption', async () => {
    const clock = Clock.virtual()
    const controller = new AbortController()
    const pending = Promise.withResolvers<number>()
    let releases = 0
    const task = ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.ok('resource'),
        release: () =>
          ResultTask.tryPromise({
            try: async (signal) => {
              equal(signal.aborted, false)
              releases += 1
            },
            catch: () => 'unexpected',
          }).andThen(() => ResultTask.err('cleanup')),
      })
      return yield* ResultTask.tryPromise({
        try: () => pending.promise,
        catch: () => 'body',
        interruption: 'detach',
      })
    })
    const running = ResultTask.runExit(task, { clock, signal: controller.signal })
    await clock.flush()
    controller.abort('stop')
    deepEqual(await running, {
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Interrupt', reason: 'stop' },
        right: { _tag: 'Fail', error: 'cleanup' },
      },
    })
    equal(releases, 1)
  })

  it('timeouts detach foreign waits and await owned cleanup', async () => {
    const clock = Clock.virtual()
    const pending = Promise.withResolvers<number>()
    let released = false
    let finished = false
    const task = ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.ok('resource'),
        release: () =>
          ResultTask.sleep(10).andThen(() =>
            ResultTask.sync(() => {
              released = true
            }),
          ),
      })
      return yield* ResultTask.tryPromise({
        try: () => pending.promise,
        catch: () => 'body',
        interruption: 'detach',
      })
    }).timeout(1, () => 'timeout')
    const running = ResultTask.runResult(task, { clock }).then((result) => {
      finished = true
      return result
    })
    await clock.advanceBy(1)
    equal(finished, false)
    await clock.advanceBy(10)
    deepEqual(await running, err('timeout'))
    equal(released, true)
    equal(clock.pending, 0)
  })

  it('rejects invalid JavaScript literals when constructing the task', () => {
    const create = (options: ResultTaskTryPromiseOptions<number, string>) =>
      ResultTask.tryPromise(options)
    for (const interruption of [null, false, 'invalid', 0])
      throws(
        () =>
          Reflect.apply(create, undefined, [
            { try: async () => 1, catch: () => 'mapped', interruption },
          ]),
        TypeError,
      )
    if (false)
      void ResultTask.tryPromise({
        try: async () => 1,
        catch: () => 'mapped',
        // @ts-expect-error Interruption mode is a closed set of literals.
        interruption: 'invalid',
      })
  })
})

describe('Fiber.await', () => {
  it('observes success after child finalization without interrupting it', async () => {
    const clock = Clock.virtual()
    let released = false
    const child = ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.ok(42),
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
    const parent = ResultTask.gen(function* () {
      const fiber = yield* ResultTask.forkChild(child)
      return yield* Fiber.await(fiber)
    })
    const running = ResultTask.runResult(parent, { clock })
    await clock.advanceBy(3)
    deepEqual(await running, ok({ _tag: 'Success', value: 42 }))
    equal(released, true)
  })

  it('captures failures, defects, interruption and composite cleanup without duplication', async () => {
    const defect = new Error('defect')
    const cases: readonly [
      ResultTask<unknown, string, ResultTaskScope<string>>,
      Exit<unknown, string>,
    ][] = [
      [ResultTask.err('child'), { _tag: 'Failure', cause: { _tag: 'Fail', error: 'child' } }],
      [
        ResultTask.sync(() => {
          throw defect
        }),
        { _tag: 'Failure', cause: { _tag: 'Die', defect } },
      ],
      [
        ResultTask.gen(function* () {
          yield* ResultTask.acquireRelease({
            acquire: ResultTask.ok('resource'),
            release: () => ResultTask.err('cleanup'),
          })
          return yield* ResultTask.err('body')
        }),
        {
          _tag: 'Failure',
          cause: {
            _tag: 'Sequential',
            left: { _tag: 'Fail', error: 'body' },
            right: { _tag: 'Fail', error: 'cleanup' },
          },
        },
      ],
    ]
    for (const [child, expected] of cases) {
      const parent = ResultTask.gen(function* () {
        const fiber = yield* ResultTask.forkChild(child)
        return yield* Fiber.await(fiber)
      })
      deepEqual(await ResultTask.runResult(parent), ok(expected))
    }
    const clock = Clock.virtual()
    const interrupted = ResultTask.gen(function* () {
      const fiber = yield* ResultTask.forkChild(ResultTask.sleep(100))
      yield* Fiber.interrupt(fiber, 'child stopped')
      return yield* Fiber.await(fiber)
    })
    deepEqual(
      await ResultTask.runResult(interrupted, { clock }),
      ok({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'child stopped' } }),
    )
  })

  it('does not observe a child merely by constructing the await task', async () => {
    const clock = Clock.virtual()
    const owner = ResultTask.makeScope()
    const fiber = await ResultTask.runPromise(
      owner.use(ResultTask.forkChild(ResultTask.sleep(1).andThen(() => ResultTask.err('child')))),
      { clock },
    )
    const awaiting = Fiber.await(fiber)
    expectTypeOf(awaiting).toEqualTypeOf<ResultTask<Exit<never, 'child'>>>()
    await clock.advanceBy(1)
    deepEqual(await ResultTask.runExit(owner.close()), {
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'child' },
    })
    void awaiting
  })

  it('cancels the waiter without canceling or observing a still-running child', async () => {
    const clock = Clock.virtual()
    const owner = ResultTask.makeScope()
    const controller = new AbortController()
    const fiber = await ResultTask.runPromise(
      owner.use(ResultTask.forkChild(ResultTask.sleep(2).andThen(() => ResultTask.err('child')))),
      { clock },
    )
    const waiting = ResultTask.runExit(Fiber.await(fiber), { clock, signal: controller.signal })
    await clock.flush()
    controller.abort('waiter stopped')
    deepEqual(await waiting, {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'waiter stopped' },
    })
    equal(clock.pending, 1)
    await clock.advanceBy(2)
    deepEqual(await ResultTask.runExit(owner.close()), {
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'child' },
    })
  })

  it('supports structural handles and invokes their join lazily in the same runtime', async () => {
    const clock = Clock.virtual(50)
    let joined = 0
    const fiber: FiberHandle<number, 'fake'> = {
      join: () => {
        joined += 1
        return ResultTask.sleep(2).andThen(() => ResultTask.now())
      },
      interrupt: () => ResultTask.ok({ _tag: 'Success', value: 0 }),
    }
    const task = Fiber.await(fiber)
    expectTypeOf(task).toEqualTypeOf<ResultTask<Exit<number, 'fake'>>>()
    equal(joined, 0)
    const running = ResultTask.runResult(task, { clock })
    await clock.advanceBy(2)
    deepEqual(await running, ok({ _tag: 'Success', value: 52 }))
    equal(joined, 1)

    const defect = new Error('join threw')
    const broken: FiberHandle<number> = {
      join: () => {
        throw defect
      },
      interrupt: () => ResultTask.ok({ _tag: 'Success', value: 0 }),
    }
    deepEqual(
      await ResultTask.runResult(Fiber.await(broken)),
      ok({ _tag: 'Failure', cause: { _tag: 'Die', defect } }),
    )
  })
})
