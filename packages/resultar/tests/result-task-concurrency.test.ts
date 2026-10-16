import { deepEqual, equal, rejects, throws } from 'node:assert/strict'
import { describe, expectTypeOf, it } from 'vite-plus/test'
import { Fiber, ResultTask, ResultTaskCauseError } from '../src/task/result-task.js'
import type { Exit, FiberHandle, ResultTaskScope } from '../src/task/result-task.js'
import { Clock } from '../src/task/task-clock.js'
import { err, ok } from '../src/result/result.js'

describe('ResultTask observation and clocks', () => {
  it('ignores observation throws and rejections, without executing returned tasks', async () => {
    let executions = 0
    const task = ResultTask.ok(1)
      .inspect(() => {
        throw new Error('observer')
      })
      .inspect(async () => {
        throw new Error('async observer')
      })
      .inspect(() =>
        ResultTask.sync(() => {
          executions += 1
        }),
      )
      .pipe(ResultTask.inspect((value: number) => equal(value, 1)))
    equal(executions, 0)
    deepEqual(await ResultTask.runResult(task), ok(1))
    equal(executions, 0)
    deepEqual(
      await ResultTask.runResult(
        ResultTask.err('missing')
          .inspectError(async () => {
            throw new Error('observer')
          })
          .pipe(ResultTask.inspectError((error: string) => equal(error, 'missing'))),
      ),
      err('missing'),
    )
    deepEqual(
      await ResultTask.runResult(
        ResultTask.inspectError(ResultTask.err('x'), () => ResultTask.err('ignored')),
      ),
      err('x'),
    )
    expectTypeOf(task).toEqualTypeOf<ResultTask<number>>()
  })

  it('uses virtual monotonic time and removes canceled sleepers', async () => {
    const clock = Clock.virtual(50)
    const controller = new AbortController()
    const task = ResultTask.sleep(20).andThen(() => ResultTask.now())
    const running = ResultTask.runResult(task, { clock })
    await clock.advanceBy(20)
    deepEqual(await running, ok(70))
    const canceled = ResultTask.runExit(ResultTask.sleep(10), { clock, signal: controller.signal })
    await clock.flush()
    equal(clock.pending, 1)
    controller.abort('stop')
    deepEqual(await canceled, { _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'stop' } })
    equal(clock.pending, 0)
  })

  it('drains long continuation chains before advancing virtual time', async () => {
    const clock = Clock.virtual()
    let task = ResultTask.ok(0)
    for (let index = 0; index < 1000; index += 1)
      task = task.andThen((value) => ResultTask.ok(value + 1))
    const running = ResultTask.runResult(
      task.andThen(() => ResultTask.sleep(10)).andThen(() => ResultTask.now()),
      { clock },
    )
    await clock.advanceBy(10)
    deepEqual(await running, ok(10))
    const timeout = ResultTask.runResult(
      task.andThen(() => ResultTask.sleep(100)).timeout(5, () => 'timeout'),
      { clock },
    )
    await clock.advanceBy(5)
    deepEqual(await timeout, err('timeout'))
    equal(clock.pending, 0)
  })

  it('serializes concurrent virtual advances without moving time backwards', async () => {
    const clock = Clock.virtual()
    await Promise.all([clock.advanceBy(20), clock.advanceBy(10)])
    equal(clock.now(), 30)
    const controller = new AbortController()
    const sleep = Clock.live.sleep(2_147_483_648, controller.signal)
    controller.abort('stop long timer')
    await rejects(
      sleep,
      (reason: unknown) => reason instanceof Error && reason.cause === 'stop long timer',
    )
  })
})

