import { deepEqual, equal, rejects, strictEqual, throws } from 'node:assert'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import type { Exit, Result, ResultTaskServices } from '../src/index.js'
import {
  Cause,
  createTaggedError,
  err,
  ok,
  pipe,
  ResultTask,
  Semaphore,
  VirtualClock,
} from '../src/index.js'

describe('ResultTask', () => {
  it('accepts a lazy callback, infers unknown failures and passes the runtime signal', async () => {
    const controller = new AbortController()
    let executions = 0
    const task = ResultTask.tryPromise(async (signal) => {
      strictEqual(signal, controller.signal)
      executions += 1
      return executions
    })
    expectTypeOf(task).toEqualTypeOf<ResultTask<number, unknown>>()
    equal(executions, 0)
    equal(await ResultTask.runPromise(task, { signal: controller.signal }), 1)
    equal(await ResultTask.runPromise(task, { signal: controller.signal }), 2)
    const mapped = ResultTask.tryPromise({ try: async () => 1, catch: () => 'offline' as const })
    expectTypeOf(mapped).toEqualTypeOf<ResultTask<number, 'offline'>>()
  })

  it('preserves thrown values and rejected promises in the callback error channel', async () => {
    const cause = { reason: 'offline' }
    const thrown = ResultTask.tryPromise<number>(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- Unknown failures can be arbitrary values.
      throw cause
    })
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve arbitrary rejection values.
    const rejected = ResultTask.tryPromise(() => Promise.reject(cause))
    for (const task of [thrown, rejected]) {
      const exit = await ResultTask.runExit(task)
      deepEqual(exit, { _tag: 'Failure', cause: { _tag: 'Fail', error: cause } })
      if (exit._tag === 'Failure' && exit.cause._tag === 'Fail')
        strictEqual(exit.cause.error, cause)
    }
  })

  it('keeps callback cancellation as Interrupt instead of an unknown failure', async () => {
    const controller = new AbortController()
    const task = ResultTask.tryPromise((signal) => {
      controller.abort('stop')
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Abort reasons need not be Errors.
      return Promise.reject(signal.reason)
    })
    deepEqual(await ResultTask.runExit(task, { signal: controller.signal }), {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'stop' },
    })
    let started = false
    await ResultTask.runExit(
      ResultTask.tryPromise(async () => {
        started = true
      }),
      { signal: controller.signal },
    )
    equal(started, false)
  })

  it('is lazy and can be executed more than once', async () => {
    let executions = 0
    const task = ResultTask.tryPromise({
      try: async () => {
        executions += 1
        return executions
      },
      catch: (cause) => cause,
    })

    equal(executions, 0)

    const first = await ResultTask.runResult(task)
    equal(executions, 1)
    deepEqual(first, { value: 1 })

    const second = await ResultTask.runResult(task)
    equal(executions, 2)
    deepEqual(second, { value: 2 })
  })

  it('composes tasks lazily and short-circuits typed failures', async () => {
    let chainedExecutions = 0
    const task = ResultTask.ok(2)
      .map((value) => value + 1)
      .andThen((value) =>
        ResultTask.try({
          try: () => {
            chainedExecutions += 1
            return value * 2
          },
          catch: (cause) => cause,
        }),
      )

    equal(chainedExecutions, 0)
    const result = await ResultTask.runResult(task)

    deepEqual(result, { value: 6 })
    equal(chainedExecutions, 1)

    const recovered = await ResultTask.runResult(
      ResultTask.err<'missing'>('missing').orElse((error) => ResultTask.ok(error.length)),
    )

    deepEqual(recovered, { value: 7 })
  })

  it('lifts both successful and failed Results', async () => {
    const successful = await ResultTask.runResult(ResultTask.fromResult(ok('ready')))
    const failed = await ResultTask.runResult(ResultTask.fromResult(err('missing')))

    deepEqual(successful, { value: 'ready' })
    deepEqual(failed, { error: 'missing' })
  })

  it('short-circuits every composition form and supports static aliases', async () => {
    const failed = ResultTask.err<'stop'>('stop')
    const mapped = failed.map(() => 1)
    const flatMapped = failed.andThen(() => ResultTask.ok(1))
    const mappedFunction = ResultTask.map(ResultTask.ok(1), (value) => value + 1)
    const recovered = failed.orElse((error) => ResultTask.ok(error.length))
    const recoveredFunction = ResultTask.orElse(failed, (error) => ResultTask.ok(error.length))
    const successfulRecovery = ResultTask.ok(1).orElse(() => ResultTask.ok(2))
    const chained = ResultTask.ok(1).andThen((value) => ResultTask.ok(value + 1))

    deepEqual(await ResultTask.runResult(mapped), { error: 'stop' })
    deepEqual(await ResultTask.runResult(flatMapped), { error: 'stop' })
    deepEqual(await ResultTask.runResult(mappedFunction), { value: 2 })
    deepEqual(await ResultTask.runResult(recovered), { value: 4 })
    deepEqual(await ResultTask.runResult(recoveredFunction), { value: 4 })
    deepEqual(await ResultTask.runResult(successfulRecovery), { value: 1 })
    deepEqual(await ResultTask.runResult(chained), { value: 2 })
  })

  it('does not recover runtime defects with orElse', async () => {
    const defect = new Error('bug')
    const task = ResultTask.sync(() => {
      throw defect
    }).orElse(() => ResultTask.ok('recovered'))

    const exit = await ResultTask.runExit(task)

    deepEqual(exit, { _tag: 'Failure', cause: { _tag: 'Die', defect } })
  })

  it('maps explicit boundaries into typed failures', async () => {
    const sync = ResultTask.try({
      try: () => {
        throw new Error('invalid')
      },
      catch: () => 'invalid-input' as const,
    })
    const promise = ResultTask.tryPromise({
      try: async () => {
        throw new Error('offline')
      },
      catch: () => 'offline' as const,
    })

    deepEqual(await ResultTask.runResult(sync), { error: 'invalid-input' })
    deepEqual(await ResultTask.runResult(promise), { error: 'offline' })
  })

  it('preserves defects in runExit and rejects them in runResult', async () => {
    const defect = new Error('unexpected')
    const task = ResultTask.sync(() => {
      throw defect
    })

    const exit = await ResultTask.runExit(task)
    equal(exit._tag, 'Failure')

    if (exit._tag === 'Failure') {
      equal(exit.cause._tag, 'Die')
    }

    await rejects(() => ResultTask.runResult(task), defect)
  })

  it('returns the success value from runPromise and rejects typed failures', async () => {
    equal(await ResultTask.runPromise(ResultTask.ok('ready')), 'ready')
    await rejects(() => ResultTask.runPromise(ResultTask.err('not-found')))
  })

  it('passes the run signal to promise boundaries', async () => {
    const controller = new AbortController()
    const task = ResultTask.tryPromise({ try: async (signal) => signal, catch: (cause) => cause })

    const result = await ResultTask.runResult(task, { signal: controller.signal })

    strictEqual(result.isOk() ? result.value : undefined, controller.signal)
  })

  it('supports functional combinators and public exit types', async () => {
    const task = ResultTask.andThen(ResultTask.ok(1), (value) => ResultTask.ok(String(value)))
    const result = await ResultTask.runResult(task)

    deepEqual(result, { value: '1' })
    expectTypeOf(task).toEqualTypeOf<ResultTask<string, never>>()
    expectTypeOf(result).toEqualTypeOf<Result<string, never>>()

    const successExit: Exit<string, never> = { _tag: 'Success', value: 'ok' }
    const failureCause: Cause<'bad'> = { _tag: 'Fail', error: 'bad' }
    const failureExit: Exit<string, 'bad'> = { _tag: 'Failure', cause: failureCause }

    equal(successExit._tag, 'Success')
    equal(failureExit._tag, 'Failure')

    if (false) {
      const taskWithReq = ResultTask.gen(function* () {
        return yield* ResultTask.service<number, 'Num'>('Num')
      })
      // @ts-expect-error ResultTask with unprovided requirements cannot be awaited directly.
      await taskWithReq
    }
  })

  it('runs generator workflows and short-circuits on the first failure', async () => {
    let skippedExecutions = 0
    const task = ResultTask.gen(function* () {
      const first = yield* ResultTask.ok(2)
      const second = yield* ResultTask.try({ try: () => 3, catch: () => 'unreachable' as const })
      const skipped = yield* ResultTask.err<'stop'>('stop')

      skippedExecutions += 1
      void skipped
      return first + second
    })

    const result = await ResultTask.runResult(task)

    deepEqual(result, { error: 'stop' })
    equal(skippedExecutions, 0)
  })

  it('closes a generator when a yielded task fails', async () => {
    let closed = false
    const task = ResultTask.gen(function* () {
      try {
        yield* ResultTask.err<'stop'>('stop')
        return 'unreachable'
      } finally {
        closed = true
      }
    })

    await ResultTask.runResult(task)

    equal(closed, true)
  })

  it('runs yielded cleanup tasks while closing after failure', async () => {
    let cleaned = false
    const task = ResultTask.gen(function* () {
      try {
        yield* ResultTask.err<'stop'>('stop')
      } finally {
        cleaned = yield* ResultTask.ok(true)
      }
    })

    deepEqual(await ResultTask.runExit(task), {
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'stop' },
    })
    equal(cleaned, true)
  })

  it('propagates a cleanup task failure while closing', async () => {
    let closed = false
    const task = ResultTask.gen(function* () {
      try {
        yield* ResultTask.err<'stop'>('stop')
      } finally {
        try {
          yield* ResultTask.err<'cleanup'>('cleanup')
        } finally {
          closed = true
        }
      }
    })

    deepEqual(await ResultTask.runExit(task), {
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'cleanup' },
    })
    equal(closed, true)
  })

  it('preserves a cleanup task defect while closing', async () => {
    const cleanupDefect = new Error('cleanup defect')
    let closed = false
    const task = ResultTask.gen(function* () {
      try {
        yield* ResultTask.err<'stop'>('stop')
      } finally {
        try {
          yield* ResultTask.sync(() => {
            throw cleanupDefect
          })
        } finally {
          closed = true
        }
      }
    })

    deepEqual(await ResultTask.runExit(task), {
      _tag: 'Failure',
      cause: { _tag: 'Die', defect: cleanupDefect },
    })
    equal(closed, true)
  })

  it('resolves and reports missing services yielded during cleanup', async () => {
    interface CleanupService {
      readonly close: () => void
    }

    const Cleanup = ResultTask.service<CleanupService, 'Cleanup'>('Cleanup')
    let closed = false
    const task = ResultTask.gen(function* () {
      try {
        yield* ResultTask.err<'stop'>('stop')
      } finally {
        const cleanup = yield* Cleanup
        cleanup.close()
        closed = true
      }
    })

    const result = await ResultTask.runExit(task, {
      services: { Cleanup: { close: () => undefined } },
    })
    deepEqual(result, { _tag: 'Failure', cause: { _tag: 'Fail', error: 'stop' } })
    equal(closed, true)

    const missing = await ResultTask.runExit(task, {
      services: {} as ResultTaskServices<typeof Cleanup>,
    })
    if (missing._tag !== 'Failure' || missing.cause._tag !== 'Die') {
      throw new Error('Expected a missing cleanup service defect')
    }
    equal((missing.cause.defect as Error).message, 'Missing ResultTask service: Cleanup')
  })

  it('reports unsupported values yielded during cleanup', async () => {
    const task = ResultTask.gen(() =>
      (function* () {
        try {
          yield* ResultTask.err<'stop'>('stop')
        } finally {
          yield null as never
        }
      })(),
    )

    deepEqual(await ResultTask.runExit(task), {
      _tag: 'Failure',
      cause: { _tag: 'Die', defect: new TypeError('ResultTask.gen yielded an unsupported value') },
    })
  })

  it('closes a generator when nested task execution defects', async () => {
    const taskDefect = new Error('task defect')
    let closed = false
    const task = ResultTask.gen(function* () {
      try {
        yield* ResultTask.sync(() => {
          throw taskDefect
        })
      } finally {
        yield* ResultTask.ok(undefined)
        closed = true
      }
    })

    deepEqual(await ResultTask.runExit(task), {
      _tag: 'Failure',
      cause: { _tag: 'Die', defect: taskDefect },
    })
    equal(closed, true)
  })

  it('preserves a generator finalizer defect while closing after failure', async () => {
    const finalizerDefect = new Error('release failed')
    const throwFinalizerDefect = (): never => {
      throw finalizerDefect
    }
    const task = ResultTask.gen(function* () {
      try {
        yield* ResultTask.err<'stop'>('stop')
      } finally {
        throwFinalizerDefect()
      }
    })

    deepEqual(await ResultTask.runExit(task), {
      _tag: 'Failure',
      cause: { _tag: 'Die', defect: finalizerDefect },
    })
  })

  it('turns generator defects and unsupported yields into Die causes', async () => {
    const generatorDefect = new Error('generator failed')
    const defective = ResultTask.gen(function* () {
      yield* ResultTask.ok(undefined)
      throw generatorDefect
    })
    const recovered = defective.orElse(() => ResultTask.ok('recovered'))
    const unsupported = ResultTask.gen(() =>
      (function* () {
        try {
          yield 42 as never
          return 'unreachable'
        } finally {
          yield* ResultTask.ok(undefined)
        }
      })(),
    )

    deepEqual(await ResultTask.runExit(recovered), {
      _tag: 'Failure',
      cause: { _tag: 'Die', defect: generatorDefect },
    })
    deepEqual(await ResultTask.runExit(unsupported), {
      _tag: 'Failure',
      cause: { _tag: 'Die', defect: new TypeError('ResultTask.gen yielded an unsupported value') },
    })

    const unsupportedNull = ResultTask.gen(() =>
      (function* () {
        yield null as never
        return 'unreachable'
      })(),
    )
    const unsupportedUndefined = ResultTask.gen(() =>
      (function* () {
        yield undefined as never
        return 'unreachable'
      })(),
    )
    const malformedTaskYield = ResultTask.gen(() =>
      (function* () {
        yield { _tag: 'ResultTask' } as never
        return 'unreachable'
      })(),
    )
    const wrongTagTaskYield = ResultTask.gen(() =>
      (function* () {
        yield { _tag: 'NotResultTask', task: ResultTask.ok('unexpected') } as never
        return 'unreachable'
      })(),
    )
    const service = ResultTask.service<{ readonly value: string }, 'MalformedService'>(
      'MalformedService',
    )
    const malformedServiceYield = ResultTask.gen(() =>
      (function* () {
        yield { _tag: 'NotService', tag: service } as never
        return 'unreachable'
      })(),
    )

    deepEqual(await ResultTask.runExit(unsupportedNull), {
      _tag: 'Failure',
      cause: { _tag: 'Die', defect: new TypeError('ResultTask.gen yielded an unsupported value') },
    })
    deepEqual(await ResultTask.runExit(unsupportedUndefined), {
      _tag: 'Failure',
      cause: { _tag: 'Die', defect: new TypeError('ResultTask.gen yielded an unsupported value') },
    })
    deepEqual(await ResultTask.runExit(malformedTaskYield), {
      _tag: 'Failure',
      cause: { _tag: 'Die', defect: new TypeError('ResultTask.gen yielded an unsupported value') },
    })
    deepEqual(await ResultTask.runExit(wrongTagTaskYield), {
      _tag: 'Failure',
      cause: { _tag: 'Die', defect: new TypeError('ResultTask.gen yielded an unsupported value') },
    })
    deepEqual(await ResultTask.runExit(malformedServiceYield), {
      _tag: 'Failure',
      cause: { _tag: 'Die', defect: new TypeError('ResultTask.gen yielded an unsupported value') },
    })
  })

  it('rejects a failed task value sent directly into its generator', () => {
    const iterator = ResultTask.err<'stop'>('stop')[Symbol.iterator]()
    iterator.next()

    throws(
      () => iterator.next({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'stop' } }),
      /ResultTask generator received a failed task result/u,
    )
  })

  it('requests services through yield* and tracks their requirements', async () => {
    interface Database {
      readonly findUser: (id: string) => Promise<string>
    }

    interface Logger {
      readonly info: (message: string) => void
    }

    const Database = ResultTask.service<Database, 'Database'>('Database')
    const Logger = ResultTask.service<Logger, 'Logger'>('Logger')
    const database: Database = { findUser: async (id) => `user:${id}` }
    const messages: string[] = []
    const task = ResultTask.gen(function* () {
      const db = yield* Database
      const logger = yield* Logger
      const user = yield* ResultTask.tryPromise({
        try: () => db.findUser('u1'),
        catch: () => 'database-error' as const,
      })

      logger.info(user)
      return user
    })

    expectTypeOf(task).toEqualTypeOf<
      ResultTask<string, 'database-error', typeof Database | typeof Logger>
    >()

    const result = await ResultTask.runResult(task, {
      services: { Database: database, Logger: { info: (message) => messages.push(message) } },
    })

    deepEqual(result, { value: 'user:u1' })
    deepEqual(messages, ['user:u1'])
  })

  it('provides services and removes them from the task requirements', async () => {
    interface Logger {
      readonly info: (message: string) => void
    }

    const Logger = ResultTask.service<Logger, 'Logger'>('Logger')
    const messages: string[] = []
    const task = ResultTask.gen(function* () {
      const logger = yield* Logger
      logger.info('started')
      return 1
    })
    const provided = ResultTask.provideService(task, Logger, {
      info: (message) => messages.push(message),
    })

    expectTypeOf(task).toEqualTypeOf<ResultTask<number, never, typeof Logger>>()
    expectTypeOf(provided).toEqualTypeOf<ResultTask<number, never, never>>()

    const result = await ResultTask.runResult(provided)

    deepEqual(result, { value: 1 })
    deepEqual(messages, ['started'])
  })

  it('resolves missing services through a lazy resolver', async () => {
    interface Logger {
      readonly info: (message: string) => void
    }

    const Logger = ResultTask.service<Logger, 'Logger'>('Logger')
    const messages: string[] = []
    const task = ResultTask.gen(function* () {
      const logger = yield* Logger
      logger.info('resolved')
      return true
    })
    const resolved = ResultTask.provideServiceResolver(task, {
      Logger: () => ResultTask.ok<Logger>({ info: (message) => messages.push(message) }),
    })

    expectTypeOf(resolved).toEqualTypeOf<ResultTask<boolean, never, never>>()
    deepEqual(await ResultTask.runResult(resolved), { value: true })
    deepEqual(messages, ['resolved'])
  })

  it('provides all services by identifier and reports missing services as defects', async () => {
    interface Clock {
      readonly now: () => number
    }

    const Clock = ResultTask.service<Clock, 'Clock'>('Clock')
    const task = ResultTask.gen(function* () {
      try {
        const clock = yield* Clock
        return clock.now()
      } finally {
        yield* ResultTask.ok(undefined)
      }
    })
    const provided = ResultTask.provideServices(task, { Clock: { now: () => 42 } })

    expectTypeOf(provided).toEqualTypeOf<ResultTask<number, never, never>>()
    equal(await ResultTask.runPromise(provided), 42)

    const missing = await ResultTask.runExit(task, {
      services: {} as ResultTaskServices<typeof Clock>,
    })

    if (missing._tag === 'Failure' && missing.cause._tag === 'Die') {
      equal(missing.cause.defect instanceof Error, true)
      equal((missing.cause.defect as Error).name, 'MissingServiceError')
      equal((missing.cause.defect as Error).message, 'Missing ResultTask service: Clock')
    } else {
      throw new Error('Expected a missing service defect')
    }

    if (false) {
      // @ts-expect-error Tasks with requirements need a service environment to run.
      void ResultTask.runResult(task)
      // @ts-expect-error A task with requirements cannot run with an incomplete environment.
      void ResultTask.runResult(task, {})
    }
  })

  it('is stack-safe for 10,000+ chained andThen and map calls without call stack overflow', async () => {
    let andThenTask = ResultTask.ok(0)
    for (let i = 0; i < 10_000; i += 1) {
      andThenTask = andThenTask.andThen((x) => ResultTask.ok(x + 1))
    }
    equal(await ResultTask.runPromise(andThenTask), 10_000)

    let mapTask = ResultTask.ok(0)
    for (let i = 0; i < 10_000; i += 1) {
      mapTask = mapTask.map((x) => x + 1)
    }
    equal(await ResultTask.runPromise(mapTask), 10_000)

    let mixedTask = ResultTask.ok(0)
    for (let i = 0; i < 5000; i += 1) {
      mixedTask = mixedTask.map((x) => x + 1).andThen((x) => ResultTask.ok(x + 1))
    }
    equal(await ResultTask.runPromise(mixedTask), 10_000)

    let recoveredTask = ResultTask.err<'init-error'>('init-error').orElse(() => ResultTask.ok(0))
    for (let i = 0; i < 5000; i += 1) {
      recoveredTask = recoveredTask
        .andThen((x) => ResultTask.ok(x + 1))
        .orElse(() => ResultTask.ok(-1))
    }
    equal(await ResultTask.runPromise(recoveredTask), 5000)
  })

  it('accepts synchronous Result values directly in andThen, orElse, catchTag, and catchTags', async () => {
    class ValidationError extends createTaggedError({
      name: 'Validation',
      message: 'Validation $reason',
    }).withProps<{ readonly reason: string }>() {}
    class FallbackError extends createTaggedError({
      name: 'Fallback',
      message: 'Fallback $code',
    }).withProps<{ readonly code: number }>() {}

    const validatePositive = (n: number): Result<number, ValidationError> =>
      n > 0 ? ok(n * 2) : ValidationError.err({ reason: 'non-positive' })

    const okFlow = ResultTask.ok(5).andThen(validatePositive)
    deepEqual(await ResultTask.runResult(okFlow), { value: 10 })

    const errFlow = ResultTask.ok(-1).andThen(validatePositive)
    const errResult = await ResultTask.runResult(errFlow)
    equal(errResult.isErr(), true)
    if (errResult.isErr()) {
      equal(errResult.error._tag, 'Validation')
      equal(errResult.error.reason, 'non-positive')
    }

    const recoveredWithOk = errFlow.orElse((e) => ok(e.reason.length))
    deepEqual(await ResultTask.runResult(recoveredWithOk), { value: 12 })

    const recoveredWithErr = errFlow.orElse(() => FallbackError.err({ code: 500 }))
    const fallbackResult = await ResultTask.runResult(recoveredWithErr)
    equal(fallbackResult.isErr(), true)
    if (fallbackResult.isErr()) {
      equal(fallbackResult.error._tag, 'Fallback')
      equal(fallbackResult.error.code, 500)
    }

    const caughtTagOk = errFlow.catchTag('Validation', (e) => ok(e.reason.length))
    deepEqual(await ResultTask.runResult(caughtTagOk), { value: 12 })

    const caughtTagErr = errFlow.catchTag('Validation', () => err('retagged' as const))
    deepEqual(await ResultTask.runResult(caughtTagErr), { error: 'retagged' })

    const caughtTagsMixed = (
      errFlow as ResultTask<number, ValidationError | FallbackError>
    ).catchTags({
      Validation: (e) => ok(e.reason.length),
      Fallback: (e) => err(`code:${e.code}` as const),
    })
    deepEqual(await ResultTask.runResult(caughtTagsMixed), { value: 12 })

    const caughtTagsErrBranch = (
      ResultTask.err(new FallbackError({ code: 503 })) as ResultTask<
        number,
        ValidationError | FallbackError
      >
    ).catchTags({
      Validation: (e) => ok(e.reason.length),
      Fallback: (e) => err(`code:${e.code}` as const),
    })
    deepEqual(await ResultTask.runResult(caughtTagsErrBranch), { error: 'code:503' })

    const piped = pipe(
      ResultTask.ok(0),
      ResultTask.andThen(validatePositive),
      ResultTask.catchTag('Validation', () => FallbackError.err({ code: 400 })),
      ResultTask.orElse((e) => ok(e.code)),
    )
    deepEqual(await ResultTask.runResult(piped), { value: 400 })
  })

  it('pipes post-body operators and original arguments through ResultTask.fn', async () => {
    class LookupError extends createTaggedError({
      name: 'Lookup',
      message: 'Missing $id',
    }).withProps<{ readonly id: string }>() {}

    const findScore = ResultTask.fn(
      function* (id: string, multiplier: number) {
        const base = yield* id === 'missing'
          ? ResultTask.err(new LookupError({ id }))
          : ResultTask.ok(id.length * 10)
        return base * multiplier
      },
      ResultTask.map((score) => score + 1),
      (task, id, multiplier) =>
        task.catchTag('Lookup', (error) => ok(error.id.length + multiplier + id.length)),
    )

    deepEqual(await ResultTask.runResult(findScore('abcd', 2)), { value: 81 })
    deepEqual(await ResultTask.runResult(findScore('missing', 3)), { value: 17 })

    const eightStepTask = ResultTask.fn(
      function* (seed: number) {
        return yield* ResultTask.ok(seed)
      },
      ResultTask.map((n) => n + 1),
      ResultTask.map((n) => n + 1),
      ResultTask.map((n) => n + 1),
      ResultTask.map((n) => n + 1),
      ResultTask.map((n) => n + 1),
      ResultTask.map((n) => n + 1),
      ResultTask.map((n) => n + 1),
      (task, seed) => task.map((n) => `${seed}:${n}`),
    )

    deepEqual(await ResultTask.runResult(eightStepTask(5)), { value: '5:12' })
  })

  it('supports filterOrElse across instance, static, and curried pipe forms', async () => {
    class NotFoundError extends createTaggedError({
      name: 'NotFound',
      message: 'Missing $id',
    }).withProps<{ readonly id: string }>() {}
    class ValidationError extends createTaggedError({
      name: 'Validation',
      message: 'Invalid $value',
    }).withProps<{ readonly value: number }>() {}

    const filteredOk = ResultTask.ok<number, NotFoundError>(12).filterOrElse(
      (n) => n >= 10,
      (value) => new ValidationError({ value }),
    )
    const filteredErr = ResultTask.ok<number, NotFoundError>(4).filterOrElse(
      (n) => n >= 10,
      (value) => new ValidationError({ value }),
    )
    const staticFiltered = ResultTask.filterOrElse(
      ResultTask.ok<string | number, never>('ready'),
      (v): v is string => typeof v === 'string',
      () => 'not-string' as const,
    )
    const pipedFiltered = pipe(
      ResultTask.ok<number, never>(3),
      ResultTask.filterOrElse(
        (n) => n > 5,
        (value) => `too-small:${value}` as const,
      ),
    )

    deepEqual(await ResultTask.runResult(filteredOk), { value: 12 })
    const failedFilter = await ResultTask.runResult(filteredErr)
    equal(failedFilter.isErr() && failedFilter.error._tag === 'Validation', true)
    deepEqual(await ResultTask.runResult(staticFiltered), { value: 'ready' })
    deepEqual(await ResultTask.runResult(pipedFiltered), { error: 'too-small:3' })

    throws(
      () =>
        ResultTask.filterOrElse(
          'not-a-task' as never,
          () => true,
          () => 'err',
        ),
      { name: 'TypeError', message: 'ResultTask.filterOrElse requires a task' },
    )
  })

  it('supports matchTags and matchTagsPartial across instance, static, and curried pipe forms', async () => {
    class NotFoundError extends createTaggedError({
      name: 'NotFound',
      message: 'Missing $id',
    }).withProps<{ readonly id: string }>() {}
    class ForbiddenError extends createTaggedError({
      name: 'Forbidden',
      message: 'Denied $role',
    }).withProps<{ readonly role: string }>() {}
    class ValidationError extends createTaggedError({
      name: 'Validation',
      message: 'Invalid $value',
    }).withProps<{ readonly value: number }>() {}

    type AppError = NotFoundError | ForbiddenError | ValidationError

    const tasksByMode: Record<
      'ok' | 'not-found' | 'forbidden' | 'validation',
      ResultTask<number, AppError>
    > = {
      ok: ResultTask.ok(42),
      'not-found': ResultTask.err(new NotFoundError({ id: 'u1' })),
      forbidden: ResultTask.err(new ForbiddenError({ role: 'guest' })),
      validation: ResultTask.err(new ValidationError({ value: -1 })),
    }
    const makeTask = (
      mode: 'ok' | 'not-found' | 'forbidden' | 'validation',
    ): ResultTask<number, AppError> => tasksByMode[mode]

    const foldAll = (mode: 'ok' | 'not-found' | 'forbidden' | 'validation') =>
      makeTask(mode).matchTags((value) => `ok:${value}` as const, {
        NotFound: (e) => `nf:${e.id}` as const,
        Forbidden: (e) => `fb:${e.role}` as const,
        Validation: (e) => `val:${e.value}` as const,
      })

    deepEqual(await ResultTask.runResult(foldAll('ok')), { value: 'ok:42' })
    deepEqual(await ResultTask.runResult(foldAll('not-found')), { value: 'nf:u1' })
    deepEqual(await ResultTask.runResult(foldAll('forbidden')), { value: 'fb:guest' })
    deepEqual(await ResultTask.runResult(foldAll('validation')), { value: 'val:-1' })

    const staticMatched = ResultTask.matchTags(
      makeTask('forbidden'),
      (value) => `ok:${value}` as const,
      {
        NotFound: (e) => `nf:${e.id}` as const,
        Forbidden: (e) => `fb:${e.role}` as const,
        Validation: (e) => `val:${e.value}` as const,
      },
    )
    const pipedMatched = pipe(
      makeTask('not-found'),
      ResultTask.matchTags((value) => `ok:${value}` as const, {
        NotFound: (e) => `nf:${e.id}` as const,
        Forbidden: (e) => `fb:${e.role}` as const,
        Validation: (e) => `val:${e.value}` as const,
      }),
    )

    deepEqual(await ResultTask.runResult(staticMatched), { value: 'fb:guest' })
    deepEqual(await ResultTask.runResult(pipedMatched), { value: 'nf:u1' })

    const partialOk = makeTask('ok').matchTagsPartial(
      (value) => `ok:${value}` as const,
      { NotFound: (e) => `nf:${e.id}` as const },
      (rest) => `rest:${rest._tag}` as const,
    )
    const partialHandled = makeTask('not-found').matchTagsPartial(
      (value) => `ok:${value}` as const,
      { NotFound: (e) => `nf:${e.id}` as const },
      (rest) => `rest:${rest._tag}` as const,
    )
    const partialFallback = ResultTask.matchTagsPartial(
      makeTask('validation'),
      (value) => `ok:${value}` as const,
      { NotFound: (e) => `nf:${e.id}` as const },
      (rest) => `rest:${rest._tag}` as const,
    )
    const pipedPartial = pipe(
      makeTask('forbidden'),
      ResultTask.matchTagsPartial(
        (value) => `ok:${value}` as const,
        { NotFound: (e) => `nf:${e.id}` as const },
        (rest) => `rest:${rest._tag}` as const,
      ),
    )

    deepEqual(await ResultTask.runResult(partialOk), { value: 'ok:42' })
    deepEqual(await ResultTask.runResult(partialHandled), { value: 'nf:u1' })
    deepEqual(await ResultTask.runResult(partialFallback), { value: 'rest:Validation' })
    deepEqual(await ResultTask.runResult(pipedPartial), { value: 'rest:Forbidden' })

    const unhandledTagError = new ForbiddenError({ role: 'none' })
    const brokenMatchTags = (
      ResultTask.err(unhandledTagError) as unknown as ResultTask<number, NotFoundError>
    ).matchTags((n) => n, { NotFound: () => 0 })
    const brokenExit = await ResultTask.runExit(brokenMatchTags)
    deepEqual(brokenExit, { _tag: 'Failure', cause: { _tag: 'Die', defect: unhandledTagError } })

    throws(() => ResultTask.matchTags('not-a-task' as never, (v) => v, {} as never), {
      name: 'TypeError',
      message: 'ResultTask.matchTags requires a task',
    })
    throws(
      () =>
        ResultTask.matchTagsPartial(
          'not-a-task' as never,
          (v) => v,
          {} as never,
          () => 'fallback',
        ),
      { name: 'TypeError', message: 'ResultTask.matchTagsPartial requires a task' },
    )
  })

  it('supports inspectBoth across instance, static, and curried pipe forms', async () => {
    const okTask: ResultTask<number, 'boom'> = ResultTask.ok(10)
    const errTask: ResultTask<number, 'boom'> = ResultTask.err('boom')
    const events: string[] = []
    const okErrHandlers = {
      ok: async (value: number) => {
        events.push(`ok:${value}`)
        throw new Error('ignored')
      },
      error: (error: 'boom') => {
        events.push(`err:${error}`)
        throw new Error('ignored')
      },
    }
    const onSuccessFailureHandlers = {
      onSuccess: (value: number) => {
        events.push(`succ:${value}`)
      },
      onFailure: (error: 'boom') => {
        events.push(`fail:${error}`)
      },
    }

    deepEqual(await ResultTask.runResult(okTask.inspectBoth(okErrHandlers)), { value: 10 })
    deepEqual(await ResultTask.runResult(errTask.inspectBoth(onSuccessFailureHandlers)), {
      error: 'boom',
    })
    deepEqual(
      await ResultTask.runResult(okTask.inspectBoth(okErrHandlers.ok, okErrHandlers.error)),
      { value: 10 },
    )
    deepEqual(
      await ResultTask.runResult(
        ResultTask.inspectBoth(errTask, okErrHandlers.ok, okErrHandlers.error),
      ),
      { error: 'boom' },
    )
    deepEqual(await ResultTask.runResult(ResultTask.inspectBoth(okTask, okErrHandlers)), {
      value: 10,
    })
    deepEqual(await ResultTask.runResult(pipe(okTask, ResultTask.inspectBoth(okErrHandlers))), {
      value: 10,
    })
    deepEqual(
      await ResultTask.runResult(
        pipe(errTask, ResultTask.inspectBoth(okErrHandlers.ok, okErrHandlers.error)),
      ),
      { error: 'boom' },
    )
    throws(
      () =>
        (okTask as unknown as { inspectBoth: (f: () => void) => void }).inspectBoth(
          () => undefined,
        ),
      { name: 'TypeError', message: 'ResultTask.inspectBoth requires an error handler' },
    )
    deepEqual(events, ['ok:10', 'fail:boom', 'ok:10', 'err:boom', 'ok:10', 'ok:10', 'err:boom'])
  })
})

