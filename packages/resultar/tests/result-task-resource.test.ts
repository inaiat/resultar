import { deepEqual, equal, rejects } from 'node:assert'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import type { Exit, Result, ResultTaskScope } from '../src/index.js'
import { AbortError, ResultTask, ResultTaskCauseError } from '../src/index.js'

const failExit = (error: string): Exit<never, string> => ({
  _tag: 'Failure',
  cause: { _tag: 'Fail', error },
})

describe('ResultTask resource scopes', () => {
  it('is lazy, releases in LIFO order, and owns a fresh scope per run', async () => {
    const events: string[] = []
    const resource = (name: string) =>
      ResultTask.acquireRelease({
        acquire: ResultTask.sync(() => {
          events.push(`open:${name}`)
          return name
        }),
        release: (value, exit) =>
          ResultTask.sync(() => {
            events.push(`close:${value}:${exit._tag}`)
          }),
      })
    const task = ResultTask.gen(function* () {
      yield* resource('database')
      yield* resource('session')
      return 'ready'
    })
    deepEqual(events, [])
    for (let run = 0; run < 2; run += 1) {
      deepEqual(await ResultTask.runResult(task), { value: 'ready' })
    }
    deepEqual(events, [
      'open:database',
      'open:session',
      'close:session:Success',
      'close:database:Success',
      'open:database',
      'open:session',
      'close:session:Success',
      'close:database:Success',
    ])
  })

  it('rolls back earlier resources when later acquisition fails', async () => {
    const exits: Exit<unknown, unknown>[] = []
    let failedRelease = false
    const task = ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.succeed('database'),
        release: (_resource, exit) =>
          ResultTask.sync(() => {
            exits.push(exit)
          }),
      })
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.fail('connect'),
        release: () =>
          ResultTask.sync(() => {
            failedRelease = true
          }),
      })
    })
    deepEqual(await ResultTask.runExit(task), failExit('connect'))
    deepEqual(exits, [failExit('connect')])
    equal(failedRelease, false)
  })

  it('closes a child scope before continuing and does not release it twice', async () => {
    const events: string[] = []
    const acquire = (name: string) =>
      ResultTask.acquireRelease({
        acquire: ResultTask.succeed(name),
        release: () =>
          ResultTask.sync(() => {
            events.push(name)
          }),
      })
    const task = ResultTask.gen(function* () {
      yield* acquire('parent')
      yield* ResultTask.scoped(acquire('child'))
      events.push('continue')
    })
    await ResultTask.runPromise(task)
    deepEqual(events, ['child', 'continue', 'parent'])
  })

  it('preserves all cleanup failures and gives every finalizer the region exit', async () => {
    const exits: Exit<unknown, unknown>[] = []
    const resource = (error: string) =>
      ResultTask.acquireRelease({
        acquire: ResultTask.succeed(undefined),
        release: (_resource, exit) => {
          exits.push(exit)
          return ResultTask.fail(error)
        },
      })
    const task = ResultTask.gen(function* () {
      yield* resource('database-close')
      yield* resource('session-close')
      yield* ResultTask.fail('boot')
    })
    const expected = {
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: {
          _tag: 'Sequential',
          left: { _tag: 'Fail', error: 'boot' },
          right: { _tag: 'Fail', error: 'session-close' },
        },
        right: { _tag: 'Fail', error: 'database-close' },
      },
    }
    deepEqual(await ResultTask.runExit(task), expected)
    deepEqual(exits, [failExit('boot'), failExit('boot')])
    await rejects(
      () => ResultTask.runResult(task),
      (error: unknown) => {
        equal(error instanceof ResultTaskCauseError, true)
        deepEqual((error as ResultTaskCauseError).cause, expected.cause)
        return true
      },
    )
    await rejects(() => ResultTask.runPromise(task), ResultTaskCauseError)
  })

  it('returns a single release failure as Err and can recover after scoped closes', async () => {
    const resource = ResultTask.acquireRelease({
      acquire: ResultTask.succeed(1),
      release: () => ResultTask.fail('release'),
    })
    deepEqual(await ResultTask.runResult(resource), { error: 'release' })
    const recovered = ResultTask.scoped(resource).catchAll(() => ResultTask.succeed(2))
    deepEqual(await ResultTask.runResult(recovered), { value: 2 })
  })

  it('keeps body defects and thrown release defects, and still runs older finalizers', async () => {
    const bodyDefect = new Error('body bug')
    const releaseDefect = new Error('release bug')
    let closed = false
    const task = ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.succeed(undefined),
        release: () =>
          ResultTask.sync(() => {
            closed = true
          }),
      })
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.succeed(undefined),
        release: () => {
          throw releaseDefect
        },
      })
      throw bodyDefect
    })
    deepEqual(await ResultTask.runExit(task), {
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Die', defect: bodyDefect },
        right: { _tag: 'Die', defect: releaseDefect },
      },
    })
    equal(closed, true)
  })

  it('waits for asynchronous finalizers before resolving', async () => {
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    let resolved = false
    const task = ResultTask.acquireRelease({
      acquire: ResultTask.succeed(undefined),
      release: () =>
        ResultTask.tryPromise({
          try: () => {
            started.resolve()
            return finish.promise
          },
          catch: () => 'release' as const,
        }),
    })
    const result = ResultTask.runExit(task).then((exit) => {
      resolved = true
      return exit
    })
    await started.promise
    equal(resolved, false)
    finish.resolve()
    deepEqual(await result, { _tag: 'Success', value: undefined })
  })

  it('does not start an acquisition with an already aborted signal', async () => {
    const controller = new AbortController()
    controller.abort('stop')
    let opened = false
    const task = ResultTask.acquireRelease({
      acquire: ResultTask.sync(() => {
        opened = true
      }),
      release: () => ResultTask.succeed(undefined),
    })
    deepEqual(await ResultTask.runExit(task, { signal: controller.signal }), {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'stop' },
    })
    await rejects(() => ResultTask.runResult(task, { signal: controller.signal }), AbortError)
    equal(opened, false)
  })

  it('registers release when acquisition completes during cancellation', async () => {
    const controller = new AbortController()
    const exits: Exit<unknown, unknown>[] = []
    let used = false
    let cleanupAborted = true
    const task = ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.tryPromise({
          try: async () => {
            controller.abort('stop')
            return 'connection'
          },
          catch: () => 'acquire' as const,
        }),
        release: (_resource, exit) =>
          ResultTask.tryPromise({
            try: async (signal) => {
              exits.push(exit)
              cleanupAborted = signal.aborted
            },
            catch: () => 'release' as const,
          }),
      })
      used = true
    })
    const expected = { _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'stop' } }
    deepEqual(await ResultTask.runExit(task, { signal: controller.signal }), expected)
    deepEqual(exits, [expected])
    equal(used, false)
    equal(cleanupAborted, false)
  })

  it('interrupts cooperative use, masks generator cleanup, and preserves release failures', async () => {
    const controller = new AbortController()
    const started = Promise.withResolvers<void>()
    let finallyRan = false
    let errorMapped = false
    const task = ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.succeed(undefined),
        release: () => ResultTask.fail('release'),
      })
      try {
        yield* ResultTask.tryPromise({
          try: (signal) =>
            new Promise<void>((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => {
                  reject(new Error('aborted'))
                },
                { once: true },
              )
              started.resolve()
            }),
          catch: () => {
            errorMapped = true
            return 'use' as const
          },
        })
      } finally {
        yield* ResultTask.sync(() => {
          finallyRan = true
        })
      }
    })
    const result = ResultTask.runExit(task, { signal: controller.signal })
    await started.promise
    controller.abort('shutdown')
    deepEqual(await result, {
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Interrupt', reason: 'shutdown' },
        right: { _tag: 'Fail', error: 'release' },
      },
    })
    equal(finallyRan, true)
    equal(errorMapped, false)
  })

  it('retains the acquisition service environment for release', async () => {
    const Logger = ResultTask.service<{ readonly close: () => void }, 'Logger'>('Logger')
    let closed = false
    const resource = ResultTask.acquireRelease({
      acquire: ResultTask.succeed(1),
      release: () =>
        ResultTask.gen(function* () {
          const logger = yield* Logger
          logger.close()
        }),
    })
    const provided = ResultTask.provideService(resource, Logger, {
      close: () => {
        closed = true
      },
    })
    deepEqual(await ResultTask.runResult(provided), { value: 1 })
    equal(closed, true)
  })

  it('closes resources acquired by a finalizer before proceeding to the next finalizer', async () => {
    const events: string[] = []
    const resource = ResultTask.acquireRelease({
      acquire: ResultTask.succeed(undefined),
      release: () =>
        ResultTask.gen(function* () {
          yield* ResultTask.acquireRelease({
            acquire: ResultTask.succeed(undefined),
            release: () =>
              ResultTask.sync(() => {
                events.push('nested')
              }),
          })
          events.push('release')
        }),
    })
    await ResultTask.runPromise(resource)
    deepEqual(events, ['release', 'nested'])
  })
})