describe('ResultTask owned fibers', () => {
  it('stops children before releasing parent resources and awaits shielded cleanup', async () => {
    const clock = Clock.virtual()
    const events: string[] = []
    const resource = (name: string, cleanupDelay: number) =>
      ResultTask.acquireRelease({
        acquire: ResultTask.sync(() => {
          events.push(`acquire:${name}`)
          return name
        }),
        release: () =>
          ResultTask.sleep(cleanupDelay).andThen(() =>
            ResultTask.tryPromise({
              try: async (signal) => {
                equal(signal.aborted, false)
                events.push(`release:${name}`)
              },
              catch: () => 'release-error' as const,
            }),
          ),
      })
    const child = ResultTask.gen(function* () {
      yield* resource('child', 5)
      yield* ResultTask.sleep(100)
    })
    const parent = ResultTask.gen(function* () {
      yield* resource('parent', 0)
      yield* ResultTask.forkChild(child)
      yield* ResultTask.sleep(1)
      return 'done'
    })
    let finished = false
    const running = ResultTask.runResult(parent, { clock }).then((value) => {
      finished = true
      return value
    })
    await clock.advanceBy(1)
    equal(finished, false)
    await clock.advanceBy(5)
    deepEqual(await running, ok('done'))
    deepEqual(events, ['acquire:parent', 'acquire:child', 'release:child', 'release:parent'])
    equal(clock.pending, 0)
  })

  it('propagates parent cancellation and awaits a child finalizer exactly once', async () => {
    const clock = Clock.virtual()
    const controller = new AbortController()
    let released = 0
    const child = ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.ok('resource'),
        release: () =>
          ResultTask.sync(() => {
            released += 1
          }),
      })
      yield* ResultTask.sleep(100)
      return 1
    })
    const parent = ResultTask.gen(function* () {
      const fiber = yield* ResultTask.forkChild(child)
      return yield* Fiber.join(fiber)
    })
    const running = ResultTask.runExit(parent, { clock, signal: controller.signal })
    await clock.flush()
    controller.abort('request closed')
    const exit = await running
    equal(exit._tag, 'Failure')
    if (exit._tag === 'Failure') equal(exit.cause._tag, 'Interrupt')
    equal(released, 1)
    equal(clock.pending, 0)
  })

  it('reports unobserved child failure but does not duplicate joined/recovered failure', async () => {
    const clock = Clock.virtual()
    const unobserved = ResultTask.gen(function* () {
      yield* ResultTask.forkChild(ResultTask.err('child failed'))
      yield* ResultTask.sleep(1)
      return 'parent'
    })
    const running = ResultTask.runResult(unobserved, { clock })
    await clock.advanceBy(1)
    deepEqual(await running, err('child failed'))
    const observed = ResultTask.gen(function* () {
      const fiber = yield* ResultTask.forkChild(ResultTask.err('child failed'))
      return yield* Fiber.join(fiber).orElse(() => ResultTask.ok('recovered'))
    })
    deepEqual(await ResultTask.runResult(observed), ok('recovered'))
  })

  it('interrupt returns the complete child exit after release', async () => {
    const clock = Clock.virtual()
    let released = false
    const parent = ResultTask.gen(function* () {
      const fiber = yield* ResultTask.forkChild(
        ResultTask.gen(function* () {
          yield* ResultTask.acquireRelease({
            acquire: ResultTask.ok(1),
            release: () =>
              ResultTask.sync(() => {
                released = true
              }),
          })
          yield* ResultTask.sleep(100)
        }),
      )
      yield* ResultTask.sleep(1)
      return yield* Fiber.interrupt(fiber, 'finished')
    })
    const running = ResultTask.runPromise(parent, { clock })
    await clock.advanceBy(1)
    deepEqual(await running, { _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'finished' } })
    equal(released, true)
  })

  it('inherits provided services in the child and its finalizer', async () => {
    const Service = ResultTask.service<{ readonly value: number }>()('Service')
    const seen: number[] = []
    const child = ResultTask.gen(function* () {
      const service = yield* Service
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.ok(service.value),
        release: () =>
          ResultTask.gen(function* () {
            const current = yield* Service
            seen.push(current.value)
          }),
      })
      return service.value
    })
    const parent = ResultTask.gen(function* () {
      const fiber = yield* ResultTask.forkChild(child)
      return yield* Fiber.join(fiber)
    }).provideService(Service, { value: 42 })
    deepEqual(await ResultTask.runResult(parent), ok(42))
    deepEqual(seen, [42])
  })
})

