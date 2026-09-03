import { deepEqual, equal, rejects, strictEqual, throws } from 'node:assert'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import type { Cause, Exit, Result, ResultTaskServices } from '../src/index.js'
import { err, ok, ResultTask } from '../src/index.js'

describe('ResultTask', () => {
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
    const task = ResultTask.succeed(2)
      .map((value) => value + 1)
      .flatMap((value) =>
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
      ResultTask.fail<'missing'>('missing').catchAll((error) => ResultTask.succeed(error.length)),
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
    const failed = ResultTask.fail<'stop'>('stop')
    const mapped = failed.map(() => 1)
    const flatMapped = failed.flatMap(() => ResultTask.succeed(1))
    const mappedFunction = ResultTask.map(ResultTask.succeed(1), (value) => value + 1)
    const recovered = failed.catchAll((error) => ResultTask.succeed(error.length))
    const recoveredFunction = ResultTask.catchAll(failed, (error) =>
      ResultTask.succeed(error.length),
    )
    const successfulRecovery = ResultTask.succeed(1).catchAll(() => ResultTask.succeed(2))
    const chained = ResultTask.succeed(1).andThen((value) => ResultTask.succeed(value + 1))

    deepEqual(await ResultTask.runResult(mapped), { error: 'stop' })
    deepEqual(await ResultTask.runResult(flatMapped), { error: 'stop' })
    deepEqual(await ResultTask.runResult(mappedFunction), { value: 2 })
    deepEqual(await ResultTask.runResult(recovered), { value: 4 })
    deepEqual(await ResultTask.runResult(recoveredFunction), { value: 4 })
    deepEqual(await ResultTask.runResult(successfulRecovery), { value: 1 })
    deepEqual(await ResultTask.runResult(chained), { value: 2 })
  })

  it('does not recover runtime defects with catchAll', async () => {
    const defect = new Error('bug')
    const task = ResultTask.sync(() => {
      throw defect
    }).catchAll(() => ResultTask.succeed('recovered'))

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
    equal(await ResultTask.runPromise(ResultTask.succeed('ready')), 'ready')
    await rejects(() => ResultTask.runPromise(ResultTask.fail('not-found')))
  })

  it('passes the run signal to promise boundaries', async () => {
    const controller = new AbortController()
    const task = ResultTask.tryPromise({ try: async (signal) => signal, catch: (cause) => cause })

    const result = await ResultTask.runResult(task, { signal: controller.signal })

    strictEqual(result.isOk() ? result.value : undefined, controller.signal)
  })

  it('supports functional combinators and public exit types', async () => {
    const task = ResultTask.flatMap(ResultTask.succeed(1), (value) =>
      ResultTask.succeed(String(value)),
    )
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
      // @ts-expect-error ResultTask is not PromiseLike and does not execute implicitly.
      void task.then
    }
  })

  it('runs generator workflows and short-circuits on the first failure', async () => {
    let skippedExecutions = 0
    const task = ResultTask.gen(function* () {
      const first = yield* ResultTask.succeed(2)
      const second = yield* ResultTask.try({ try: () => 3, catch: () => 'unreachable' as const })
      const skipped = yield* ResultTask.fail<'stop'>('stop')

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
        yield* ResultTask.fail<'stop'>('stop')
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
        yield* ResultTask.fail<'stop'>('stop')
      } finally {
        cleaned = yield* ResultTask.succeed(true)
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
        yield* ResultTask.fail<'stop'>('stop')
      } finally {
        try {
          yield* ResultTask.fail<'cleanup'>('cleanup')
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
        yield* ResultTask.fail<'stop'>('stop')
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
        yield* ResultTask.fail<'stop'>('stop')
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
          yield* ResultTask.fail<'stop'>('stop')
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
        yield* ResultTask.succeed(undefined)
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
        yield* ResultTask.fail<'stop'>('stop')
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
      yield* ResultTask.succeed(undefined)
      throw generatorDefect
    })
    const recovered = defective.catchAll(() => ResultTask.succeed('recovered'))
    const unsupported = ResultTask.gen(() =>
      (function* () {
        try {
          yield 42 as never
          return 'unreachable'
        } finally {
          yield* ResultTask.succeed(undefined)
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
        yield { _tag: 'NotResultTask', task: ResultTask.succeed('unexpected') } as never
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
    const iterator = ResultTask.fail<'stop'>('stop')[Symbol.iterator]()
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
        yield* ResultTask.succeed(undefined)
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
})
