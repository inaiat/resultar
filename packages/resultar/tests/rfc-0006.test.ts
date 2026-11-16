import { expect, expectTypeOf, test, vi } from 'vite-plus/test'
import {
  Cause,
  Fiber,
  ResultAsync,
  ResultTask,
  err,
  ok,
  type Result,
  type ResultTaskScope,
} from '../src/index.js'

const interrupted = { _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'stop' } } as const

for (const adapter of ['promise', 'async', 'defect'] as const) {
  for (const shape of ['direct', 'map', 'andThen'] as const) {
    test(`late ${adapter} acquisition with ${shape} records the ownership boundary`, async () => {
      const started = Promise.withResolvers<void>()
      const pending = Promise.withResolvers<number>()
      const releasing = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      const controller = new AbortController()
      const acquire = () => {
        started.resolve()
        return pending.promise
      }
      const base = {
        defect: ResultTask.fromPromise(acquire),
        promise: ResultTask.tryPromise(acquire),
        async: ResultTask.fromResultAsync(() => ResultAsync.fromSafePromise(acquire())),
      }[adapter]
      let acquisition = base
      if (shape === 'map') acquisition = base.map((value) => value)
      if (shape === 'andThen') acquisition = base.andThen((value) => ResultTask.ok(value))
      let releases = 0
      let uses = 0
      let finished = false
      const running = ResultTask.acquireRelease({
        acquire: acquisition,
        release: () =>
          ResultTask.tryPromise(async (signal) => {
            expect(signal.aborted).toBe(false)
            releases += 1
            releasing.resolve()
            await released.promise
          }),
      })
        .andThen(() =>
          ResultTask.sync(() => {
            uses += 1
          }),
        )
        .runExit({ signal: controller.signal })
      void running.then(() => {
        finished = true
      })
      await started.promise
      controller.abort('stop')
      pending.resolve(42)
      if (shape === 'direct') {
        await releasing.promise
        expect(finished).toBe(false)
      }
      released.resolve()
      expect(await running).toEqual(interrupted)
      // Composition inside acquisition may hide late values. Register ownership before composing.
      expect(releases).toBe(shape === 'direct' ? 1 : 0)
      expect(uses).toBe(0)
    })
  }
}

for (const release of ['typed', 'throw', 'task-defect'] as const) {
  test(`late success preserves interruption followed by ${release} release failure`, async () => {
    const pending = Promise.withResolvers<Result<number, string>>()
    const started = Promise.withResolvers<void>()
    const controller = new AbortController()
    const defect = new Error('release')
    const task = ResultTask.acquireRelease({
      acquire: ResultTask.fromResultAsync(() => {
        started.resolve()
        return pending.promise
      }),
      release: () => {
        if (release === 'throw') throw defect
        return release === 'typed'
          ? ResultTask.fail('release')
          : ResultTask.sync(() => {
              throw defect
            })
      },
    })
    const running = task.runExit({ signal: controller.signal })
    await started.promise
    controller.abort('stop')
    pending.resolve(ok(42))
    expect(await running).toEqual({
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: interrupted.cause,
        right: release === 'typed' ? { _tag: 'Fail', error: 'release' } : { _tag: 'Die', defect },
      },
    })
  })
}

for (const owned of [false, true]) {
  for (const settlement of ['ok', 'err', 'reject', 'throw'] as const) {
    test(`async adapter precedence: ${settlement}, owned=${owned}`, async () => {
      const pending = Promise.withResolvers<Result<number, string>>()
      const started = Promise.withResolvers<void>()
      const controller = new AbortController()
      const defect = new Error('driver')
      let releases = 0
      const base = ResultTask.fromResultAsync(() => {
        started.resolve()
        if (settlement === 'throw') {
          controller.abort('stop')
          throw defect
        }
        return pending.promise
      })
      const task = owned
        ? ResultTask.acquireRelease({
            acquire: base,
            release: () =>
              ResultTask.sync(() => {
                releases += 1
              }),
          })
        : base
      const running = task.runExit({ signal: controller.signal })
      await started.promise
      controller.abort('stop')
      if (settlement === 'ok') pending.resolve(ok(42))
      if (settlement === 'err') pending.resolve(err('driver'))
      if (settlement === 'reject') pending.reject(defect)
      expect(await running).toEqual(
        settlement === 'ok' || settlement === 'err'
          ? interrupted
          : { _tag: 'Failure', cause: { _tag: 'Die', defect } },
      )
      expect(releases).toBe(owned && settlement === 'ok' ? 1 : 0)
    })
  }
}