describe('ResultTask race and timeout', () => {
  it('race chooses first success while raceFirst chooses first outcome', async () => {
    const clock = Clock.virtual()
    const slow = ResultTask.sleep(5).as('success')
    const running = ResultTask.runResult(ResultTask.race(ResultTask.err('early'), slow), { clock })
    await clock.advanceBy(5)
    deepEqual(await running, ok('success'))
    const firstOutcome = ResultTask.err('early').pipe(
      ResultTask.raceFirst(ResultTask.sleep(5).as('later')),
    )
    expectTypeOf(firstOutcome).toEqualTypeOf<ResultTask<string, 'early'>>()
    deepEqual(await ResultTask.runResult(firstOutcome, { clock }), err('early'))
    equal(clock.pending, 0)
  })

  it('preserves parallel failures and the composite runner policy', async () => {
    const task = ResultTask.race(ResultTask.err('left'), ResultTask.err('right'))
    deepEqual(await ResultTask.runExit(task), {
      _tag: 'Failure',
      cause: {
        _tag: 'Parallel',
        left: { _tag: 'Fail', error: 'left' },
        right: { _tag: 'Fail', error: 'right' },
      },
    })
    await rejects(ResultTask.runResult(task), ResultTaskCauseError)
    const recovered = await ResultTask.runExit(task.orElse(() => ResultTask.ok('recovered')))
    equal(recovered._tag, 'Failure')
    if (recovered._tag === 'Failure') equal(recovered.cause._tag, 'Die')
    deepEqual(await ResultTask.runExit(task.mapErr((error) => error.length)), {
      _tag: 'Failure',
      cause: {
        _tag: 'Parallel',
        left: { _tag: 'Fail', error: 4 },
        right: { _tag: 'Fail', error: 5 },
      },
    })
  })

  it('returns timeout only after cleanup and preserves cleanup failure', async () => {
    const clock = Clock.virtual()
    let released = 0
    const task = ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.ok('resource'),
        release: () =>
          ResultTask.sleep(3).andThen(() =>
            ResultTask.sync(() => {
              released += 1
            }),
          ),
      })
      yield* ResultTask.sleep(100)
      return 1
    }).timeout(5, () => 'timeout' as const)
    let finished = false
    const running = ResultTask.runResult(task, { clock }).then((value) => {
      finished = true
      return value
    })
    await clock.advanceBy(5)
    equal(finished, false)
    await clock.advanceBy(3)
    deepEqual(await running, err('timeout'))
    equal(released, 1)
    const leaking = ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.ok(1),
        release: () => ResultTask.err('close'),
      })
      yield* ResultTask.sleep(100)
    })
    const timeoutFailure = ResultTask.timeout(leaking, 5, () => 'timeout')
    expectTypeOf(timeoutFailure).toEqualTypeOf<ResultTask<void, string>>()
    const failed = ResultTask.runExit(timeoutFailure, { clock })
    await clock.advanceBy(5)
    deepEqual(await failed, {
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Fail', error: 'timeout' },
        right: { _tag: 'Fail', error: 'close' },
      },
    })
    equal(clock.pending, 0)
  })

  it('releases a resource acquired after its deadline instead of leaving it ownerless', async () => {
    const clock = Clock.virtual()
    let complete: (value: string) => void = () => undefined
    const acquisition = new Promise<string>((resolve) => {
      complete = resolve
    })
    let releases = 0
    const task = ResultTask.acquireRelease({
      acquire: ResultTask.tryPromise({
        try: () => acquisition,
        catch: () => 'acquisition' as const,
      }),
      release: (resource) =>
        ResultTask.sync(() => {
          equal(resource, 'late')
          releases += 1
        }),
    }).timeout(5, () => 'timeout' as const)
    let finished = false
    const running = ResultTask.runResult(task, { clock }).then((result) => {
      finished = true
      return result
    })
    await clock.advanceBy(5)
    equal(finished, false)
    complete('late')
    deepEqual(await running, err('timeout'))
    equal(releases, 1)
    equal(clock.pending, 0)
  })

  it('preserves nested scoped cleanup failures after mapErr and honors explicit recovery', async () => {
    const clock = Clock.virtual()
    const nested = ResultTask.scoped(
      ResultTask.gen(function* () {
        yield* ResultTask.acquireRelease({
          acquire: ResultTask.ok(1),
          release: () => ResultTask.err('close'),
        })
        yield* ResultTask.sleep(100)
      }),
    ).mapErr((error) => `mapped:${error}`)
    const running = ResultTask.runExit(
      nested.timeout(5, () => 'timeout'),
      { clock },
    )
    await clock.advanceBy(5)
    deepEqual(await running, {
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Fail', error: 'timeout' },
        right: { _tag: 'Fail', error: 'mapped:close' },
      },
    })
    const recovered = ResultTask.scoped(
      ResultTask.acquireRelease({
        acquire: ResultTask.ok(1),
        release: () => ResultTask.err('close'),
      }),
    )
      .orElse(() => ResultTask.sleep(100))
      .timeout(5, () => 'timeout')
    const recoveredRun = ResultTask.runResult(recovered, { clock })
    await clock.advanceBy(5)
    deepEqual(await recoveredRun, err('timeout'))
    equal(clock.pending, 0)
  })

  it('retains cleanup provenance through successful task and promise tapError callbacks', async () => {
    const clock = Clock.virtual()
    const loser = ResultTask.scoped(
      ResultTask.acquireRelease({
        acquire: ResultTask.ok(1),
        release: () => ResultTask.err('close'),
      }),
    )
      .tapError(() => ResultTask.ok(undefined))
      .tapError(async () => undefined)
    const running = ResultTask.runExit(ResultTask.race(loser, ResultTask.sleep(1).as('winner')), {
      clock,
    })
    await clock.advanceBy(1)
    deepEqual(await running, { _tag: 'Failure', cause: { _tag: 'Fail', error: 'close' } })
    equal(clock.pending, 0)
  })

  it('retains cleanup classification when a tapError task substitutes the failure', async () => {
    const clock = Clock.virtual()
    const loser = ResultTask.scoped(
      ResultTask.acquireRelease({
        acquire: ResultTask.ok(1),
        release: () => ResultTask.err('close'),
      }),
    ).tapError(() => ResultTask.err('reportingfailed'))
    const running = ResultTask.runExit(ResultTask.race(loser, ResultTask.sleep(1).as('winner')), {
      clock,
    })
    await clock.advanceBy(1)
    deepEqual(await running, { _tag: 'Failure', cause: { _tag: 'Fail', error: 'reportingfailed' } })
    equal(clock.pending, 0)
  })
})