describe('ResultTask cancellation lifetime', () => {
  it('waits for an uncooperative acquisition and releases its late result', async () => {
    const started = Promise.withResolvers<void>()
    const acquisition = Promise.withResolvers<string>()
    const controller = new AbortController()
    const events: string[] = []
    const resource = ResultTask.acquireRelease({
      acquire: ResultTask.tryPromise({
        try: () => {
          started.resolve()
          return acquisition.promise
        },
        catch: () => 'acquire' as const,
      }),
      release: (value) =>
        ResultTask.sync(() => {
          events.push(`release:${value}`)
        }),
    })
    const running = ResultTask.runExit(resource, { signal: controller.signal }).then((exit) => {
      events.push('exit')
      return exit
    })
    await started.promise
    controller.abort('stop')
    await Promise.resolve()
    deepEqual(events, [])
    acquisition.resolve('connection')
    deepEqual(await running, { _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'stop' } })
    deepEqual(events, ['release:connection', 'exit'])
  })

  it('does not interrupt cleanup when the caller aborts during release', async () => {
    const started = Promise.withResolvers<AbortSignal>()
    const finish = Promise.withResolvers<void>()
    const controller = new AbortController()
    const events: string[] = []
    const task = ResultTask.scoped(
      ResultTask.acquireRelease({
        acquire: ResultTask.succeed(undefined),
        release: () =>
          ResultTask.tryPromise({
            try: async (signal) => {
              started.resolve(signal)
              await finish.promise
              events.push('released')
            },
            catch: () => 'release' as const,
          }),
      }),
    )
    const running = ResultTask.runExit(task, { signal: controller.signal }).then((exit) => {
      events.push('exit')
      return exit
    })
    const cleanupSignal = await started.promise
    controller.abort('stop')
    equal(cleanupSignal.aborted, false)
    deepEqual(events, [])
    finish.resolve()
    deepEqual(await running, { _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'stop' } })
    deepEqual(events, ['released', 'exit'])
  })
})