test('pre-aborted factories do not run or claim already-started eager resources', async () => {
  const controller = new AbortController()
  controller.abort('stop')
  const make = vi.fn(() => Promise.resolve(ok(1)))
  for (const base of [
    ResultTask.fromResultAsync(make),
    ResultTask.fromResultAsync(Promise.resolve(ok(1))),
  ]) {
    let releases = 0
    const exit = await ResultTask.acquireRelease({
      acquire: base,
      release: () =>
        ResultTask.sync(() => {
          releases += 1
        }),
    }).runExit({ signal: controller.signal })
    expect(exit).toEqual(interrupted)
    expect(releases).toBe(0)
  }
  expect(make).not.toHaveBeenCalled()
})

test('eager late success releases once per acquisition; replay does not deduplicate ownership', async () => {
  const pending = Promise.withResolvers<Result<object, never>>()
  const controller = new AbortController()
  const resource = {}
  const released: object[] = []
  const eager = new ResultAsync(pending.promise)
  const task = ResultTask.acquireRelease({
    acquire: ResultTask.fromResultAsync(eager),
    release: (value) =>
      ResultTask.sync(() => {
        released.push(value)
      }),
  })
  const first = task.runExit({ signal: controller.signal })
  controller.abort('stop')
  pending.resolve(ok(resource))
  expect(await first).toEqual(interrupted)
  expect(await task.runPromise()).toBe(resource)
  expect(released).toEqual([resource, resource])
})

test('factory runs acquire distinct resources with independent cancellation and repetition', async () => {
  const acquisitions = [
    Promise.withResolvers<Result<number, never>>(),
    Promise.withResolvers<Result<number, never>>(),
    Promise.withResolvers<Result<number, never>>(),
  ]
  let runs = 0
  const released: number[] = []
  const task = ResultTask.acquireRelease({
    acquire: ResultTask.fromResultAsync(() => {
      const acquisition = acquisitions[runs]
      if (acquisition === undefined) throw new Error('Unexpected acquisition')
      runs += 1
      return acquisition.promise
    }),
    release: (value) =>
      ResultTask.sync(() => {
        released.push(value)
      }),
  })
  expect(runs).toBe(0)
  const controller = new AbortController()
  const first = task.runExit({ signal: controller.signal })
  const second = task.runExit()
  controller.abort('stop')
  acquisitions[0]?.resolve(ok(1))
  acquisitions[1]?.resolve(ok(2))
  expect(await first).toEqual(interrupted)
  expect(await second).toEqual({ _tag: 'Success', value: 2 })
  const third = task.runPromise()
  acquisitions[2]?.resolve(ok(3))
  expect(await third).toBe(3)
  expect(released.toSorted((a, b) => a - b)).toEqual([1, 2, 3])
})

for (const outcome of ['late', 'after-registration', 'failure'] as const) {
  test(`ownership before composition releases on ${outcome}`, async () => {
    const pending = Promise.withResolvers<Result<number, never>>()
    const controller = new AbortController()
    let released = 0
    let transformed = 0
    const owned = ResultTask.acquireRelease({
      acquire: ResultTask.fromResultAsync(() => pending.promise),
      release: () =>
        ResultTask.sync(() => {
          released += 1
        }),
    })
    const task = owned
      .map((value) => {
        transformed += 1
        if (outcome === 'after-registration') controller.abort('stop')
        return value
      })
      .andThen(() => ResultTask.fail('use'))
    const running = task.runExit({ signal: controller.signal })
    if (outcome === 'late') controller.abort('stop')
    pending.resolve(ok(1))
    expect(await running).toEqual(
      outcome === 'failure'
        ? { _tag: 'Failure', cause: { _tag: 'Fail', error: 'use' } }
        : interrupted,
    )
    expect(released).toBe(1)
    expect(transformed).toBe(outcome === 'late' ? 0 : 1)
  })
}

test('never is lazy, independently cancellable, removes listeners, and preserves exact types', async () => {
  const task = ResultTask.never()
  expectTypeOf(task).toEqualTypeOf<ResultTask<never, never, never>>()
  expectTypeOf(ResultTask.race(task, ResultTask.ok(42))).toEqualTypeOf<ResultTask<number>>()
  expectTypeOf(ResultTask.raceFirst(task, ResultTask.fail('failure' as const))).toEqualTypeOf<
    ResultTask<never, 'failure'>
  >()
  const owned = ResultTask.acquireRelease({
    acquire: ResultTask.ok(1),
    release: () => ResultTask.fail('release' as const),
  }).andThen(() => task)
  expectTypeOf(owned).toEqualTypeOf<ResultTask<never, never, ResultTaskScope<'release'>>>()
  for (let run = 0; run < 2; run += 1) {
    const a = new AbortController()
    const b = new AbortController()
    const added = vi.spyOn(a.signal, 'addEventListener')
    const removed = vi.spyOn(a.signal, 'removeEventListener')
    const first = task.runExit({ signal: a.signal })
    const second = task.runFork({ signal: b.signal })
    a.abort('stop')
    expect(await first).toEqual(interrupted)
    expect(second.poll()).toBeUndefined()
    expect(removed.mock.calls).toHaveLength(1)
    expect(removed.mock.calls[0]?.[1]).toBe(added.mock.calls[0]?.[1])
    b.abort('other')
    expect(await Fiber.await(second).runPromise()).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'other' },
    })
    added.mockClear()
    expect(await task.runExit({ signal: a.signal })).toEqual(interrupted)
    expect(added).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  }
})