describe('ResultTask retry', () => {
  it('closes each attempt before backoff and uses deterministic jitter', async () => {
    const clock = Clock.virtual(0, () => 0.5)
    const events: string[] = []
    let attempt = 0
    const task = ResultTask.gen(function* () {
      const current = yield* ResultTask.acquireRelease({
        acquire: ResultTask.sync(() => {
          attempt += 1
          events.push(`attempt:${attempt}`)
          return attempt
        }),
        release: (value) =>
          ResultTask.sync(() => {
            events.push(`release:${value}`)
          }),
      })
      if (current < 3) return yield* ResultTask.err('offline' as const)
      return current
    }).retry({
      times: 2,
      delayMs: 10,
      backoff: 2,
      jittered: true,
      while: (error) => error === 'offline',
    })
    const running = ResultTask.runResult(task, { clock })
    await clock.flush()
    deepEqual(events, ['attempt:1', 'release:1'])
    await clock.advanceBy(5)
    deepEqual(events, ['attempt:1', 'release:1', 'attempt:2', 'release:2'])
    await clock.advanceBy(10)
    deepEqual(await running, ok(3))
    deepEqual(events, [
      'attempt:1',
      'release:1',
      'attempt:2',
      'release:2',
      'attempt:3',
      'release:3',
    ])
  })

  it('does not retry defects, rejected predicates, or cancellation during backoff', async () => {
    let attempts = 0
    const defect = ResultTask.sync(() => {
      attempts += 1
      throw new Error('bug')
    }).retry({ times: 3 })
    const exit = await ResultTask.runExit(defect)
    equal(exit._tag, 'Failure')
    equal(attempts, 1)
    deepEqual(
      await ResultTask.runResult(ResultTask.err('denied').retry({ times: 3, while: () => false })),
      err('denied'),
    )
    const clock = Clock.virtual()
    const controller = new AbortController()
    attempts = 0
    const running = ResultTask.runExit(
      ResultTask.sync(() => {
        attempts += 1
      })
        .andThen(() => ResultTask.err('offline'))
        .retry({ times: 3, delayMs: 10 }),
      { clock, signal: controller.signal },
    )
    await clock.flush()
    controller.abort('stop')
    equal((await running)._tag, 'Failure')
    equal(attempts, 1)
    equal(clock.pending, 0)
  })

  it('does not retry a composite body/release failure', async () => {
    let attempts = 0
    const task = ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.sync(() => {
          attempts += 1
        }),
        release: () => ResultTask.err('release'),
      })
      return yield* ResultTask.err('body')
    }).retry({ times: 3 })
    deepEqual(await ResultTask.runExit(task), {
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Fail', error: 'body' },
        right: { _tag: 'Fail', error: 'release' },
      },
    })
    equal(attempts, 1)
  })
})

