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
})