test('never fiber interruption awaits scoped asynchronous cleanup and retains cleanup failure', async () => {
  const ready = Promise.withResolvers<void>()
  const releasing = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const task = ResultTask.scoped(
    ResultTask.acquireRelease({
      acquire: ResultTask.sync(() => {
        ready.resolve()
        return 1
      }),
      release: () =>
        ResultTask.tryPromise(async (signal) => {
          expect(signal.aborted).toBe(false)
          releasing.resolve()
          await release.promise
        }).andThen(() => ResultTask.fail('release')),
    }).andThen(() => ResultTask.never()),
  )
  const fiber = task.runFork()
  await ready.promise
  const exit = Fiber.interrupt(fiber, 'stop').runPromise()
  await releasing.promise
  expect(fiber.poll()).toBeUndefined()
  release.resolve()
  expect(await exit).toEqual({
    _tag: 'Failure',
    cause: {
      _tag: 'Sequential',
      left: interrupted.cause,
      right: { _tag: 'Fail', error: 'release' },
    },
  })
})

for (const mode of ['success', 'failure-first', 'failure-until-abort'] as const) {
  test(`never race contract: ${mode}`, async () => {
    let released = 0
    const entered = Promise.withResolvers<void>()
    const pending = ResultTask.acquireRelease({
      acquire: ResultTask.sync(() => {
        entered.resolve()
        return 1
      }),
      release: () =>
        ResultTask.sync(() => {
          released += 1
        }),
    }).andThen(() => ResultTask.never())
    const settled = Promise.withResolvers<void>()
    const other = ResultTask.tryPromise(() => entered.promise)
      .andThen(() => (mode === 'success' ? ResultTask.ok(42) : ResultTask.fail('failure')))
      .onExit(() => {
        settled.resolve()
      })
    const task =
      mode === 'failure-first'
        ? ResultTask.raceFirst(pending, other)
        : ResultTask.race(pending, other)
    const fiber = task.runFork()
    await entered.promise
    if (mode === 'failure-until-abort') {
      await settled.promise
      expect(fiber.poll()).toBeUndefined()
      await Fiber.interrupt(fiber, 'stop').runPromise()
    }
    const exit = await Fiber.await(fiber).runPromise()
    if (mode === 'success') expect(exit).toEqual({ _tag: 'Success', value: 42 })
    else if (mode === 'failure-first')
      expect(exit).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'failure' } })
    else {
      expect(exit._tag).toBe('Failure')
      if (exit._tag === 'Failure') {
        expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        expect(Cause.failures(exit.cause)).toEqual(['failure'])
        expect(Cause.pretty(exit.cause)).toContain('stop')
      }
    }
    expect(released).toBe(1)
  })
}

test('cause recovery handles defects with E=never but cannot swallow external interruption', async () => {
  expect(
    await ResultTask.sync(() => {
      throw new Error('defect')
    })
      .catchCause(() => ResultTask.ok('recovered'))
      .runPromise(),
  ).toBe('recovered')
  for (const cleanupFails of [false, true]) {
    const ready = Promise.withResolvers<void>()
    const recovered = vi.fn(() => ResultTask.ok('recovered'))
    const controller = new AbortController()
    const task = ResultTask.scoped(
      ResultTask.acquireRelease({
        acquire: ResultTask.sync(() => {
          ready.resolve()
          return 1
        }),
        release: () => (cleanupFails ? ResultTask.fail('cleanup') : ResultTask.ok(undefined)),
      }).andThen(() => ResultTask.never()),
    ).catchCause(recovered)
    const running = task.runExit({ signal: controller.signal })
    await ready.promise
    controller.abort('stop')
    const exit = await running
    expect(exit._tag).toBe('Failure')
    if (cleanupFails) {
      expect(recovered).toHaveBeenCalledOnce()
    } else {
      expect(recovered).not.toHaveBeenCalled()
    }
    expect(exit).toEqual(interrupted)
  }
})
