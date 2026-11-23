import { deepEqual, equal, ok as assertOk, throws } from 'node:assert'
import { inspect } from 'node:util'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import {
  type Exit,
  Cause,
  Clock,
  err,
  ok,
  ResultTask,
  ResultTaskCauseError,
  Retry,
} from '../src/index.js'

describe('DX ergonomics and asymmetries', () => {
  it('provides Cause constructors and isInterruptedOnly', () => {
    const failCause = Cause.fail('bad-input' as const)
    const dieCause = Cause.die(new Error('boom'))
    const intCause = Cause.interrupt('cancelled')
    const seqCause = Cause.sequential(failCause, dieCause)
    const parInt = Cause.parallel(Cause.interrupt('a'), Cause.interrupt('b'))

    equal(Cause.isCause(failCause), true)
    equal(Cause.isCause(seqCause), true)
    equal(Cause.isInterruptedOnly(intCause), true)
    equal(Cause.isInterruptedOnly(parInt), true)
    equal(Cause.isInterruptedOnly(failCause), false)
    equal(Cause.isInterruptedOnly(Cause.sequential(intCause, failCause)), false)
    deepEqual(Cause.failures(seqCause), ['bad-input'])
    equal(Cause.defects(seqCause).length, 1)
  })

  it('formats ResultTaskCauseError with prettyCause and custom inspect', () => {
    const composite = Cause.parallel(Cause.fail('primary'), Cause.fail('replica'))
    const error = new ResultTaskCauseError(composite)

    assertOk(error.message.includes('ResultTask execution failed with multiple causes'))
    assertOk(error.message.includes('Fail: primary'))
    assertOk(error.message.includes('Fail: replica'))
    equal(error.prettyCause, 'Fail: primary\nFail: replica')
    assertOk(inspect(error).includes('Fail: primary'))
  })

  it('supports error-aware delayMs, maxDelayMs, and maxElapsedMs on Retry.policy', async () => {
    const clock = Clock.virtual(0, () => 1)
    const observedDelays: number[] = []
    let attempts = 0

    interface RateLimited {
      readonly retryAfterMs: number
    }

    const policy = Retry.policy<RateLimited>({
      times: 5,
      delayMs: (_ctx, error) => error.retryAfterMs,
      backoff: 2,
      maxDelayMs: 120,
      jittered: 0.5,
      onRetry: (_error, ctx) => {
        observedDelays.push(ctx.attempt)
      },
    })

    const task = ResultTask.suspend(() => {
      attempts += 1
      if (attempts <= 3) {
        return ResultTask.err<RateLimited>({ retryAfterMs: 50 })
      }
      return ResultTask.ok('ok')
    }).retry(policy)

    const exit = await clock.runToCompletion(task)
    deepEqual(exit, { _tag: 'Success', value: 'ok' })
    equal(attempts, 4)
    deepEqual(observedDelays, [0, 1, 2])
    // Attempt 0: base 50, jitter(1) -> 75; Attempt 1: 100 -> jitter 150 capped at 120; Attempt 2: 200 capped at 120
    equal(clock.now(), 75 + 120 + 120)
  })

  it('stops retrying when maxElapsedMs budget is exhausted', async () => {
    const clock = Clock.virtual(0)
    let attempts = 0
    const policy = Retry.policy({ times: 10, delayMs: 60, maxElapsedMs: 150 })

    const task = ResultTask.suspend(() => {
      attempts += 1
      return ResultTask.err('unavailable' as const)
    }).retry(policy)

    const exit = await clock.runToCompletion(task)
    deepEqual(exit, { _tag: 'Failure', cause: Cause.fail('unavailable') })
    // t=0 fail -> sleep 60 (total 60 <= 150); t=60 fail -> sleep 60 (total 120 <= 150); t=120 fail -> +60=180 > 150 -> stop
    equal(attempts, 3)
    equal(clock.now(), 120)
  })

  it('repeats succeeding tasks with until, while, delay, and scope cleanup', async () => {
    const clock = Clock.virtual(0)
    const released: number[] = []
    let count = 0

    const polled = ResultTask.acquireRelease({
      acquire: ResultTask.sync(() => {
        count += 1
        return count
      }),
      release: (id) =>
        ResultTask.sync(() => {
          released.push(id)
        }),
    })
      .map((id) => (id >= 3 ? 'ready' : 'pending'))
      .repeat({ times: 10, delayMs: 25, until: (status) => status === 'ready' })

    const exit = await clock.runToCompletion(polled)
    deepEqual(exit, { _tag: 'Success', value: 'ready' })
    deepEqual(released, [1, 2, 3])
    equal(clock.now(), 50)
  })

  it('supports curried ResultTask.repeat, sync repeat, and stops immediately on failure', () => {
    let calls = 0
    const syncRepeated = ResultTask.sync(() => {
      calls += 1
      return calls
    }).pipe(ResultTask.repeat({ times: 3 }))

    deepEqual(syncRepeated.runSync(), ok(4))
    equal(calls, 4)

    let failCalls = 0
    const failing = ResultTask.suspend(() => {
      failCalls += 1
      return failCalls === 2 ? ResultTask.err('boom' as const) : ResultTask.ok(failCalls)
    }).repeat({ times: 5 })

    deepEqual(failing.runSync(), err('boom'))
    equal(failCalls, 2)
  })

  it('provides fluent scoped(), forkChild(), and fiber.await()', async () => {
    const log: string[] = []
    const program = ResultTask.gen(function* () {
      const resource = yield* ResultTask.acquireRelease({
        acquire: ResultTask.ok('conn'),
        release: () =>
          ResultTask.sync(() => {
            log.push('closed')
          }),
      })
      const child = yield* ResultTask.ok(`${resource}:child`).forkChild()
      const childExit = yield* child.await()
      return childExit._tag === 'Success' ? childExit.value : 'unexpected'
    }).scoped()

    const result = await program.runResult()
    deepEqual(result, ok('conn:child'))
    deepEqual(log, ['closed'])
  })

  it('executes synchronous workflows via runSync and runSyncExit', () => {
    const ConfigTag = ResultTask.service<{ readonly factor: number }, 'Config'>('Config')

    const syncWorkflow = ResultTask.gen(function* () {
      const cfg = yield* ConfigTag
      let total = 0
      for (let index = 0; index < 3000; index += 1) {
        total += yield* ResultTask.ok(1)
      }
      return total * cfg.factor
    })

    deepEqual(syncWorkflow.runSync({ services: { Config: { factor: 2 } } }), ok(6000))
    deepEqual(ResultTask.runSyncExit(ResultTask.err('nope' as const)), {
      _tag: 'Failure',
      cause: Cause.fail('nope'),
    })
    deepEqual(ResultTask.runSync(ResultTask.err('nope' as const)), err('nope'))

    throws(
      () => ResultTask.sleep(10).runSync(),
      /ResultTask\.runSync cannot execute an asynchronous task/u,
    )
  })

  it('races arbitrary iterables with raceAll and raceFirstAll', async () => {
    const clock = Clock.virtual(0)
    const cancelled: string[] = []

    const makeBranch = (name: string, ms: number) =>
      ResultTask.acquireRelease({
        acquire: ResultTask.ok(name),
        release: () =>
          ResultTask.sync(() => {
            cancelled.push(name)
          }),
      }).andThen(() => ResultTask.sleep(ms).as(name))

    const winnerExit = await clock.runToCompletion(
      ResultTask.raceAll([
        makeBranch('slow', 100),
        makeBranch('fast', 20),
        makeBranch('medium', 50),
      ]),
    )
    deepEqual(winnerExit, { _tag: 'Success', value: 'fast' })
    equal(clock.now(), 20)
    equal(cancelled.length, 3)

    const typedRace = ResultTask.raceAll([ResultTask.ok(1 as const), ResultTask.ok('two' as const)])
    expectTypeOf(typedRace).toEqualTypeOf<ResultTask<1 | 'two', never, never>>()

    const firstFailureClock = Clock.virtual(0)
    const firstExit = await firstFailureClock.runToCompletion(
      ResultTask.raceFirstAll([
        ResultTask.sleep(10).andThen(() => ResultTask.err('early-err' as const)),
        ResultTask.sleep(50).as('late-ok'),
      ]),
    )
    deepEqual(firstExit, { _tag: 'Failure', cause: Cause.fail('early-err') })

    throws(() => ResultTask.raceAll([]), RangeError)
    throws(() => ResultTask.raceFirstAll([]), RangeError)
  })

  it.each([
    [100, 1],
    [1, 100],
    [1, 1],
  ])('drives shared deadlines %i and %i in time order', async (a, b) => {
    const clock = Clock.virtual()
    const tasks = [a, b].map((ms) =>
      clock.runToCompletion(
        ResultTask.sleep(ms)
          .andThen(() => ResultTask.sleep(1))
          .map(() => clock.now()),
        { maxSteps: 2 },
      ),
    )
    deepEqual(
      await Promise.all(tasks),
      [a, b].map((ms) => ({ _tag: 'Success', value: ms + 1 })),
    )
  })

  it('flushes scheduled work from peer drivers before advancing virtual time', async () => {
    const clock = Clock.virtual()
    let work = ResultTask.ok(0)
    for (let i = 0; i < 40; i += 1) work = work.map((n) => n + 1)
    const end = await Promise.all([
      clock.runToCompletion(ResultTask.sleep(100).map(() => clock.now())),
      clock.runToCompletion(
        work.andThen(() => ResultTask.sleep(1)).map(() => clock.now()),
        { yieldEvery: 1 },
      ),
    ])
    deepEqual(end, [
      { _tag: 'Success', value: 100 },
      { _tag: 'Success', value: 1 },
    ])
  })

  it('runs immediate retry and repeat predicates, observers and delay functions synchronously', () => {
    deepEqual(
      ResultTask.err('offline')
        .retry(Retry.policy({ times: 1, while: () => false }))
        .runSync(),
      err('offline'),
    )
    let attempts = 0
    const observations: number[] = []
    const repeated = ResultTask.sync(() => {
      attempts += 1
      return attempts
    }).repeat({
      times: 5,
      delayMs: () => 0,
      while: () => true,
      until: (n) => n === 3,
      onRepeat: (n) => {
        observations.push(n)
      },
    })
    deepEqual(repeated.runSync(), ok(3))
    deepEqual(observations, [1, 2])
    throws(
      () =>
        ResultTask.ok(1)
          .repeat({ times: 1, until: () => Promise.resolve(true) })
          .runSync(),
      /asynchronous/u,
    )
    throws(
      () =>
        ResultTask.err('x')
          .retry(Retry.policy({ times: 1, delayMs: 1 }))
          .runSync(),
      /asynchronous/u,
    )
  })

  it('isolates concurrent clock drivers and supplies required services', async () => {
    const clock = Clock.virtual()
    const name = ResultTask.service<string, 'name'>('name')
    const read = ResultTask.gen(function* () {
      yield* ResultTask.sleep(3)
      return yield* name
    })
    const results = await Promise.allSettled([
      clock.runToCompletion(ResultTask.sleep(1).repeat({ times: 10 }), { maxSteps: 1 }),
      clock.runToCompletion(read, { services: { name: 'ready' }, maxSteps: 1 }),
    ])
    equal(results[0]?.status, 'rejected')
    deepEqual(results[1], { status: 'fulfilled', value: { _tag: 'Success', value: 'ready' } })
    equal(clock.pending, 0)
  })

  it('caps exponential retry delays before overflow', async () => {
    const clock = Clock.virtual()
    const policy = Retry.policy({ times: 4, delayMs: 1, backoff: Number.MAX_VALUE, maxDelayMs: 5 })
    const exit = await clock.runToCompletion(ResultTask.err('failed').retry(policy))
    equal(exit._tag, 'Failure')
    equal(clock.now(), 16)
  })

  it('runs pure collection workers and a zero-delay repeat synchronously', () => {
    // eslint-disable-next-line unicorn/no-array-for-each -- Exercises the Task collection operator.
    const collection = ResultTask.forEach([1, 2, 3], (n) => ResultTask.sync(() => n * 2), {
      concurrency: 2,
    })
    deepEqual(collection.repeat({ times: 1, delayMs: 0 }).runSync(), ok([2, 4, 6]))
  })

  it.each([{ times: 1 }, { times: 1, until: () => false }])(
    'honors a custom clock’s zero-delay sleep when repeating with %j',
    async (options) => {
      const clock = Clock.virtual()
      let runs = 0
      const task = ResultTask.sync(() => {
        runs += 1
        return runs
      }).repeat(options)

      throws(() => task.runSync({ clock }), /asynchronous/u)
      equal(runs, 1)
      equal(clock.pending, 0)

      const next = task.runResult({ clock })
      equal(runs, 2)
      equal(await clock.advanceToNext(), true)
      deepEqual(await next, ok(3))
    },
  )

  it('stops a synchronous iterate body after cancellation', async () => {
    const controller = new AbortController()
    const calls: number[] = []
    const task = ResultTask.iterate(0, {
      while: (value) => value < 100,
      body: (value) => {
        calls.push(value)
        controller.abort('stop')
        return ok(value + 1)
      },
    })

    deepEqual(await task.runExit({ signal: controller.signal, yieldEvery: 1 }), {
      _tag: 'Failure',
      cause: Cause.interrupt('stop'),
    })
    deepEqual(calls, [0])
  })

  it('yields between synchronous iterate steps so other work can interrupt', async () => {
    const controller = new AbortController()
    let calls = 0
    const running = ResultTask.iterate(0, {
      while: (value) => value < 100,
      body: (value) => {
        calls += 1
        return ok(value + 1)
      },
    }).runExit({
      signal: controller.signal,
      yieldEvery: 8,
      scheduler: {
        yield: () => {
          controller.abort('scheduled stop')
          return Promise.resolve()
        },
      },
    })
    deepEqual(await running, { _tag: 'Failure', cause: Cause.interrupt('scheduled stop') })
    assertOk(calls > 0 && calls < 100)
  })

  it.each(['loop', 'firstSuccessOf'] as const)(
    'schedules synchronous %s steps and closes interrupted iteration',
    async (operator) => {
      let calls = 0
      let closed = false
      const controller = new AbortController()
      const body = (n: number) => {
        calls += 1
        return ok(n)
      }
      function* candidates() {
        try {
          for (let i = 0; i < 100; i += 1) {
            calls += 1
            yield err(i)
          }
        } finally {
          closed = true
        }
      }
      const task: ResultTask<readonly number[], number> =
        operator === 'loop'
          ? ResultTask.loop(0, { while: (n) => n < 100, step: (n) => n + 1, body })
          : ResultTask.firstSuccessOf(candidates())
      const exit = await task.runExit({
        signal: controller.signal,
        yieldEvery: 8,
        scheduler: {
          yield: () => {
            controller.abort('stop')
            return Promise.resolve()
          },
        },
      })
      deepEqual(exit, { _tag: 'Failure', cause: Cause.interrupt('stop') })
      assertOk(calls > 0 && calls < 100)
      if (operator === 'firstSuccessOf') equal(closed, true)
    },
  )

  it('preserves the typed failure payload when runPromise rejects', async () => {
    const reason = { code: 123 }
    const task = ResultTask.err(reason)
    for (const run of [
      task.runPromise(),
      ResultTask.runPromise(task, {}),
      ResultTask.ok(0)
        .andThen(() => task)
        .runPromise(),
    ]) {
      equal(await run.catch((error: unknown) => error), reason)
    }
  })

  it('supports VirtualClock.advanceToNext and runToCompletion maxSteps guard', async () => {
    const clock = Clock.virtual(0)
    const events: number[] = []

    const fiber = ResultTask.gen(function* () {
      yield* ResultTask.sleep(10)
      events.push(clock.now())
      yield* ResultTask.sleep(25)
      events.push(clock.now())
      return 'done'
    }).runFork({ clock })

    equal(await clock.advanceToNext(), true)
    deepEqual(events, [10])
    equal(await clock.advanceToNext(), true)
    deepEqual(events, [10, 35])
    equal(await clock.advanceToNext(), false)
    deepEqual(await fiber.await().runPromise(), { _tag: 'Success', value: 'done' })

    const guardClock = Clock.virtual(0)
    let guardError: unknown = undefined
    try {
      await guardClock.runToCompletion(ResultTask.sleep(1).repeat({ times: 10 }), { maxSteps: 2 })
    } catch (error) {
      guardError = error
    }
    assertOk(guardError instanceof RangeError)
  })
})