describe('ResultTask collections', () => {
  it('is lazy, sequential by default, bounded when requested, and preserves input order', async () => {
    const clock = Clock.virtual()
    let active = 0
    let maximum = 0
    const starts: number[] = []
    const mapper = (value: number) =>
      ResultTask.sync(() => {
        starts.push(value)
        active += 1
        maximum = Math.max(maximum, active)
      })
        .andThen(() => ResultTask.sleep(4 - value))
        .map(() => {
          active -= 1
          return value * 2
        })
    // eslint-disable-next-line unicorn/no-array-for-each -- This is the ResultTask policy, not Array.forEach.
    const task = ResultTask.forEach([1, 2, 3], mapper, { concurrency: 2 })
    deepEqual(starts, [])
    const running = ResultTask.runResult(task, { clock })
    await clock.advanceBy(4)
    deepEqual(await running, ok([2, 4, 6]))
    equal(maximum, 2)
    maximum = 0
    // eslint-disable-next-line unicorn/no-array-for-each -- This is the ResultTask policy, not Array.forEach.
    const sequential = ResultTask.runResult(ResultTask.forEach([1, 2], mapper), { clock })
    await clock.advanceBy(5)
    deepEqual(await sequential, ok([2, 4]))
    equal(maximum, 1)
  })

  it('stops scheduling after failure and awaits active child cleanup', async () => {
    const clock = Clock.virtual()
    const starts: number[] = []
    const released: number[] = []
    // eslint-disable-next-line unicorn/no-array-for-each -- This is the ResultTask policy, not Array.forEach.
    const task = ResultTask.forEach(
      [0, 1, 2, 3],
      (index) =>
        ResultTask.gen(function* () {
          starts.push(index)
          yield* ResultTask.acquireRelease({
            acquire: ResultTask.ok(index),
            release: (resource) =>
              ResultTask.sync(() => {
                released.push(resource)
              }),
          })
          yield* ResultTask.sleep(index === 0 ? 1 : 100)
          if (index === 0) return yield* ResultTask.err('failed')
          return index
        }),
      { concurrency: 2 },
    )
    const running = ResultTask.runResult(task, { clock })
    await clock.advanceBy(1)
    deepEqual(await running, err('failed'))
    deepEqual(starts, [0, 1])
    deepEqual(released, [0, 1])
    equal(clock.pending, 0)
  })

  it('validates all expected failures in input order including undefined errors', async () => {
    const clock = Clock.virtual()
    const running = ResultTask.runResult(
      ResultTask.validateAll(
        [1, 2, 3],
        (index) =>
          ResultTask.sleep(4 - index).andThen(() =>
            index === 2 ? ResultTask.ok(index) : ResultTask.err(index === 1 ? undefined : 'third'),
          ),
        { concurrency: 'unbounded' },
      ),
      { clock },
    )
    await clock.advanceBy(3)
    deepEqual(await running, err([undefined, 'third']))
    deepEqual(
      await ResultTask.runResult(ResultTask.all([ResultTask.ok(1), ResultTask.ok('two')])),
      ok([1, 'two']),
    )
    deepEqual(
      await ResultTask.runResult(
        ResultTask.all({ first: ResultTask.ok(1), second: ResultTask.ok('two') }),
      ),
      ok({ first: 1, second: 'two' }),
    )
    deepEqual(
      // eslint-disable-next-line unicorn/no-array-for-each -- This is the ResultTask policy, not Array.forEach.
      await ResultTask.runResult(ResultTask.forEach([], () => ResultTask.err('never'))),
      ok([]),
    )
    const cleaned: number[] = []
    deepEqual(
      await ResultTask.runResult(
        // eslint-disable-next-line unicorn/no-array-for-each -- This is the ResultTask policy, not Array.forEach.
        ResultTask.forEach(new Set([1, 2]), (item) =>
          ResultTask.acquireRelease({
            acquire: ResultTask.ok(item * 10),
            release: () =>
              // eslint-disable-next-line unicorn/no-array-for-each -- This is the ResultTask policy, not Array.forEach.
              ResultTask.forEach([item], (value) =>
                ResultTask.sync(() => {
                  cleaned.push(value)
                }),
              ).asVoid(),
          }),
        ),
      ),
      ok([10, 20]),
    )
    deepEqual(cleaned, [1, 2])
  })

  it('does not hide expected errors when validation also encounters a defect', async () => {
    const task = ResultTask.validateAll([0, 1], (index) =>
      index === 0
        ? ResultTask.err('invalid')
        : ResultTask.sync(() => {
            throw new Error('bug')
          }),
    )
    const exit = await ResultTask.runExit(task)
    equal(exit._tag, 'Failure')
    if (exit._tag === 'Failure') {
      equal(exit.cause._tag, 'Parallel')
      if (exit.cause._tag === 'Parallel')
        deepEqual(exit.cause.right, { _tag: 'Fail', error: ['invalid'] })
    }
    await rejects(ResultTask.runResult(task), ResultTaskCauseError)
  })
})

