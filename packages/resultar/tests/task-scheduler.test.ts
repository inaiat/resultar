import { deepEqual, equal, rejects, strictEqual } from 'node:assert'
import { describe, expectTypeOf, it } from 'vite-plus/test'
import { Clock, type Exit, Fiber, ResultTask, Scheduler, type TaskScheduler } from '../src/index.js'

const mapped = (count: number): ResultTask<number> => {
  let task = ResultTask.ok(0)
  for (let index = 0; index < count; index += 1) task = task.map((value) => value + 1)
  return task
}

describe('cooperative task scheduling', () => {
  it('lets event-loop peers run before a long map chain completes', async () => {
    let finished = false
    let peerBeforeCompletion = false
    const peer = new Promise<void>((resolve) => {
      setImmediate(() => {
        peerBeforeCompletion = !finished
        resolve()
      })
    })
    const running = ResultTask.runPromise(mapped(10_000)).then((value) => {
      finished = true
      return value
    })

    const [value] = await Promise.all([running, peer])
    equal(value, 10_000)
    equal(peerBeforeCompletion, true)
  })

  it('preserves cooperative scheduling across long resolved tryPromise + andThen chains in runResult() with and without options', async () => {
    for (const mode of ['no-options', 'empty-options', 'wrapped-map'] as const) {
      let lastStepRan = false
      let peerRanBeforeLastStep = false
      const nextStep = (current: number): ResultTask<number, never> => {
        if (current >= 6000) {
          lastStepRan = true
          return ResultTask.ok(current)
        }
        const chained = ResultTask.tryPromise({
          try: () => Promise.resolve(current + 1),
          catch: () => 'never' as never,
        }).andThen(nextStep)
        return mode === 'wrapped-map' ? chained.map((value) => value) : chained
      }
      const task = nextStep(0)
      const peer = new Promise<void>((resolve) => {
        setImmediate(() => {
          peerRanBeforeLastStep = !lastStepRan
          resolve()
        })
      })
      const running = mode === 'empty-options' ? task.runResult({}) : task.runResult()
      const [result] = await Promise.all([running, peer])
      equal(result.isOk(), true)
      if (result.isOk()) equal(result.value, 6000)
      equal(peerRanBeforeLastStep, true)
    }
  })

  it('lets a live timeout interrupt runnable work and finish cleanup', async () => {
    let steps = 0
    let released = 0
    const spin: ResultTask<void> = ResultTask.sync(() => {
      steps += 1
    }).andThen(() => spin)
    const program = ResultTask.scoped(
      ResultTask.gen(function* () {
        yield* ResultTask.acquireRelease({
          acquire: ResultTask.ok('resource'),
          release: () =>
            ResultTask.sync(() => {
              released += 1
            }),
        })
        return yield* spin
      }),
    ).timeout(5, () => 'deadline' as const)

    const result = await ResultTask.runResult(program)
    equal(result.isErr(), true)
    if (result.isErr()) equal(result.error, 'deadline')
    equal(steps > 0, true)
    equal(released, 1)
  })

  it('shares the operation budget across nested generator task executions', async () => {
    let finished = false
    let peerBeforeCompletion = false
    const peer = new Promise<void>((resolve) => {
      setImmediate(() => {
        peerBeforeCompletion = !finished
        resolve()
      })
    })
    const program = ResultTask.gen(function* () {
      let value = 0
      for (let index = 0; index < 10_000; index += 1) {
        value = yield* ResultTask.ok(value + 1)
      }
      return value
    })
    const running = ResultTask.runPromise(program).then((value) => {
      finished = true
      return value
    })

    const [value] = await Promise.all([running, peer])
    equal(value, 10_000)
    equal(peerBeforeCompletion, true)
  })

  it('drains default scheduling before virtual time moves and isolates unrelated clocks', async () => {
    const clock = Clock.virtual()
    const running = ResultTask.runPromise(
      mapped(10_000).andThen(() => ResultTask.sleep(10)),
      { clock },
    )
    await clock.advanceBy(10)
    await running
    equal(clock.pending, 0)
    equal(clock.now(), 10)
    const unrelatedClock = Clock.virtual()
    let finished = false
    const unrelated = ResultTask.runPromise(mapped(10_000)).then(() => {
      finished = true
    })
    await unrelatedClock.flush()
    equal(finished, false)
    await unrelated
  })

  it('lets virtual time drive an explicitly injected scheduler', async () => {
    const clock = Clock.virtual()
    const scheduler: TaskScheduler = { yield: (signal) => clock.sleep(1, signal) }
    const running = ResultTask.runPromise(mapped(1), { clock, scheduler, yieldEvery: 2 })
    await clock.advanceBy(1)
    equal(await running, 1)
    equal(clock.pending, 0)
  })

  it('supports injected dispatchers, predictable budgets and disabling automatic yields', async () => {
    let yields = 0
    const controller = new AbortController()
    const scheduler: TaskScheduler = {
      yield: (signal) => {
        strictEqual(signal, controller.signal)
        yields += 1
        return Promise.resolve()
      },
    }
    const task = mapped(3)
    equal(
      await ResultTask.runPromise(task, { scheduler, yieldEvery: 2, signal: controller.signal }),
      3,
    )
    equal(yields, 3)
    equal(
      await ResultTask.runPromise(task, { scheduler, yieldEvery: 2, signal: controller.signal }),
      3,
    )
    equal(yields, 6)
    equal(
      await ResultTask.runPromise(task, {
        scheduler,
        yieldEvery: Infinity,
        signal: controller.signal,
      }),
      3,
    )
    equal(yields, 6)
  })

  it('gives each child fiber its own budget while retaining the dispatcher', async () => {
    for (let warmup = 0; warmup < 6; warmup += 1) {
      const controller = new AbortController()
      const counts = new Map<AbortSignal, number>()
      const scheduler: TaskScheduler = {
        yield: (signal) => {
          counts.set(signal, (counts.get(signal) ?? 0) + 1)
          return Promise.resolve()
        },
      }
      const program = ResultTask.gen(function* () {
        for (let index = 0; index < warmup; index += 1) yield* ResultTask.ok('warmup')
        const fiber = yield* ResultTask.forkChild(mapped(2))
        const exit = yield* Fiber.await(fiber)
        expectTypeOf(exit).toEqualTypeOf<Exit<number, never>>()
        return exit
      })
      // eslint-disable-next-line no-await-in-loop
      const exit = await ResultTask.runPromise(program, {
        scheduler,
        yieldEvery: 3,
        signal: controller.signal,
      })
      deepEqual(exit, { _tag: 'Success', value: 2 })
      const childCounts = [...counts].filter(([signal]) => signal !== controller.signal)
      equal(childCounts.length, 1)
      equal(childCounts[0]?.[1], 1)
    }
  })

  it('interrupts a pending scheduler yield before running the next instruction', async () => {
    const controller = new AbortController()
    let bodyCalls = 0
    let entered: (() => void) | undefined = undefined
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const scheduler: TaskScheduler = {
      yield: (signal) =>
        new Promise<void>((_resolve, reject) => {
          entered?.()
          signal.addEventListener('abort', () => reject(new Error('scheduler interrupted')), {
            once: true,
          })
        }),
    }
    const running = ResultTask.runExit(
      ResultTask.sync(() => {
        bodyCalls += 1
      }),
      { scheduler, yieldEvery: 1, signal: controller.signal },
    )
    await started
    controller.abort('stop')
    deepEqual(await running, { _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'stop' } })
    equal(bodyCalls, 0)
  })

  it('preserves scheduler failures as defects and still runs registered releases', async () => {
    const defect = new Error('dispatcher failed')
    let yields = 0
    let released = 0
    const scheduler: TaskScheduler = {
      yield: () => {
        yields += 1
        if (yields === 4) throw defect
        return Promise.resolve()
      },
    }
    const program = ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.ok('resource'),
        release: () =>
          ResultTask.sync(() => {
            released += 1
          }),
      })
      return yield* mapped(3)
    })
    deepEqual(await ResultTask.runExit(program, { scheduler, yieldEvery: 1 }), {
      _tag: 'Failure',
      cause: { _tag: 'Die', defect },
    })
    equal(released, 1)
    const rejection: TaskScheduler = { yield: () => Promise.reject(defect) }
    deepEqual(await ResultTask.runExit(ResultTask.ok(1), { scheduler: rejection, yieldEvery: 1 }), {
      _tag: 'Failure',
      cause: { _tag: 'Die', defect },
    })
  })

  it('retains an existing failure when cancellation arrives during a yielded continuation', async () => {
    const controller = new AbortController()
    let yields = 0
    const scheduler: TaskScheduler = {
      yield: () => {
        yields += 1
        if (yields === 3) controller.abort('after failure')
        return Promise.resolve()
      },
    }
    const program = ResultTask.err('original').mapErr((error) => `mapped:${error}`)
    deepEqual(
      await ResultTask.runExit(program, { scheduler, yieldEvery: 1, signal: controller.signal }),
      { _tag: 'Failure', cause: { _tag: 'Fail', error: 'mapped:original' } },
    )
  })

  it('preserves pending cleanup failures when the dispatcher subsequently fails', async () => {
    const defect = new Error('dispatcher failed after cleanup')
    let yields = 0
    let released = 0
    const scheduler: TaskScheduler = {
      yield: () => {
        yields += 1
        if (yields === 9) throw defect
        return Promise.resolve()
      },
    }
    const program = ResultTask.scoped(
      ResultTask.acquireRelease({
        acquire: ResultTask.ok('resource'),
        release: () =>
          ResultTask.sync(() => {
            released += 1
          }).andThen(() => ResultTask.err('cleanup')),
      }),
    ).map((value) => value)
    deepEqual(await ResultTask.runExit(program, { scheduler, yieldEvery: 1 }), {
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Fail', error: 'cleanup' },
        right: { _tag: 'Die', defect },
      },
    })
    equal(released, 1)
  })

  it('releases resources and runs generator finally with a persistently failed dispatcher', async () => {
    const defect = new Error('dispatcher failed after acquisition')
    const events: string[] = []
    const scheduler: TaskScheduler = {
      yield: () => (events.includes('acquire') ? Promise.reject(defect) : Promise.resolve()),
    }
    const program = ResultTask.gen(function* () {
      try {
        yield* ResultTask.acquireRelease({
          acquire: ResultTask.sync(() => {
            events.push('acquire')
            return 'resource'
          }),
          release: () =>
            ResultTask.sync(() => {
              events.push('release')
            }),
        })
        return yield* ResultTask.ok('done')
      } finally {
        yield* ResultTask.sync(() => events.push('finally'))
      }
    })
    deepEqual(await ResultTask.runExit(program, { scheduler, yieldEvery: 1 }), {
      _tag: 'Failure',
      cause: { _tag: 'Die', defect },
    })
    deepEqual(events, ['acquire', 'finally', 'release'])
  })

  it('continues a finalizer when its dispatcher fails for the first time during cleanup', async () => {
    const defect = new Error('dispatcher failed during cleanup')
    let finalizing = false
    let released = 0
    const scheduler: TaskScheduler = {
      yield: () => (finalizing ? Promise.reject(defect) : Promise.resolve()),
    }
    const program = ResultTask.scoped(
      ResultTask.acquireRelease({
        acquire: ResultTask.ok('resource'),
        release: () => {
          finalizing = true
          return ResultTask.sync(() => {
            released += 1
          }).andThen(() => ResultTask.err('cleanup'))
        },
      }),
    )
    deepEqual(await ResultTask.runExit(program, { scheduler, yieldEvery: 1 }), {
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Fail', error: 'cleanup' },
        right: { _tag: 'Die', defect },
      },
    })
    equal(released, 1)
  })

  it('finishes nested generator releases before reporting a dispatcher failure', async () => {
    const defect = new Error('dispatcher failed inside release')
    const events: string[] = []
    const scheduler: TaskScheduler = {
      yield: () => (events.includes('release1') ? Promise.reject(defect) : Promise.resolve()),
    }
    const program = ResultTask.scoped(
      ResultTask.acquireRelease({
        acquire: ResultTask.ok('resource'),
        release: () =>
          ResultTask.gen(function* () {
            yield* ResultTask.sync(() => events.push('release1'))
            yield* ResultTask.sync(() => events.push('release2'))
            yield* ResultTask.sync(() => events.push('release3'))
          }),
      }),
    )
    deepEqual(await ResultTask.runExit(program, { scheduler, yieldEvery: 1 }), {
      _tag: 'Failure',
      cause: { _tag: 'Die', defect },
    })
    deepEqual(events, ['release1', 'release2', 'release3'])
  })

  it('retains dispatcher defects when nested release finally fails', async () => {
    const defect = new Error('dispatcher failed inside release')
    const events: string[] = []
    const scheduler: TaskScheduler = {
      yield: () => (events.includes('release1') ? Promise.reject(defect) : Promise.resolve()),
    }
    const program = ResultTask.scoped(
      ResultTask.acquireRelease({
        acquire: ResultTask.ok('resource'),
        release: () =>
          ResultTask.gen(function* () {
            try {
              yield* ResultTask.sync(() => events.push('release1'))
              yield* ResultTask.sync(() => events.push('release2'))
              yield* ResultTask.sync(() => events.push('release3'))
            } finally {
              yield* ResultTask.err('cleanup')
            }
          }),
      }),
    )
    deepEqual(await ResultTask.runExit(program, { scheduler, yieldEvery: 1 }), {
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Fail', error: 'cleanup' },
        right: { _tag: 'Die', defect },
      },
    })
    deepEqual(events, ['release1', 'release2', 'release3'])
  })

  it('finishes every generator finally yield after cancellation and a first cleanup dispatch fault', async () => {
    const clock = Clock.virtual()
    const controller = new AbortController()
    const defect = new Error('dispatcher failed in finally')
    const events: string[] = []
    let finalizing = false
    const scheduler: TaskScheduler = {
      yield: () => (finalizing ? Promise.reject(defect) : Promise.resolve()),
    }
    const program = ResultTask.gen(function* () {
      try {
        yield* ResultTask.sleep(100)
      } finally {
        finalizing = true
        yield* ResultTask.sync(() => events.push('finally1'))
        yield* ResultTask.sync(() => events.push('finally2'))
        yield* ResultTask.sync(() => events.push('finally3'))
      }
    })
    const running = ResultTask.runExit(program, {
      clock,
      scheduler,
      yieldEvery: 1,
      signal: controller.signal,
    })
    await clock.flush()
    controller.abort('stop')
    deepEqual(await running, {
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Interrupt', reason: 'stop' },
        right: { _tag: 'Die', defect },
      },
    })
    deepEqual(events, ['finally1', 'finally2', 'finally3'])
    equal(clock.pending, 0)
  })

  it('reports a cleanup child dispatcher defect through Fiber.await without duplicating it', async () => {
    const defect = new Error('child dispatcher failed')
    let finalizing = false
    let cleanupSignal: AbortSignal | undefined = undefined
    let dispatchedFailure = false
    let childExit: Exit<number, never> | undefined = undefined
    const scheduler: TaskScheduler = {
      yield: (signal) => {
        if (finalizing) {
          cleanupSignal ??= signal
          if (signal !== cleanupSignal && !dispatchedFailure) {
            dispatchedFailure = true
            return Promise.reject(defect)
          }
        }
        return Promise.resolve()
      },
    }
    const program = ResultTask.scoped(
      ResultTask.acquireRelease({
        acquire: ResultTask.ok('resource'),
        release: () => {
          finalizing = true
          return ResultTask.gen(function* () {
            const fiber = yield* ResultTask.forkChild(ResultTask.ok(42))
            childExit = yield* Fiber.await(fiber)
          })
        },
      }),
    )
    deepEqual(await ResultTask.runExit(program, { scheduler, yieldEvery: 1 }), {
      _tag: 'Success',
      value: 'resource',
    })
    deepEqual(childExit, { _tag: 'Failure', cause: { _tag: 'Die', defect } })
    equal(dispatchedFailure, true)
  })

  it('validates execution options and the default dispatcher abort lifecycle', async () => {
    for (const yieldEvery of [0, -1, 1.5, Number.NaN, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await rejects(ResultTask.runExit(ResultTask.ok(1), { yieldEvery }), RangeError)
    }
    await rejects(
      ResultTask.runExit(ResultTask.ok(1), { scheduler: {} as TaskScheduler }),
      TypeError,
    )
    const controller = new AbortController()
    controller.abort('before')
    await rejects(Promise.resolve(Scheduler.live.yield(controller.signal)), { name: 'AbortError' })
    const pendingController = new AbortController()
    const pending = Scheduler.live.yield(pendingController.signal)
    pendingController.abort('during')
    await rejects(Promise.resolve(pending), { name: 'AbortError' })
    let yields = 0
    deepEqual(
      await ResultTask.runExit(ResultTask.ok(1), {
        signal: controller.signal,
        yieldEvery: 1,
        scheduler: {
          yield: () => {
            yields += 1
            return Promise.resolve()
          },
        },
      }),
      { _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'before' } },
    )
    equal(yields, 0)
  })

  it('works without setImmediate in browser-like runtimes, preserving wake order and cancellation', async () => {
    const host = globalThis as {
      setImmediate: typeof globalThis.setImmediate | undefined
      clearImmediate: typeof globalThis.clearImmediate | undefined
    }
    const savedSetImmediate = host.setImmediate
    const savedClearImmediate = host.clearImmediate
    host.setImmediate = undefined
    host.clearImmediate = undefined

    try {
      // 1. VirtualClock.flush / advanceBy / runToCompletion without setImmediate
      const clock = Clock.virtual(0)
      const order: string[] = []
      const retryLike = ResultTask.gen(function* () {
        order.push('start')
        yield* ResultTask.sleep(250)
        order.push('step-1')
        yield* ResultTask.sleep(500)
        order.push('step-2')
        yield* ResultTask.sleep(600)
        order.push('done')
        return clock.now()
      })
      const exit = await clock.runToCompletion(retryLike)
      deepEqual(exit, { _tag: 'Success', value: 1350 })
      equal(clock.now(), 1350)
      deepEqual(order, ['start', 'step-1', 'step-2', 'done'])

      // 2. Scheduler.live.yield preserves FIFO wake order without setImmediate
      const wakeOrder: number[] = []
      const c1 = new AbortController()
      const c2 = new AbortController()
      const c3 = new AbortController()
      const y1 = Promise.resolve(Scheduler.live.yield(c1.signal)).then(() => {
        wakeOrder.push(1)
      })
      const y2 = Promise.resolve(Scheduler.live.yield(c2.signal)).then(() => {
        wakeOrder.push(2)
      })
      const y3 = Promise.resolve(Scheduler.live.yield(c3.signal)).then(() => {
        wakeOrder.push(3)
      })
      // Cancel middle yield before macrotask fires
      c2.abort('cancelled-middle')
      await rejects(y2, { name: 'AbortError' })
      await Promise.all([y1, y3])
      deepEqual(wakeOrder, [1, 3])

      // 3. Long runnable task yields cooperatively via fallback macrotask scheduler
      const sum = await ResultTask.runPromise(mapped(5000), { yieldEvery: 1000 })
      equal(sum, 5000)
    } finally {
      host.setImmediate = savedSetImmediate
      host.clearImmediate = savedClearImmediate
    }
  })

  it('interrupts task and releases scoped resources when VirtualClock.runToCompletion hits maxSteps', async () => {
    const clock = Clock.virtual(0)
    let releases = 0

    const program = ResultTask.scoped(
      ResultTask.gen(function* () {
        yield* ResultTask.acquireRelease({
          acquire: ResultTask.ok('handle'),
          release: () =>
            ResultTask.sync(() => {
              releases += 1
            }),
        })
        yield* ResultTask.sleep(100)
        return 'never'
      }),
    )

    await rejects(clock.runToCompletion(program, { maxSteps: 0 }), RangeError)
    equal(clock.pending, 0)
    equal(releases, 1)

    // Also verify partial progress (maxSteps: 1) interrupts the second timer and still releases once.
    const clock2 = Clock.virtual(0)
    let releases2 = 0
    const twoSteps = ResultTask.scoped(
      ResultTask.gen(function* () {
        yield* ResultTask.acquireRelease({
          acquire: ResultTask.ok('handle-2'),
          release: () =>
            ResultTask.sync(() => {
              releases2 += 1
            }),
        })
        yield* ResultTask.sleep(50)
        yield* ResultTask.sleep(50)
        return 'never'
      }),
    )

    await rejects(clock2.runToCompletion(twoSteps, { maxSteps: 1 }), RangeError)
    equal(clock2.now(), 50)
    equal(clock2.pending, 0)
    equal(releases2, 1)

    // Finite virtual-clock sleeps inside a resource release must complete cleanly under maxSteps: 0.
    const clock3 = Clock.virtual(0)
    let releases3 = 0
    const asyncRelease = ResultTask.scoped(
      ResultTask.gen(function* () {
        yield* ResultTask.acquireRelease({
          acquire: ResultTask.ok('handle-3'),
          release: () =>
            ResultTask.gen(function* () {
              yield* ResultTask.sleep(1)
              releases3 += 1
            }),
        })
        yield* ResultTask.sleep(100)
        return 'never'
      }),
    )

    await rejects(clock3.runToCompletion(asyncRelease, { maxSteps: 0 }), RangeError)
    equal(clock3.now(), 1)
    equal(clock3.pending, 0)
    equal(releases3, 1)
  })

  it('completes virtual-clock finalizers with delayed sleeps and >10,000 finite sleeps under maxSteps: 0', async () => {
    // 1. Finalizer awaiting an external Promise before registering a virtual sleep(1) finishes without manual advanceBy.
    const clockDelayed = Clock.virtual(0)
    let delayedReleases = 0
    const releaseEntered = Promise.withResolvers<void>()
    const externalGate = Promise.withResolvers<void>()
    const delayedSleepRelease = ResultTask.scoped(
      ResultTask.gen(function* () {
        yield* ResultTask.acquireRelease({
          acquire: ResultTask.ok('handle-delayed'),
          release: () =>
            ResultTask.gen(function* () {
              releaseEntered.resolve()
              yield* ResultTask.tryPromise({
                try: () => externalGate.promise,
                catch: (error) => error,
              })
              yield* ResultTask.sleep(1)
              delayedReleases += 1
            }),
        })
        yield* ResultTask.sleep(100)
        return 'never'
      }),
    )

    const delayedFailure = rejects(
      clockDelayed.runToCompletion(delayedSleepRelease, { maxSteps: 0 }),
      RangeError,
    )
    await releaseEntered.promise
    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })
    equal(delayedReleases, 0)
    externalGate.resolve()
    await delayedFailure
    equal(clockDelayed.now(), 1)
    equal(clockDelayed.pending, 0)
    equal(delayedReleases, 1)

    // 2. Finalizer with 10,001 finite virtual sleeps does not truncate at 10,000 steps.
    const clockMany = Clock.virtual(0)
    let manyReleases = 0
    const manySleepsRelease = ResultTask.scoped(
      ResultTask.gen(function* () {
        yield* ResultTask.acquireRelease({
          acquire: ResultTask.ok('handle-many'),
          release: () =>
            ResultTask.gen(function* () {
              for (let step = 0; step < 10_001; step += 1) {
                yield* ResultTask.sleep(1)
              }
              manyReleases += 1
            }),
        })
        yield* ResultTask.sleep(100)
        return 'never'
      }),
    )

    await rejects(clockMany.runToCompletion(manySleepsRelease, { maxSteps: 0 }), RangeError)
    equal(clockMany.now(), 10_001)
    equal(clockMany.pending, 0)
    equal(manyReleases, 1)
  }, 20_000)

  it('automatically advances finalizer sleeps scheduled after external promises during normal runToCompletion', async () => {
    const runScenario = async (outcome: 'success' | 'failure'): Promise<void> => {
      const clock = Clock.virtual(0)
      let releases = 0
      const releaseEntered = Promise.withResolvers<void>()
      const externalGate = Promise.withResolvers<void>()

      const program = ResultTask.scoped(
        ResultTask.gen(function* () {
          yield* ResultTask.acquireRelease({
            acquire: ResultTask.ok(`handle-${outcome}`),
            release: () =>
              ResultTask.gen(function* () {
                releaseEntered.resolve()
                yield* ResultTask.tryPromise({
                  try: () => externalGate.promise,
                  catch: (error) => error,
                })
                yield* ResultTask.sleep(1)
                releases += 1
              }),
          })
          for (let tick = 0; tick < 5; tick += 1) {
            yield* ResultTask.sleep(1)
          }
          if (outcome === 'failure') {
            return yield* ResultTask.err('domain-failure')
          }
          return 42
        }),
      )

      const pendingExit = clock.runToCompletion(program)
      await releaseEntered.promise
      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })
      equal(clock.now(), 5)
      equal(releases, 0)

      externalGate.resolve()
      const exit = await pendingExit
      equal(clock.now(), 6)
      equal(clock.pending, 0)
      equal(releases, 1)
      if (outcome === 'success') {
        deepEqual(exit, { _tag: 'Success', value: 42 })
      } else {
        equal(exit._tag, 'Failure')
        if (exit._tag === 'Failure') {
          equal(exit.cause._tag, 'Fail')
          if (exit.cause._tag === 'Fail') {
            equal(exit.cause.error, 'domain-failure')
          }
        }
      }
    }

    await runScenario('success')
    await runScenario('failure')

    // A task that awaits only an external promise (0 virtual clock steps) succeeds under maxSteps: 0.
    const zeroClock = Clock.virtual(0)
    const zeroGate = Promise.withResolvers<number>()
    const zeroExit = zeroClock.runToCompletion(
      ResultTask.tryPromise({ try: () => zeroGate.promise, catch: (error) => error }),
      { maxSteps: 0 },
    )
    setTimeout(() => {
      zeroGate.resolve(7)
    }, 5)
    deepEqual(await zeroExit, { _tag: 'Success', value: 7 })
    equal(zeroClock.now(), 0)
    equal(zeroClock.pending, 0)
  })

  it('guards scheduleMacrotask callbacks after cancellation and validates VirtualClock options', async () => {
    const { scheduleMacrotask } = await import('../src/task/task-scheduler.js')
    const host = globalThis as unknown as {
      setImmediate?: ((cb: () => void) => unknown) | undefined
      clearImmediate?: ((h: unknown) => void) | undefined
    }
    const origSetImmediate = host.setImmediate
    const origClearImmediate = host.clearImmediate
    try {
      let captured: (() => void) | undefined = undefined
      host.setImmediate = (cb) => {
        captured = cb
        return 1
      }
      host.clearImmediate = () => undefined
      let ran = false
      const cancel = scheduleMacrotask(() => {
        ran = true
      })
      cancel()
      ;(captured as (() => void) | undefined)?.()
      equal(ran, false)
    } finally {
      host.setImmediate = origSetImmediate
      host.clearImmediate = origClearImmediate
    }

    const clock = Clock.virtual(0)
    await rejects(
      () => clock.runToCompletion(ResultTask.ok(1), { maxCleanupSteps: -1 }),
      /maxCleanupSteps/u,
    )
    await rejects(() => clock.runToCompletion(ResultTask.ok(1), { maxSteps: -1 }), /maxSteps/u)

    const extController = new AbortController()
    const extPending = clock.runToCompletion(ResultTask.sleep(100), {
      signal: extController.signal,
    })
    extController.abort('external-stop')
    equal((await extPending)._tag, 'Failure')
  })

  it('covers VirtualClock runExit rejections, cleanup step limits, and advanceBy stagnant step limit', async () => {
    const clock = Clock.virtual(0)
    await rejects(
      () =>
        clock.runToCompletion({ runExit: () => Promise.reject(new Error('run-exit-rejected')) }),
      /run-exit-rejected/u,
    )
    const abortRejectClock = Clock.virtual(0)
    await rejects(
      () =>
        abortRejectClock.runToCompletion(
          {
            runExit: ({ clock: taskClock, signal }) =>
              taskClock.sleep(10, signal) as unknown as Promise<Exit<void, never>>,
          },
          { maxSteps: 0 },
        ),
      /exceeded 0 virtual clock steps/u,
    )

    const cleanupClock = Clock.virtual(0)
    const infiniteWithSlowCleanup = ResultTask.sleep(10)
      .andThen(() => ResultTask.sleep(10))
      .ensuring(() => ResultTask.sleep(5).andThen(() => ResultTask.sleep(5)))
    await rejects(
      () =>
        cleanupClock.runToCompletion(infiniteWithSlowCleanup, { maxSteps: 1, maxCleanupSteps: 1 }),
      /exceeded 1 virtual clock steps/u,
    )

    const { NEVER_ABORTED_SIGNAL } = await import('../src/task/exit.js')
    const host = globalThis as unknown as {
      setImmediate?: ((cb: () => void) => unknown) | undefined
      clearImmediate?: ((h: unknown) => void) | undefined
    }
    const origSetImmediate = host.setImmediate
    const origClearImmediate = host.clearImmediate
    const stagnantClock = Clock.virtual(0)
    let keepLooping = true
    const loopSleep = (): void => {
      if (!keepLooping) return
      void stagnantClock.sleep(0, NEVER_ABORTED_SIGNAL).then(loopSleep)
    }
    loopSleep()
    try {
      host.setImmediate = (cb) => {
        queueMicrotask(cb)
        return 1
      }
      host.clearImmediate = () => undefined
      await rejects(() => stagnantClock.advanceBy(10), /exceeded zero-duration step limit/u)
    } finally {
      keepLooping = false
      host.setImmediate = origSetImmediate
      host.clearImmediate = origClearImmediate
    }
  })
})
