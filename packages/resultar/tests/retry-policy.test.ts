import { deepEqual, equal, rejects, throws } from 'node:assert'
import { describe, expectTypeOf, it, vi } from 'vite-plus/test'

import {
  type AbortError,
  Clock,
  err,
  isAbortError,
  ok,
  ResultAsync,
  ResultTask,
  type ResultTaskScope,
} from '../src/index.js'
import { Retry, type RetryContext, type RetryPolicy } from '../src/core/retry.js'

describe('portable retry policies', () => {
  it('copies and freezes configuration without retaining attempt state', async () => {
    const options = { times: 1 }
    const policy = Retry.policy(options)
    options.times = 0
    equal(policy.times, 1)
    equal(Object.isFrozen(policy), true)
    let attempts = 0
    const task = ResultTask.sync(() => {
      attempts += 1
      return attempts - 1
    })
      .andThen((attempt) =>
        attempt % 2 === 0 ? ResultTask.err('offline' as const) : ResultTask.ok(attempt),
      )
      .retry(policy)

    deepEqual(await ResultTask.runResult(task), ok(1))
    deepEqual(await ResultTask.runResult(task), ok(3))
    equal(attempts, 4)
  })

  it('shares contexts and async callbacks while preserving eager and lazy execution', async () => {
    const predicates: RetryContext[] = []
    const observations: RetryContext[] = []
    const delays: RetryContext[] = []
    const policy = Retry.policy<'offline'>({
      times: 2,
      while: async (error, context) => {
        equal(error, 'offline')
        predicates.push(context)
        return true
      },
      onRetry: async (_error, context) => {
        observations.push(context)
      },
      delayMs: (context) => {
        delays.push(context)
        return 0
      },
    })
    let eagerAttempts = 0
    const eager = ResultAsync.retry((attempt) => {
      eagerAttempts += 1
      return attempt < 2
        ? ResultAsync.errAsync<number, 'offline'>('offline')
        : ResultAsync.okAsync<number, 'offline'>(attempt)
    }, policy)
    expectTypeOf(eager).toEqualTypeOf<ResultAsync<number, 'offline' | AbortError>>()
    equal(eagerAttempts, 1)
    deepEqual(await eager, ok(2))
    const expected = [
      { attempt: 0, nextAttempt: 1, retriesRemaining: 2 },
      { attempt: 1, nextAttempt: 2, retriesRemaining: 1 },
    ]
    deepEqual(predicates, expected)
    deepEqual(observations, expected)
    deepEqual(delays, expected)
    predicates.length = 0
    observations.length = 0
    delays.length = 0

    let lazyAttempts = 0
    const lazy = ResultTask.sync(() => {
      lazyAttempts += 1
      return lazyAttempts - 1
    })
      .andThen((attempt) =>
        attempt < 2 ? ResultTask.err('offline' as const) : ResultTask.ok(attempt),
      )
      .retry(policy)
    equal(lazyAttempts, 0)
    deepEqual(await ResultTask.runResult(lazy), ok(2))
    deepEqual(predicates, expected)
    deepEqual(observations, expected)
    deepEqual(delays, expected)
  })

  it('uses the same numeric jitter and backoff with each runtime random source', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.25)
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    const policy = Retry.policy({ times: 2, delayMs: 100, backoff: 2, jittered: 0.5 })
    try {
      const running = ResultAsync.retry(
        (attempt) =>
          attempt < 2
            ? ResultAsync.errAsync<number, 'offline'>('offline')
            : ResultAsync.okAsync<number, 'offline'>(attempt),
        policy,
      )
      await vi.runAllTimersAsync()
      deepEqual(await running, ok(2))
      deepEqual(
        timeout.mock.calls.map((call) => call[1]),
        [75, 150],
      )
    } finally {
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
    const delays: number[] = []
    const clock = {
      randomValue: 0.25,
      now: () => 0,
      random(): number {
        return this.randomValue
      },
      sleep: (delay: number): Promise<void> => {
        delays.push(delay)
        return Promise.resolve()
      },
    }
    let attempt = 0
    const task = ResultTask.sync(() => {
      attempt += 1
      return attempt - 1
    })
      .andThen((current) => (current < 2 ? ResultTask.err('offline') : ResultTask.ok(current)))
      .retry(policy)
    deepEqual(await ResultTask.runResult(task, { clock }), ok(2))
    deepEqual(delays, [75, 150])
  })

  it('does not invoke canonical predicates or observers after exhaustion', async () => {
    let predicates = 0
    let observations = 0
    const policy = Retry.policy({
      times: 0,
      while: async () => {
        predicates += 1
        return true
      },
      onRetry: () => {
        observations += 1
      },
    })
    deepEqual(
      await ResultAsync.retry(() => ResultAsync.errAsync('offline'), policy),
      err('offline'),
    )
    deepEqual(await ResultTask.runResult(ResultTask.err('offline').retry(policy)), err('offline'))
    equal(predicates, 0)
    equal(observations, 0)
  })

  it('awaits async predicates and ignores observer failures in both models', async () => {
    const events: string[] = []
    const policy = Retry.policy({
      times: 1,
      while: async (_error, context) => {
        await Promise.resolve()
        events.push(`while:${context.attempt}`)
        return true
      },
      onRetry: async (_error, context) => {
        events.push(`observe:${context.attempt}`)
        throw new Error('observer')
      },
    })
    deepEqual(
      await ResultAsync.retry(
        (attempt) =>
          attempt === 0 ? ResultAsync.errAsync('offline') : ResultAsync.okAsync('ready'),
        policy,
      ),
      ok('ready'),
    )
    let attempt = 0
    const task = ResultTask.sync(() => {
      attempt += 1
      return attempt - 1
    })
      .andThen((current) => (current === 0 ? ResultTask.err('offline') : ResultTask.ok('ready')))
      .retry(policy)
    deepEqual(await ResultTask.runResult(task), ok('ready'))
    deepEqual(events, ['while:0', 'observe:0', 'while:0', 'observe:0'])
  })

  it('preserves unexpected predicate rejection outside the typed error channel', async () => {
    const defect = new Error('predicate')
    const policy = Retry.policy({ times: 1, while: () => Promise.reject(defect) })
    await rejects(
      async () => await ResultAsync.retry(() => ResultAsync.errAsync('offline'), policy),
      defect,
    )
    deepEqual(await ResultTask.runExit(ResultTask.err('offline').retry(policy)), {
      _tag: 'Failure',
      cause: { _tag: 'Die', defect },
    })
  })

  it('closes Task attempt scopes before predicate, observer, and delay callbacks', async () => {
    const events: string[] = []
    let attempt = 0
    const task = ResultTask.gen(function* () {
      const current = yield* ResultTask.acquireRelease({
        acquire: ResultTask.sync(() => {
          events.push(`attempt:${attempt}`)
          attempt += 1
          return attempt - 1
        }),
        release: (value) =>
          ResultTask.sync(() => {
            events.push(`release:${value}`)
          }),
      })
      if (current === 0) return yield* ResultTask.err('offline' as const)
      return current
    }).retry(
      Retry.policy({
        times: 1,
        while: async (_error, context) => {
          events.push(`while:${context.attempt}`)
          return true
        },
        onRetry: (_error, context) => {
          events.push(`observe:${context.attempt}`)
        },
        delayMs: (context) => {
          events.push(`delay:${context.attempt}`)
          return 0
        },
      }),
    )
    deepEqual(await ResultTask.runResult(task), ok(1))
    deepEqual(events, [
      'attempt:0',
      'release:0',
      'while:0',
      'observe:0',
      'delay:0',
      'attempt:1',
      'release:1',
    ])
  })

  it('does not retry Task defects or composite body and release failures', async () => {
    let observations = 0
    const policy = Retry.policy({
      times: 3,
      onRetry: () => {
        observations += 1
      },
    })
    const defect = new Error('bug')
    const failed = ResultTask.sync(() => {
      throw defect
    }).retry(policy)
    deepEqual(await ResultTask.runExit(failed), { _tag: 'Failure', cause: { _tag: 'Die', defect } })
    const composite = ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.ok(undefined),
        release: () => ResultTask.err('release'),
      })
      return yield* ResultTask.err('body')
    }).retry(policy)
    deepEqual(await ResultTask.runExit(composite), {
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Fail', error: 'body' },
        right: { _tag: 'Fail', error: 'release' },
      },
    })
    equal(observations, 0)
  })

  it('preserves cancellation during canonical Task backoff', async () => {
    const clock = Clock.virtual()
    const controller = new AbortController()
    let attempts = 0
    const task = ResultTask.sync(() => {
      attempts += 1
    })
      .andThen(() => ResultTask.err('offline'))
      .retry(Retry.policy({ times: 2, delayMs: 10 }))
    const running = ResultTask.runExit(task, { clock, signal: controller.signal })
    await clock.flush()
    controller.abort('stop')
    const exit = await running
    equal(exit._tag, 'Failure')
    equal(attempts, 1)
    equal(clock.pending, 0)
  })

  it.each(['while', 'onRetry'] as const)(
    'times out a pending canonical %s hook after attempt cleanup and consumes late rejection',
    async (hook) => {
      const clock = Clock.virtual()
      const predicate = Promise.withResolvers<boolean>()
      const observer = Promise.withResolvers<void>()
      const events: string[] = []
      const policy = Retry.policy({
        times: 2,
        while: () => {
          events.push('while')
          return hook === 'while' ? predicate.promise : true
        },
        onRetry: () => {
          events.push('onRetry')
          return hook === 'onRetry' ? observer.promise : undefined
        },
        delayMs: () => {
          events.push('delay')
          return 0
        },
      })
      const task = ResultTask.gen(function* () {
        yield* ResultTask.acquireRelease({
          acquire: ResultTask.sync(() => {
            events.push('attempt')
          }),
          release: () =>
            ResultTask.sync(() => {
              events.push('release')
            }),
        })
        return yield* ResultTask.err('offline')
      })
        .retry(policy)
        .timeout(5, () => 'timed-out')
      const running = ResultTask.runResult(task, { clock })
      await clock.flush()
      const expected =
        hook === 'while'
          ? ['attempt', 'release', 'while']
          : ['attempt', 'release', 'while', 'onRetry']
      deepEqual(events, expected)
      await clock.advanceBy(5)
      deepEqual(await running, err('timed-out'))
      if (hook === 'while') predicate.reject(new Error('late predicate'))
      else observer.reject(new Error('late observer'))
      await new Promise<void>((resolve) => {
        setImmediate(resolve)
      })
      deepEqual(events, expected)
      equal(clock.pending, 0)
    },
  )

  it.each(['while', 'onRetry'] as const)(
    'interrupts a pending canonical %s hook and ignores late success without another retry',
    async (hook) => {
      const clock = Clock.virtual()
      const controller = new AbortController()
      const predicate = Promise.withResolvers<boolean>()
      const observer = Promise.withResolvers<void>()
      const events: string[] = []
      const policy = Retry.policy({
        times: 2,
        while: () => {
          events.push('while')
          return hook === 'while' ? predicate.promise : true
        },
        onRetry: () => {
          events.push('onRetry')
          return hook === 'onRetry' ? observer.promise : undefined
        },
        delayMs: () => {
          events.push('delay')
          return 0
        },
      })
      const task = ResultTask.sync(() => {
        events.push('attempt')
      })
        .andThen(() => ResultTask.err('offline'))
        .retry(policy)
      const running = ResultTask.runExit(task, { clock, signal: controller.signal })
      await clock.flush()
      controller.abort('stop')
      deepEqual(await running, { _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'stop' } })
      predicate.resolve(true)
      observer.resolve()
      await clock.flush()
      deepEqual(events, hook === 'while' ? ['attempt', 'while'] : ['attempt', 'while', 'onRetry'])
      equal(clock.pending, 0)
    },
  )

  it('stops after a false canonical predicate without running the observer or delay', async () => {
    const events: string[] = []
    const policy = Retry.policy({
      times: 2,
      while: async () => {
        events.push('while')
        return false
      },
      onRetry: () => {
        events.push('onRetry')
      },
      delayMs: () => {
        events.push('delay')
        return 0
      },
    })
    deepEqual(await ResultTask.runResult(ResultTask.err('offline').retry(policy)), err('offline'))
    deepEqual(events, ['while'])
  })

  it('preserves the policy brand when adding Async signal or fallback options', async () => {
    const policy = Retry.policy({ times: 1 })
    const controller = new AbortController()
    controller.abort('stop')
    const aborted = await ResultAsync.retry(() => ResultAsync.okAsync(1), {
      // eslint-disable-next-line oxc/no-rest-spread-properties -- Verify JavaScript spread preserves the canonical policy brand.
      ...policy,
      signal: controller.signal,
    })
    equal(aborted.isErr() && isAbortError(aborted.error), true)
    const result = ResultAsync.retryOrElse(
      () => ResultAsync.errAsync<number, 'offline'>('offline'),
      {
        // eslint-disable-next-line oxc/no-rest-spread-properties -- Verify JavaScript spread preserves the canonical policy brand.
        ...policy,
        orElse: (error, context) => {
          expectTypeOf(error).toEqualTypeOf<'offline'>()
          equal(context.attempt, 1)
          return ok('cached')
        },
      },
    )
    expectTypeOf(result).toEqualTypeOf<ResultAsync<number | string, AbortError>>()
    deepEqual(await result, ok('cached'))
  })

  it('preserves Task legacy retry numbers, error arguments, and full boolean jitter', async () => {
    const delays: number[] = []
    const delayArguments: [number, string][] = []
    const predicateArguments: [string, number][] = []
    const clock = {
      now: () => 0,
      random: () => 0.25,
      sleep: async (delay: number) => {
        delays.push(delay)
      },
    }
    let attempt = 0
    const task = ResultTask.sync(() => {
      attempt += 1
      return attempt - 1
    })
      .andThen((current) => (current < 2 ? ResultTask.err('offline') : ResultTask.ok(current)))
      .retry({
        times: 2,
        delayMs: (retry, error) => {
          delayArguments.push([retry, error])
          return 10
        },
        backoff: 2,
        jittered: true,
        while: (error, retry) => {
          predicateArguments.push([error, retry])
          return true
        },
      })
    deepEqual(await ResultTask.runResult(task, { clock }), ok(2))
    deepEqual(delayArguments, [
      [1, 'offline'],
      [2, 'offline'],
    ])
    deepEqual(predicateArguments, [
      ['offline', 1],
      ['offline', 2],
    ])
    deepEqual(delays, [2.5, 5])
  })

  it('preserves Async legacy context callbacks even on the exhausted failure', async () => {
    const predicates: RetryContext[] = []
    const delays: RetryContext[] = []
    deepEqual(
      await ResultAsync.retry(() => ResultAsync.errAsync('offline'), {
        times: 1,
        while: (_error, context) => {
          predicates.push(context)
          return true
        },
        delayMs: (context) => {
          delays.push(context)
          return 0
        },
      }),
      err('offline'),
    )
    deepEqual(predicates, [
      { attempt: 0, nextAttempt: 1, retriesRemaining: 1 },
      { attempt: 1, nextAttempt: 2, retriesRemaining: 0 },
    ])
    deepEqual(delays, [{ attempt: 0, nextAttempt: 1, retriesRemaining: 1 }])
  })

  it('preserves inferred Task errors and services with direct, instance, and curried policies', () => {
    const Service = ResultTask.service<{ readonly value: number }>()('RetryService')
    const task = ResultTask.gen(function* () {
      const service = yield* Service
      if (service.value < 0) return yield* ResultTask.err('offline' as const)
      return service.value
    })
    const policy = Retry.policy({ times: 2 })
    expectTypeOf(task.retry(policy)).toEqualTypeOf<ResultTask<number, 'offline', typeof Service>>()
    expectTypeOf(ResultTask.retry(task, policy)).toEqualTypeOf<
      ResultTask<number, 'offline', typeof Service>
    >()
    expectTypeOf(task.pipe(ResultTask.retry(policy))).toEqualTypeOf<
      ResultTask<number, 'offline', typeof Service>
    >()
    const resource = ResultTask.acquireRelease({
      acquire: ResultTask.ok(1),
      release: () => ResultTask.err('release' as const),
    })
    expectTypeOf(resource.retry(policy)).toEqualTypeOf<ResultTask<number, 'release'>>()
    expectTypeOf(resource.pipe(ResultTask.retry(policy))).toEqualTypeOf<
      ResultTask<number, 'release'>
    >()
    const contexts = Retry.policy<'offline'>({
      times: 1,
      while: (_error, context) => {
        expectTypeOf(context).toEqualTypeOf<RetryContext>()
        return true
      },
    })
    expectTypeOf(contexts).toEqualTypeOf<RetryPolicy<'offline'>>()
  })

  it('validates canonical timings while preserving legacy validation boundaries', async () => {
    throws(() => Retry.policy({ times: -1 }), RangeError)
    throws(() => Retry.policy({ times: Number.MAX_SAFE_INTEGER + 1 }), RangeError)
    throws(() => Retry.policy({ times: 1, delayMs: -1 }), RangeError)
    throws(() => Retry.policy({ times: 1, backoff: 0.5 }), RangeError)
    throws(() => Retry.policy({ times: 1, jittered: Infinity }), RangeError)
    const invalidDelay = Retry.policy({ times: 1, delayMs: () => -1 })
    await rejects(
      async () => await ResultAsync.retry(() => ResultAsync.errAsync('offline'), invalidDelay),
      RangeError,
    )
    const taskExit = await ResultTask.runExit(ResultTask.err('offline').retry(invalidDelay))
    equal(
      taskExit._tag === 'Failure' &&
        taskExit.cause._tag === 'Die' &&
        taskExit.cause.defect instanceof RangeError,
      true,
    )
    const policy = Retry.policy({ times: 1 })
    // eslint-disable-next-line oxc/no-rest-spread-properties -- Verify execution validates a spread policy with changed timings.
    const invalid = { ...policy, times: -1 }
    await rejects(
      async () => await ResultAsync.retry(() => ResultAsync.errAsync('offline'), invalid),
      RangeError,
    )
    throws(() => ResultTask.err('offline').retry(invalid), RangeError)
  })
})

