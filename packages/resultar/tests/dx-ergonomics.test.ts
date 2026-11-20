import { deepEqual, equal, ok as assertOk, throws } from 'node:assert'
import { inspect } from 'node:util'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import {
  Cause,
  Clock,
  err,
  errAsync,
  ok,
  okAsync,
  ResultAsync,
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
        return ResultTask.fail<RateLimited>({ retryAfterMs: 50 })
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
      return ResultTask.fail('unavailable' as const)
    }).retry(policy)

    const exit = await clock.runToCompletion(task)
    deepEqual(exit, { _tag: 'Failure', cause: Cause.fail('unavailable') })
    // t=0 fail -> sleep 60 (total 60 <= 150); t=60 fail -> sleep 60 (total 120 <= 150); t=120 fail -> +60=180 > 150 -> stop
    equal(attempts, 3)
    equal(clock.now(), 120)
  })

  it('passes error into Retry.policy delayMs in ResultAsync.retry', async () => {
    const seenErrors: string[] = []
    let attempts = 0
    const policy = Retry.policy<string>({
      times: 2,
      delayMs: (_ctx, error) => {
        seenErrors.push(error)
        return 0
      },
    })

    const result = await ResultAsync.retry(() => {
      attempts += 1
      return attempts < 3 ? errAsync(`fail-${attempts}`) : okAsync('done')
    }, policy)

    deepEqual(result, ok('done'))
    deepEqual(seenErrors, ['fail-1', 'fail-2'])
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
      return failCalls === 2 ? ResultTask.fail('boom' as const) : ResultTask.ok(failCalls)
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
    deepEqual(ResultTask.runSyncExit(ResultTask.fail('nope' as const)), {
      _tag: 'Failure',
      cause: Cause.fail('nope'),
    })
    deepEqual(ResultTask.runSync(ResultTask.fail('nope' as const)), err('nope'))

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
      }).flatMap(() => ResultTask.sleep(ms).as(name))

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
        ResultTask.sleep(10).flatMap(() => ResultTask.fail('early-err' as const)),
        ResultTask.sleep(50).as('late-ok'),
      ]),
    )
    deepEqual(firstExit, { _tag: 'Failure', cause: Cause.fail('early-err') })

    throws(() => ResultTask.raceAll([]), RangeError)
    throws(() => ResultTask.raceFirstAll([]), RangeError)
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