it('keeps composite errors out of an exhausted catchReason error channel', () => {
  const problem = { _tag: 'Outer', reason: { _tag: 'Only' } } as const
  const failure = ResultTask.err(problem)
  for (const task of [
    failure.ensuring(() => failure),
    ResultTask.err(Cause.parallel(Cause.fail(problem), Cause.fail(problem))).unsandbox(),
  ]) {
    const exit = task.catchReason('Outer', 'Only', () => ok(1)).runSyncExit()
    expectTypeOf(exit).toEqualTypeOf<Exit<number, never>>()
    assertOk(exit._tag === 'Failure' && exit.cause._tag === 'Die')
    assertOk(exit.cause.defect instanceof ResultTaskCauseError)
  }
})

it('reports invalid matched reason handlers as defects and preserves unmatched reasons', () => {
  const problem = { _tag: 'Outer', reason: { _tag: 'Only' } } as const
  const failure = ResultTask.err(problem)
  const invalidHandler = (() => undefined) as never
  for (const task of [
    failure.catchReason('Outer', 'Only', invalidHandler),
    failure.catchReasons('Outer', { Only: invalidHandler }),
  ]) {
    const exit = task.runSyncExit()
    expectTypeOf(exit).toEqualTypeOf<Exit<never, never>>()
    assertOk(exit._tag === 'Failure' && exit.cause._tag === 'Die')
    assertOk(exit.cause.defect instanceof TypeError)
  }
  deepEqual(failure.catchReasons('Outer', {}).runSyncExit(), failure.runSyncExit())
})

it('runs synchronous disposers and ignores non-Promise return values from observers', () => {
  let disposed = 0
  const resource = {
    [Symbol.dispose]() {
      disposed += 1
    },
  }
  deepEqual(ResultTask.acquireDisposable(ResultTask.ok(resource)).runSync(), ok(resource))
  equal(disposed, 1)
  const seen: number[] = []
  const observer: (value: number) => void = (value) => seen.push(value)
  deepEqual(ResultTask.ok(1).repeat({ times: 1, onRepeat: observer }).runSync(), ok(1))
  deepEqual(seen, [1])
})