describe('ResultTask policy types', () => {
  /* eslint-disable typescript/no-deprecated -- This regression verifies retained Task methods. */
  it('preserves the existing composition names and both matching handler shapes', async () => {
    const task = ResultTask.succeed<number, string>(1)
      .flatMap((value) => ResultTask.succeed(value + 1))
      .andThen((value) => ResultTask.ok(value + 1))
      .mapError((error) => error.length)
      .catchAll((error) => ResultTask.succeed(error))
    deepEqual(await ResultTask.runResult(task), ok(3))
    deepEqual(
      await ResultTask.runResult(
        ResultTask.succeed(1).pipe(ResultTask.flatMap((value) => ResultTask.succeed(value + 1))),
      ),
      ok(2),
    )
    deepEqual(
      await ResultTask.runResult(
        ResultTask.mapError(ResultTask.fail('missing'), (error) => error.length),
      ),
      err(7),
    )
    deepEqual(
      await ResultTask.runResult(
        ResultTask.fail('missing').pipe(
          ResultTask.catchAll((error) => ResultTask.succeed(error.length)),
        ),
      ),
      ok(7),
    )
    deepEqual(
      await ResultTask.runResult(
        ResultTask.succeed(1).match({ onSuccess: (value) => value + 1, onFailure: () => 0 }),
      ),
      ok(2),
    )
    deepEqual(
      await ResultTask.runResult(
        ResultTask.err('missing').match({ ok: () => 0, err: (error) => error.length }),
      ),
      ok(7),
    )
    deepEqual(
      await ResultTask.runResult(
        ResultTask.fail('missing').match({ ok: () => 0, error: (error) => error.length }),
      ),
      ok(7),
    )
    expectTypeOf<
      Extract<
        'flatMap' | 'andThen' | 'mapError' | 'catchAll' | 'mapErr' | 'orElse',
        keyof typeof task
      >
    >().toEqualTypeOf<'flatMap' | 'andThen' | 'mapError' | 'catchAll' | 'mapErr' | 'orElse'>()
    expectTypeOf<
      Extract<'ok' | 'err' | 'succeed' | 'fail', keyof typeof ResultTask>
    >().toEqualTypeOf<'ok' | 'err' | 'succeed' | 'fail'>()
  })

  /* eslint-enable typescript/no-deprecated */

  it('preserves tuple successes, services, errors, and deferred release failures', () => {
    const Service = ResultTask.service<{ readonly value: number }>()('Service')
    const task = ResultTask.gen(function* () {
      const service = yield* Service
      if (service.value < 0) return yield* ResultTask.err('invalid' as const)
      return service.value
    })
    const timeout = task.pipe(ResultTask.timeout(10, () => 'timeout' as const))
    const retry = task.pipe(
      ResultTask.retry({ times: 2, while: (error: 'invalid') => error === 'invalid' }),
    )
    expectTypeOf(timeout).toEqualTypeOf<ResultTask<number, 'invalid' | 'timeout', typeof Service>>()
    expectTypeOf(retry).toEqualTypeOf<ResultTask<number, 'invalid', typeof Service>>()
    expectTypeOf(ResultTask.forkChild(task)).toEqualTypeOf<
      ResultTask<FiberHandle<number, 'invalid'>, never, typeof Service | ResultTaskScope<'invalid'>>
    >()
    expectTypeOf(ResultTask.all([task, ResultTask.ok('value')] as const)).toEqualTypeOf<
      ResultTask<[number, string], 'invalid', typeof Service>
    >()
    expectTypeOf(ResultTask.all({ count: task, label: ResultTask.ok('value') })).toEqualTypeOf<
      ResultTask<{ count: number; label: string }, 'invalid', typeof Service>
    >()
    // eslint-disable-next-line unicorn/no-array-for-each -- This is the ResultTask policy, not Array.forEach.
    expectTypeOf(ResultTask.forEach([1], () => task)).toEqualTypeOf<
      ResultTask<number[], 'invalid', typeof Service>
    >()
    expectTypeOf(ResultTask.validateAll([1], () => task)).toEqualTypeOf<
      ResultTask<number[], 'invalid'[], typeof Service>
    >()
    const released = ResultTask.acquireRelease({
      acquire: task,
      release: () => ResultTask.err('release' as const),
    })
    expectTypeOf(released.timeout(10, () => 'timeout' as const)).toEqualTypeOf<
      ResultTask<number, 'invalid' | 'release' | 'timeout', typeof Service>
    >()
    expectTypeOf<Extract<'mapErr' | 'orElse', keyof typeof task>>().toEqualTypeOf<
      'mapErr' | 'orElse'
    >()
    if (false) {
      // @ts-expect-error A missing required service cannot be run.
      void ResultTask.runResult(timeout)
    }
    expectTypeOf(
      Fiber.interrupt({
        join: () => ResultTask.ok(1),
        interrupt: () => ResultTask.ok<Exit<number, never>>({ _tag: 'Success', value: 1 }),
      }),
    ).toEqualTypeOf<ResultTask<Exit<number, never>>>()
  })

  it('infers throw-only continuations without adding unknown services or errors', async () => {
    const source = ResultTask.err({ _tag: 'Missing' } as const)
    const tagged = source.catchTag('Missing', () => {
      throw new Error('handler')
    })
    const recovered = ResultTask.orElse(source, () => {
      throw new Error('handler')
    })
    const chained = ResultTask.andThen(ResultTask.ok(1), () => {
      throw new Error('handler')
    })
    expectTypeOf(tagged).toEqualTypeOf<ResultTask<never>>()
    expectTypeOf(recovered).toEqualTypeOf<ResultTask<never>>()
    expectTypeOf(chained).toEqualTypeOf<ResultTask<never>>()
    equal((await ResultTask.runExit(tagged))._tag, 'Failure')
  })

  it('rejects invalid policy inputs before starting work', () => {
    throws(() => ResultTask.sleep(-1), RangeError)
    throws(() => ResultTask.timeout(ResultTask.ok(1), Number.NaN, () => 'timeout'), RangeError)
    throws(() => ResultTask.ok(1).retry({ times: -1 }), RangeError)
    throws(
      // eslint-disable-next-line unicorn/no-array-for-each -- This is the ResultTask policy, not Array.forEach.
      () => ResultTask.forEach([1], (value) => ResultTask.ok(value), { concurrency: 0 }),
      RangeError,
    )
  })
})