describe('ResultTask Wave 3 combinators', () => {
  it('runs ensuring finalizers on Success, Fail, Die, and Interrupt and combines finalizer failures', async () => {
    const outcomes: string[] = []
    const record = (label: string) => (exit: Exit<unknown, unknown>) =>
      ResultTask.sync(() => {
        outcomes.push(`${label}:${exit._tag === 'Success' ? 'Success' : exit.cause._tag}`)
      })

    deepEqual(await ResultTask.runResult(ResultTask.ok(10).ensuring(record('ok'))), { value: 10 })
    deepEqual(
      await ResultTask.runResult(ResultTask.ensuring(ResultTask.err('fail'), record('err'))),
      { error: 'fail' },
    )
    const dieExit = await ResultTask.runExit(
      pipe(
        ResultTask.sync(() => {
          throw new Error('boom')
        }),
        ResultTask.ensuring(record('die')),
      ),
    )
    equal(dieExit._tag, 'Failure')
    const controller = new AbortController()
    const intExit = await ResultTask.runExit(
      ResultTask.tryPromise(async () => {
        controller.abort('cancelled')
        return 1
      }).ensuring(async (exit) => {
        await Promise.resolve()
        outcomes.push(`int:${exit._tag === 'Success' ? 'Success' : exit.cause._tag}`)
      }),
      { signal: controller.signal },
    )
    equal(intExit._tag, 'Failure')
    deepEqual(outcomes, ['ok:Success', 'err:Fail', 'die:Die', 'int:Interrupt'])

    const combinedFail = await ResultTask.runExit(
      ResultTask.err<'primary'>('primary').ensuring(() => ResultTask.err<'cleanup'>('cleanup')),
    )
    deepEqual(combinedFail, {
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Fail', error: 'primary' },
        right: { _tag: 'Fail', error: 'cleanup' },
      },
    })

    throws(() => ResultTask.ensuring('not-a-task' as never, () => undefined), {
      name: 'TypeError',
      message: 'ResultTask.ensuring requires a task',
    })
  })

  it('supports delay and timed with VirtualClock across instance, static, and curried forms', async () => {
    const clock = new VirtualClock(1000)
    const delayed = ResultTask.ok('ready').delay(250).timed()
    const fiber = ResultTask.runFork(delayed, { clock })

    await clock.advanceBy(250)
    const exit = fiber.poll()
    deepEqual(exit, { _tag: 'Success', value: [250, 'ready'] })

    const clock2 = new VirtualClock(0)
    const piped = pipe(ResultTask.ok(7), ResultTask.delay(100), ResultTask.timed())
    const fiber2 = ResultTask.runFork(piped, { clock: clock2 })
    await clock2.advanceBy(100)
    deepEqual(fiber2.poll(), { _tag: 'Success', value: [100, 7] })

    const directTimed = ResultTask.timed(ResultTask.delay(ResultTask.ok('x'), 50))
    const clock3 = new VirtualClock(0)
    const fiber3 = ResultTask.runFork(directTimed, { clock: clock3 })
    await clock3.advanceBy(50)
    deepEqual(fiber3.poll(), { _tag: 'Success', value: [50, 'x'] })

    throws(() => ResultTask.ok(1).delay(-1), {
      name: 'RangeError',
      message: 'Task duration must be a finite non-negative number',
    })
  })

  it('supports zip and firstSuccessOf on ResultTask', async () => {
    const zipped1 = ResultTask.ok(1).zip(ResultTask.ok('a'))
    const zipped2 = ResultTask.zip(ResultTask.ok(2), ok('b'))
    const zipped3 = pipe(ResultTask.ok(3), ResultTask.zip(ResultTask.ok('c')))
    const zippedErr = ResultTask.ok(1).zip(ResultTask.err<'bad'>('bad'))

    deepEqual(await ResultTask.runResult(zipped1), { value: [1, 'a'] })
    deepEqual(await ResultTask.runResult(zipped2), { value: [2, 'b'] })
    deepEqual(await ResultTask.runResult(zipped3), { value: [3, 'c'] })
    deepEqual(await ResultTask.runResult(zippedErr), { error: 'bad' })

    const attempts: string[] = []
    const winner = ResultTask.firstSuccessOf([
      () => {
        attempts.push('first')
        return ResultTask.err<'e1'>('e1')
      },
      () => {
        attempts.push('second')
        return ResultTask.ok(42)
      },
      () => {
        attempts.push('third')
        return ResultTask.ok(99)
      },
    ])
    deepEqual(await ResultTask.runResult(winner), { value: 42 })
    deepEqual(attempts, ['first', 'second'])

    const allFail = ResultTask.firstSuccessOf([ResultTask.err<'e1'>('e1'), err<number, 'e2'>('e2')])
    deepEqual(await ResultTask.runResult(allFail), { error: 'e2' })

    const emptyExit = await ResultTask.runExit(ResultTask.firstSuccessOf([]))
    equal(emptyExit._tag, 'Failure')
    if (emptyExit._tag === 'Failure') {
      equal(emptyExit.cause._tag, 'Die')
    }
  })

  it('supports if, when, and unless on ResultTask', async () => {
    const ifTrue = ResultTask.if(ResultTask.ok(true), {
      onTrue: () => ResultTask.ok('yes' as const),
      onFalse: () => ResultTask.ok('no' as const),
    })
    const ifFalse = pipe(
      () => ok(false),
      ResultTask.if({ onTrue: ResultTask.ok('yes' as const), onFalse: ok('no' as const) }),
    )
    deepEqual(await ResultTask.runResult(ifTrue), { value: 'yes' })
    deepEqual(await ResultTask.runResult(ifFalse), { value: 'no' })

    const whenHit = ResultTask.ok(10).when(true)
    const whenSkip = ResultTask.when(false, () => ResultTask.ok(10))
    const whenResHit = pipe(
      () => ResultTask.ok(20),
      ResultTask.when(() => ResultTask.ok(true)),
    )
    const whenResErr = ResultTask.when(ResultTask.err<'cond-err'>('cond-err'), () =>
      ResultTask.ok(20),
    )

    deepEqual(await ResultTask.runResult(whenHit), { value: 10 })
    deepEqual(await ResultTask.runResult(whenSkip), { value: undefined })
    deepEqual(await ResultTask.runResult(whenResHit), { value: 20 })
    deepEqual(await ResultTask.runResult(whenResErr), { error: 'cond-err' })

    const unlessSkip = ResultTask.ok(10).unless(true)
    const unlessHit = ResultTask.unless(false, () => ResultTask.ok(10))
    const unlessResHit = pipe(ResultTask.ok(30), ResultTask.unless(ResultTask.ok(false)))
    deepEqual(await ResultTask.runResult(unlessSkip), { value: undefined })
    deepEqual(await ResultTask.runResult(unlessHit), { value: 10 })
    deepEqual(await ResultTask.runResult(unlessResHit), { value: 30 })
  })

  it('supports loop and iterate on ResultTask across direct and curried forms', async () => {
    const looped = ResultTask.loop(0, {
      while: (n) => n < 3,
      step: (n) => n + 1,
      body: (n) => ResultTask.ok(n * 10),
    })
    deepEqual(await ResultTask.runResult(looped), { value: [0, 10, 20] })

    const discarded: number[] = []
    const loopedDiscard = pipe(
      0,
      ResultTask.loop({
        while: (n) => n < 3,
        step: (n) => n + 1,
        discard: true,
        body: (n) =>
          ResultTask.sync(() => {
            discarded.push(n)
          }),
      }),
    )
    deepEqual(await ResultTask.runResult(loopedDiscard), { value: undefined })
    deepEqual(discarded, [0, 1, 2])

    const iterated = ResultTask.iterate(1, {
      while: (n) => n < 16,
      body: (n) => ResultTask.ok(n * 2),
    })
    const pipedIterated = pipe(
      2,
      ResultTask.iterate({ while: (n) => n < 10, body: (n) => ok(n + 3) }),
    )
    deepEqual(await ResultTask.runResult(iterated), { value: 16 })
    deepEqual(await ResultTask.runResult(pipedIterated), { value: 11 })
  })

  it('supports catchCause, tapCause, inspectCause, sandbox, unsandbox, onExit, and Cause helpers', async () => {
    const defect = new Error('boom-defect')
    const dieTask = ResultTask.sync<number>(() => {
      throw defect
    })

    const caughtDie = dieTask.catchCause((cause) => {
      equal(Cause.isCause(cause), true)
      deepEqual(Cause.defects(cause), [defect])
      deepEqual(Cause.failures(cause), [])
      return ok(-1)
    })
    deepEqual(await ResultTask.runResult(caughtDie), { value: -1 })

    const caughtStatic = ResultTask.catchCause(ResultTask.err<'e1'>('e1'), (cause) =>
      ResultTask.ok(`recovered:${Cause.failures(cause).join(',')}`),
    )
    deepEqual(await ResultTask.runResult(caughtStatic), { value: 'recovered:e1' })

    const caughtPiped = pipe(
      ResultTask.err<'e2'>('e2'),
      ResultTask.catchCause((cause) => ok(`piped:${Cause.failures(cause).join(',')}`)),
    )
    deepEqual(await ResultTask.runResult(caughtPiped), { value: 'piped:e2' })

    // External interruption is not swallowed by catchCause
    const controller = new AbortController()
    const interruptedExit = await ResultTask.runExit(
      ResultTask.tryPromise(async () => {
        controller.abort('external-stop')
        return 1
      }).catchCause(() => ok(999)),
      { signal: controller.signal },
    )
    deepEqual(interruptedExit, {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'external-stop' },
    })

    // Composite cleanup failures from inner closed scopes are passed to catchCause
    const cleanupRecovered = ResultTask.err<'primary'>('primary')
      .ensuring(() => ResultTask.err<'cleanup'>('cleanup'))
      .catchCause((cause) => ok(`recovered:${Cause.failures(cause).join('+')}`))
    deepEqual(await ResultTask.runExit(cleanupRecovered), {
      _tag: 'Success',
      value: 'recovered:primary+cleanup',
    })

    // External interruption combined with inner cleanup failure still interrupts after catchCause recovery
    const cleanupAbortController = new AbortController()
    const interruptedWithCleanupRecovered = await ResultTask.runExit(
      ResultTask.tryPromise(async () => {
        cleanupAbortController.abort('abort-with-cleanup')
        return 1
      })
        .ensuring(() => ResultTask.err<'cleanup'>('cleanup'))
        .catchCause(() => ResultTask.ok(123)),
      { signal: cleanupAbortController.signal },
    )
    deepEqual(interruptedWithCleanupRecovered, {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'abort-with-cleanup' },
    })
  })

  it('sandboxes, unsandboxes (including shared DAG causes), taps Causes, and observes Exits', async () => {
    const defect = new TypeError('fatal-defect')
    const dieTask = ResultTask.sync<number>(() => {
      throw defect
    })

    // sandbox and unsandbox round-trip Fail, Die, and shared-subtree DAG causes while rejecting cycles
    const sandboxedDie = dieTask.sandbox()
    const sandboxedResult = await ResultTask.runResult(sandboxedDie)
    equal(sandboxedResult.isErr(), true)
    if (sandboxedResult.isErr()) {
      deepEqual(sandboxedResult.error, { _tag: 'Die', defect })
    }
    const unsandboxedExit = await ResultTask.runExit(
      pipe(dieTask, ResultTask.sandbox(), ResultTask.unsandbox()),
    )
    deepEqual(unsandboxedExit, { _tag: 'Failure', cause: { _tag: 'Die', defect } })
    deepEqual(
      await ResultTask.runExit(ResultTask.unsandbox(ResultTask.sandbox(ResultTask.ok(7)))),
      { _tag: 'Success', value: 7 },
    )

    const sharedLeaf: Cause<'shared'> = { _tag: 'Fail', error: 'shared' }
    const sharedBranch: Cause<'shared'> = {
      _tag: 'Sequential',
      left: sharedLeaf,
      right: sharedLeaf,
    }
    const sharedCause: Cause<'shared'> = {
      _tag: 'Parallel',
      left: sharedBranch,
      right: sharedBranch,
    }
    equal(Cause.isCause(sharedCause), true)
    deepEqual(await ResultTask.runExit(ResultTask.err(sharedCause).unsandbox()), {
      _tag: 'Failure',
      cause: sharedCause,
    })

    const cyclicCause: { _tag: 'Sequential'; left: Cause<'shared'>; right?: unknown } = {
      _tag: 'Sequential',
      left: sharedLeaf,
    }
    cyclicCause.right = cyclicCause
    equal(Cause.isCause(cyclicCause), false)

    // tapCause and inspectCause observe full Cause trees
    const observed: string[] = []
    const tapped = pipe(
      dieTask,
      ResultTask.inspectCause((cause) => {
        observed.push(`inspect:${cause._tag}`)
        throw new Error('ignored-sync-throw')
      }),
      ResultTask.tapCause((cause) =>
        ResultTask.sync(() => {
          observed.push(`tap:${cause._tag}`)
        }),
      ),
    )
    deepEqual(await ResultTask.runExit(tapped), { _tag: 'Failure', cause: { _tag: 'Die', defect } })
    deepEqual(observed, ['inspect:Die', 'tap:Die'])

    const tapFailureCombines = await ResultTask.runExit(
      ResultTask.tapCause(ResultTask.err<'primary'>('primary'), () =>
        ResultTask.err<'tap-err'>('tap-err'),
      ),
    )
    deepEqual(tapFailureCombines, {
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Fail', error: 'primary' },
        right: { _tag: 'Fail', error: 'tap-err' },
      },
    })

    // onExit runs on all outcomes across instance, static, and curried forms
    const exits: string[] = []
    deepEqual(
      await ResultTask.runResult(
        ResultTask.ok(5).onExit((exit) => {
          exits.push(`inst:${exit._tag}`)
        }),
      ),
      { value: 5 },
    )
    deepEqual(
      await ResultTask.runResult(
        ResultTask.onExit(ResultTask.err<'bad'>('bad'), (exit) => {
          exits.push(`stat:${exit._tag}`)
        }),
      ),
      { error: 'bad' },
    )
    deepEqual(
      await ResultTask.runResult(
        pipe(
          ResultTask.ok(9),
          ResultTask.onExit((exit) => {
            exits.push(`pipe:${exit._tag}`)
          }),
        ),
      ),
      { value: 9 },
    )
    deepEqual(exits, ['inst:Success', 'stat:Failure', 'pipe:Success'])
  })

  it('supports concurrent zip with structured sibling interruption', async () => {
    const clock = new VirtualClock(0)
    const concurrentZipped = ResultTask.ok('left')
      .delay(100)
      .zip(ResultTask.ok('right').delay(100), { concurrent: true })
      .timed()

    const fiber = ResultTask.runFork(concurrentZipped, { clock })
    await clock.advanceBy(100)
    deepEqual(fiber.poll(), { _tag: 'Success', value: [100, ['left', 'right']] })

    const pipedConcurrent = pipe(
      ResultTask.ok(1).delay(50),
      ResultTask.zip(ResultTask.ok(2).delay(50), { concurrent: true }),
    )
    const clock2 = new VirtualClock(0)
    const fiber2 = ResultTask.runFork(pipedConcurrent, { clock: clock2 })
    await clock2.advanceBy(50)
    deepEqual(fiber2.poll(), { _tag: 'Success', value: [1, 2] })

    let rightAborted = false
    const leftFailsFast = ResultTask.zip(
      ResultTask.err<'fast-err'>('fast-err'),
      ResultTask.tryPromise(
        (signal) =>
          new Promise<number>((_, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                rightAborted = true
                reject(new Error('aborted'))
              },
              { once: true },
            )
          }),
      ),
      { concurrent: true },
    )
    deepEqual(await ResultTask.runResult(leftFailsFast), { error: 'fast-err' })
    equal(rightAborted, true)

    const resourceWithFailingRelease = ResultTask.acquireRelease({
      acquire: ResultTask.ok(1),
      release: () => ResultTask.err<'cleanup'>('cleanup'),
    })
    const staticConcurrentZip = ResultTask.zip(resourceWithFailingRelease, ResultTask.ok(2), {
      concurrent: true,
    }).orElse((error) => ResultTask.ok([0, error.length] as const))
    deepEqual(await ResultTask.runResult(staticConcurrentZip), { value: [0, 7] })

    throws(() => ResultTask.ok(1).zip(ResultTask.ok(2), { concurrent: 'yes' as never }), {
      name: 'TypeError',
      message: 'ResultTask.zip concurrent must be a boolean when provided',
    })
  })

  it('bounds concurrency across tasks and fibers with Semaphore', async () => {
    const semaphore = ResultTask.makeSemaphore(2)
    equal(semaphore.available(), 2)

    let active = 0
    let maxActive = 0
    const order: number[] = []

    const makeWorker = (id: number) =>
      semaphore.withPermit(
        ResultTask.gen(function* () {
          active += 1
          maxActive = Math.max(maxActive, active)
          order.push(id)
          yield* ResultTask.sleep(50)
          active -= 1
          return id * 10
        }),
      )

    const clock = new VirtualClock(0)
    const allTask = ResultTask.all([makeWorker(1), makeWorker(2), makeWorker(3), makeWorker(4)], {
      concurrency: 'unbounded',
    })
    const fiber = ResultTask.runFork(allTask, { clock })

    await clock.advanceBy(0)
    equal(active, 2)
    equal(semaphore.available(), 0)

    await clock.advanceBy(50)
    await clock.advanceBy(50)
    deepEqual(fiber.poll(), { _tag: 'Success', value: [10, 20, 30, 40] })
    equal(maxActive, 2)
    equal(semaphore.available(), 2)
    deepEqual(order, [1, 2, 3, 4])

    const multi = Semaphore.make(3)
    const multiTask = pipe(
      ResultTask.sync(() => multi.available()),
      Semaphore.withPermits(multi, 2),
    )
    deepEqual(await ResultTask.runResult(multiTask), { value: 1 })
    equal(multi.available(), 3)
  })

  it('handles queued waiter interruption and validates Semaphore arguments', async () => {
    const single = Semaphore.make(1)
    const clock = new VirtualClock(0)
    const holder = ResultTask.runFork(single.withPermit(ResultTask.sleep(100)), { clock })
    await clock.advanceBy(0)
    equal(single.available(), 0)

    const waiterController = new AbortController()
    const waiterPromise = ResultTask.runExit(Semaphore.withPermit(single, ResultTask.ok('never')), {
      signal: waiterController.signal,
      clock,
    })
    waiterController.abort('cancel-waiter')
    const waiterExit = await waiterPromise
    deepEqual(waiterExit, {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'cancel-waiter' },
    })

    await clock.advanceBy(100)
    deepEqual(holder.poll(), { _tag: 'Success', value: undefined })
    equal(single.available(), 1)

    throws(() => Semaphore.make(0), {
      name: 'RangeError',
      message: 'Semaphore.make permits must be a positive safe integer',
    })
    throws(() => single.withPermits(2, ResultTask.ok(1)), {
      name: 'RangeError',
      message: 'Semaphore.withPermits requested 2 permits, exceeding capacity 1',
    })
  })
})