const typeAssertions = (): void => {
  const wrong = Retry.policy<'other'>({ times: 1, while: (error) => error === 'other' })
  // @ts-expect-error Portable predicates must accept the operation's error channel.
  void ResultAsync.retry(() => ResultAsync.errAsync<number, 'offline'>('offline'), wrong)
  // @ts-expect-error Portable predicates must accept the Task error channel.
  void ResultTask.err('offline' as const).retry(wrong)
  // @ts-expect-error Canonical jitter uses a numeric symmetric factor, never legacy Task full jitter.
  Retry.policy({ times: 1, jittered: true })
  // @ts-expect-error Canonical delay callbacks receive context rather than the legacy retry number.
  Retry.policy({ times: 1, delayMs: (retry: number) => retry })
  // @ts-expect-error Retry callbacks must return ResultAsync rather than an ordinary Promise.
  void ResultAsync.retry(() => Promise.resolve(1), Retry.policy({ times: 1 }))
  const scoped: ResultTask<
    number,
    'offline',
    ResultTaskScope<'release'>
  > = ResultTask.acquireRelease({
    acquire: ResultTask.ok<number, 'offline'>(1),
    release: () => ResultTask.err('release' as const),
  })
  // @ts-expect-error A policy must also accept typed release errors from attempt scopes.
  scoped.pipe(ResultTask.retry(Retry.policy<'offline'>({ times: 1 })))
}
void typeAssertions