describe('ResultTask scope inference', () => {
  it('retains release errors from nested acquisitions in finalizers', async () => {
    const resource = ResultTask.acquireRelease({
      acquire: ResultTask.succeed(undefined),
      release: () =>
        ResultTask.acquireRelease({
          acquire: ResultTask.succeed(undefined),
          release: () => ResultTask.fail('nested-release'),
        }),
    })
    expectTypeOf(resource).toEqualTypeOf<
      ResultTask<undefined, never, ResultTaskScope<'nested-release'>>
    >()
    const result = await ResultTask.runResult(resource)
    expectTypeOf(result).toEqualTypeOf<Result<undefined, 'nested-release'>>()
    deepEqual(result, { error: 'nested-release' })
  })

  it('does not run catchAll for a composite failure or leak removed errors as Fail', async () => {
    let recovered = false
    const task = ResultTask.scoped(
      ResultTask.gen(function* () {
        yield* ResultTask.acquireRelease({
          acquire: ResultTask.succeed(undefined),
          release: () => ResultTask.fail('release'),
        })
        yield* ResultTask.fail('use')
      }),
    ).catchAll(() =>
      ResultTask.sync(() => {
        recovered = true
      }),
    )
    expectTypeOf(task).toEqualTypeOf<ResultTask<void, never>>()
    const exit = await ResultTask.runExit(task)
    if (exit._tag !== 'Failure' || exit.cause._tag !== 'Die') throw new Error('Expected defect')
    equal(exit.cause.defect instanceof ResultTaskCauseError, true)
    deepEqual((exit.cause.defect as ResultTaskCauseError).cause, {
      _tag: 'Sequential',
      left: { _tag: 'Fail', error: 'use' },
      right: { _tag: 'Fail', error: 'release' },
    })
    equal(recovered, false)
  })

  it('keeps deferred errors through recovery and service provisioning', async () => {
    const Logger = ResultTask.service<{ readonly close: () => void }, 'Logger'>('Logger')
    const resource = ResultTask.acquireRelease({
      acquire: ResultTask.try({ try: () => 1, catch: () => 'acquire' as const }),
      release: () =>
        ResultTask.gen(function* () {
          const logger = yield* Logger
          logger.close()
          yield* ResultTask.fail('release')
        }),
    })
    expectTypeOf(resource).toEqualTypeOf<
      ResultTask<number, 'acquire', typeof Logger | ResultTaskScope<'release'>>
    >()
    const recovered = resource.catchAll(() => ResultTask.succeed(0))
    const provided = ResultTask.provideServices(recovered, { Logger: { close: () => undefined } })
    expectTypeOf(provided).toEqualTypeOf<ResultTask<number, never, ResultTaskScope<'release'>>>()
    const result = await ResultTask.runResult(provided)
    expectTypeOf(result).toEqualTypeOf<Result<number, 'release'>>()
    deepEqual(result, { error: 'release' })
    const scoped = ResultTask.scoped(resource)
    expectTypeOf(scoped).toEqualTypeOf<ResultTask<number, 'acquire' | 'release', typeof Logger>>()

    if (false) {
      // @ts-expect-error Release-only services must still be supplied.
      void ResultTask.runResult(resource)
      // @ts-expect-error Supplying services cannot erase deferred release failures.
      const erased: ResultTask<number> = provided
      void erased
    }
  })
})
