import { describe, expect, expectTypeOf, it, vi } from 'vite-plus/test'
import {
  Cause,
  Clock,
  constant,
  Fiber,
  flow,
  identity,
  err,
  Match,
  ok,
  pipe,
  Result,
  ResultAsync,
  ResultTask,
  ResultTaskCauseError,
  Retry,
  Semaphore,
} from '../src/index.js'
import type { ResultTaskScope } from '../src/index.js'
import { registerSemaphoreTaskFactory } from '../src/task/semaphore.js'
import {
  createFiberHandle,
  registerFiberTaskFactory,
  startFiber,
} from '../src/task/fiber-runtime.js'
import { detachedPromise } from '../src/task/promise-interruption.js'
import { TaskScope } from '../src/task/scope.js'

type Missing = { readonly _tag: 'Missing'; readonly id: string }
type Denied = { readonly _tag: 'Denied' }

describe('functional utilities', () => {
  it('preserves references and composes typed values without awaiting', () => {
    const value = { id: 1 }
    expect(identity(value)).toBe(value)
    expect(constant(value)()).toBe(value)
    expect(pipe(value)).toBe(value)
    expect(ok(value).pipe()._unsafeUnwrap()).toBe(value)
    expect(pipe(2, (n) => n + 1, String)).toBe('3')
    const promise = Promise.resolve(1)
    expect(pipe(promise, identity)).toBe(promise)
    const invalidPipeline = () => pipe(1, undefined as unknown as (value: number) => number)
    expect(invalidPipeline).toThrow(TypeError)
    expect(invalidPipeline).toThrow('pipe requires transformation functions')
    const invalidFnPipeline = () =>
      ResultTask.fn(
        function* (n: number) {
          return yield* ResultTask.ok(n)
        },
        undefined as unknown as (
          self: ResultTask<number, never>,
          arg: number,
        ) => ResultTask<number, never>,
      )(2)
    expect(invalidFnPipeline).toThrow(TypeError)
    expect(invalidFnPipeline).toThrow('pipe requires transformation functions')
    expect(ok<string, Error>('Ready').match({ ok: identity, error: constant('Unavailable') })).toBe(
      'Ready',
    )
    expect(
      err<string, Error>(new Error('offline')).match({
        ok: identity,
        error: constant('Unavailable'),
      }),
    ).toBe('Unavailable')
    const increment = (value: number) => value + 1
    const successful = ok<number, Missing>(0)
    expectTypeOf(successful.pipe()).toEqualTypeOf<typeof successful>()
    expect(
      successful.pipe(
        (result) => result._unsafeUnwrap(),
        increment,
        increment,
        increment,
        increment,
        increment,
        increment,
        increment,
      ),
    ).toBe(7)
    expect(
      pipe(
        0,
        increment,
        increment,
        increment,
        increment,
        increment,
        increment,
        increment,
        increment,
      ),
    ).toBe(8)
    expect(
      flow(
        increment,
        increment,
        increment,
        increment,
        increment,
        increment,
        increment,
        increment,
        increment,
      )(0),
    ).toBe(9)
    if (false) {
      // @ts-expect-error Intermediate pipeline types must agree.
      pipe(1, (value: string) => value.length)
    }
  })

  it('preserves flow parameters, receiver, and exceptions', () => {
    const composed = flow(function (this: { base: number }, value: number, extra = 0) {
      return this.base + value + extra
    }, String)
    expect(composed.call({ base: 2 }, 3)).toBe('5')
    const sum = flow((...values: number[]) => values.reduce((a, b) => a + b, 0), String)
    expect(sum(1, 2, 3)).toBe('6')
    const defect = new Error('pipeline')
    expect(() =>
      pipe(1, () => {
        throw defect
      }),
    ).toThrow(defect)
    expect(() =>
      flow(() => {
        throw defect
      })(),
    ).toThrow(defect)
  })
})

describe('task ergonomics', () => {
  it('defers fn and creates fresh generators with captured arguments and receiver', async () => {
    let visits = 0
    const load = ResultTask.fn(function* (this: { base: number }, id: number, extra = 0) {
      visits += 1
      return yield* ResultTask.ok(this.base + id + extra)
    })
    const task = load.call({ base: 2 }, 3)
    expect(visits).toBe(0)
    expectTypeOf(task).toEqualTypeOf<ResultTask<number>>()
    expect(await ResultTask.runPromise(task)).toBe(5)
    expect(await ResultTask.runPromise(task)).toBe(5)
    expect(visits).toBe(2)
  })

  it('infers fn errors and services and keeps generator cleanup', async () => {
    const Clock = ResultTask.service<{ now: () => number }>()('Clock')
    let closed = false
    const load = ResultTask.fn(function* (id: string) {
      const clock = yield* Clock
      try {
        yield* ResultTask.err<Missing>({ _tag: 'Missing', id })
        return clock.now()
      } finally {
        yield* ResultTask.sync(() => {
          closed = true
        })
      }
    })
    const task = load('abc')
    expectTypeOf(task).toEqualTypeOf<ResultTask<number, Missing, typeof Clock>>()
    expect(await ResultTask.runExit(task.provideService(Clock, { now: () => 1 }))).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: { _tag: 'Missing', id: 'abc' } },
    })
    expect(closed).toBe(true)
  })

  it('recovers selected tags in instance, direct, and curried forms', async () => {
    const source: ResultTask<number, Missing | Denied> = ResultTask.err({
      _tag: 'Missing',
      id: 'abc',
    })
    const recover = (error: Missing) => ResultTask.ok(error.id)
    const instance = source.catchTag('Missing', recover)
    expectTypeOf(instance).toEqualTypeOf<ResultTask<number | string, Denied>>()
    expect(await ResultTask.runPromise(instance)).toBe('abc')
    expect(await ResultTask.runPromise(ResultTask.catchTag(source, 'Missing', recover))).toBe('abc')
    expect(await ResultTask.runPromise(pipe(source, ResultTask.catchTag('Missing', recover)))).toBe(
      'abc',
    )
    const handlers = { Missing: recover }
    expect(await ResultTask.runPromise(source.catchTags(handlers))).toBe('abc')
    expect(await ResultTask.runPromise(ResultTask.catchTags(source, handlers))).toBe('abc')
    const partial = pipe(source, ResultTask.catchTags(handlers))
    expectTypeOf(partial).toEqualTypeOf<ResultTask<number | string, Denied>>()
    expect(await ResultTask.runPromise(partial)).toBe('abc')
    expect(
      await ResultTask.runExit(
        ResultTask.err<Missing | Denied>({ _tag: 'Denied' }).catchTags(handlers),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: { _tag: 'Denied' } } })
    if (false) {
      // @ts-expect-error Unknown tags cannot be handled.
      source.catchTag('Other', recover)
      // @ts-expect-error Unknown handler keys cannot be handled.
      source.catchTags({ Other: recover })
      // @ts-expect-error Curried recovery cannot accept an unrelated tag.
      ResultTask.catchTags({ Other: recover })(source)
      // @ts-expect-error Curried recovery cannot accept an unrelated tag.
      ResultTask.catchTag('Other', () => ResultTask.ok(1))(source)
    }
  })

  it('preserves scope errors and composite defects during recovery', async () => {
    const releaseError: Denied = { _tag: 'Denied' }
    const acquired = ResultTask.acquireRelease({
      acquire: ResultTask.ok(1),
      release: () => ResultTask.err(releaseError),
    })
    const task = acquired
      .andThen(() => ResultTask.err<Missing>({ _tag: 'Missing', id: 'abc' }))
      .catchTag('Missing', () => ResultTask.ok(2))
    expectTypeOf(task).toEqualTypeOf<ResultTask<number, never, ResultTaskScope<Denied>>>()
    expect(await ResultTask.runExit(ResultTask.scoped(task))).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: releaseError },
    })
    const composite = ResultTask.scoped(
      acquired.andThen(() => ResultTask.err<Missing>({ _tag: 'Missing', id: 'abc' })),
    )
    const exit = await ResultTask.runExit(composite.catchTags({ Missing: () => ResultTask.ok(2) }))
    expect(exit._tag).toBe('Failure')
    if (exit._tag === 'Failure' && exit.cause._tag === 'Die')
      expect(exit.cause.defect).toBeInstanceOf(ResultTaskCauseError)
  })

  it('unions recovery errors and requirements and propagates callback defects', async () => {
    const Clock = ResultTask.service<{ now: () => number }>()('RecoveryClock')
    const source: ResultTask<number, Missing | Denied> = ResultTask.err({
      _tag: 'Missing',
      id: 'abc',
    })
    const recovered = source.catchTags({
      Missing: () =>
        ResultTask.gen(function* () {
          const clock = yield* Clock
          return yield* ResultTask.err(clock.now())
        }),
    })
    expectTypeOf(recovered).toEqualTypeOf<ResultTask<number, Denied | number, typeof Clock>>()
    expect(await ResultTask.runExit(recovered.provideService(Clock, { now: () => 7 }))).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 7 },
    })
    const defect = new Error('handler')
    expect(
      await ResultTask.runExit(
        source.catchTag('Missing', () => {
          throw defect
        }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect } })
    let called = false
    const broken = ResultTask.sync(() => {
      throw defect
    }).catchTags({})
    expect(await ResultTask.runExit(broken)).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Die', defect },
    })
    const controller = new AbortController()
    controller.abort('stop')
    const interrupted = source.catchTag('Missing', () => {
      called = true
      return ResultTask.ok(1)
    })
    expect((await ResultTask.runExit(interrupted, { signal: controller.signal }))._tag).toBe(
      'Failure',
    )
    expect(called).toBe(false)
  })

  it('disposes once in LIFO order and prefers async disposal', async () => {
    const events: string[] = []
    const resource = {
      [Symbol.dispose]: () => {
        events.push('sync')
      },
      [Symbol.asyncDispose]: async () => {
        await Promise.resolve()
        events.push('async')
      },
    }
    const task = ResultTask.scoped(
      ResultTask.gen(function* () {
        yield* ResultTask.acquireDisposable(
          ResultTask.ok({
            [Symbol.dispose]: () => {
              events.push('first')
            },
          }),
        )
        return yield* ResultTask.acquireDisposable(ResultTask.ok(resource))
      }),
    )
    expect(await ResultTask.runPromise(task)).toBe(resource)
    expect(events).toEqual(['async', 'first'])
    expect(await ResultTask.runPromise(task)).toBe(resource)
    expect(events).toEqual(['async', 'first', 'async', 'first'])
  })

  it('preserves body and disposal failures and cleans up during abort', async () => {
    const defect = new Error('dispose')
    const task = ResultTask.acquireDisposable(
      ResultTask.ok({
        [Symbol.dispose]: () => {
          throw defect
        },
      }),
    ).andThen(() => ResultTask.err('body'))
    expect(await ResultTask.runExit(task)).toEqual({
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Fail', error: 'body' },
        right: { _tag: 'Die', defect },
      },
    })
    const controller = new AbortController()
    let released = 0
    const interrupted = ResultTask.acquireDisposable(
      ResultTask.sync(() => {
        controller.abort('stop')
        return {
          [Symbol.dispose]: () => {
            released += 1
          },
        }
      }),
    )
    expect(await ResultTask.runExit(interrupted, { signal: controller.signal })).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'stop' },
    })
    expect(released).toBe(1)
  })

  it('skips failed acquisitions and awaits rejected async disposal', async () => {
    type Resource = { [Symbol.dispose]: () => void }
    const acquire: ResultTask<Resource, Missing> = ResultTask.err({ _tag: 'Missing', id: 'abc' })
    const failed = ResultTask.acquireDisposable(acquire)
    expect((await ResultTask.runExit(failed))._tag).toBe('Failure')
    let disposed = false
    const defect = new Error('async disposal')
    const acquired = ResultTask.acquireDisposable(
      ResultTask.ok({
        [Symbol.asyncDispose]: async () => {
          await Promise.resolve()
          disposed = true
          throw defect
        },
      }),
    )
    expect(await ResultTask.runExit(acquired)).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Die', defect },
    })
    expect(disposed).toBe(true)
    if (false) {
      // @ts-expect-error Acquisition must return a disposable resource.
      ResultTask.acquireDisposable(ResultTask.ok({ value: 1 }))
    }
  })
})

/* eslint-disable max-statements, no-throw-literal, no-empty-function, no-promise-executor-return, init-declarations, prefer-promise-reject-errors, unicorn/no-array-for-each, unicorn/prefer-native-coercion-functions, unicorn/require-array-join-separator, @typescript-eslint/no-non-null-assertion, @typescript-eslint/only-throw-error, @typescript-eslint/prefer-promise-reject-errors */
describe('ResultTask runtime edge cases and combinator contracts', () => {
  it('validates retry, concurrency, tryPromise, and zip options with exact error messages', async () => {
    expect(() => ResultTask.forEach([1], (x) => ResultTask.ok(x), { concurrency: 0 })).toThrow(
      new RangeError('Task concurrency must be a positive safe integer or unbounded'),
    )

    expect(() => ResultTask.retry(ResultTask.err('fail'), { times: -1 })).toThrow(
      new RangeError('Task retries must be a non-negative safe integer'),
    )
    expect(() => ResultTask.retry(ResultTask.err('fail'), { times: 1.5 })).toThrow(
      new RangeError('Task retries must be a non-negative safe integer'),
    )
    expect(() => ResultTask.retry(ResultTask.err('fail'), { times: 1, backoff: 0.5 })).toThrow(
      new RangeError('Task backoff must be at least one'),
    )
    expect(() =>
      ResultTask.retry(ResultTask.err('fail'), { times: 1, backoff: Number.NaN }),
    ).toThrow(new RangeError('Task backoff must be at least one'))
    expect(() => ResultTask.retry(ResultTask.err('fail'), { times: 1, delayMs: -1 })).toThrow(
      new RangeError('Task duration must be a finite non-negative number'),
    )
    expect(() =>
      ResultTask.retry(
        ResultTask.err('fail'),
        Object.create(Retry.policy({ times: 1 }), { jittered: { value: -1 } }) as never,
      ),
    ).toThrow(new RangeError('Retry jittered must be a finite non-negative number'))

    expect(() =>
      ResultTask.tryPromise({ try: async () => 1, catch: (e) => e, interruption: 'bad' as never }),
    ).toThrow(new TypeError('Task promise interruption must be wait or detach'))

    const okTask = ResultTask.ok(1)
    expect(() => okTask.zip(okTask, null as never)).toThrow(
      new TypeError('ResultTask.zip options must be an object'),
    )
    expect(() => okTask.zip(okTask, [] as never)).toThrow(
      new TypeError('ResultTask.zip options must be an object'),
    )
    expect(() => okTask.zip(okTask, 'bad' as never)).toThrow(
      new TypeError('ResultTask.zip options must be an object'),
    )
    expect(() => okTask.zip(okTask, { concurrent: 'yes' as never })).toThrow(
      new TypeError('ResultTask.zip concurrent must be a boolean when provided'),
    )

    let attempts = 0
    const zeroRetry = ResultTask.gen(function* () {
      attempts += 1
      return yield* ResultTask.err('fail')
    }).retry({ times: 0 })
    expect(await ResultTask.runExit(zeroRetry)).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'fail' },
    })
    expect(attempts).toBe(1)

    let twoAttempts = 0
    const twoRetries = ResultTask.gen(function* () {
      twoAttempts += 1
      return yield* ResultTask.err('fail')
    }).retry({ times: 2, backoff: 1, delayMs: 0 })
    expect(await ResultTask.runExit(twoRetries)).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'fail' },
    })
    expect(twoAttempts).toBe(3)

    const slept: number[] = []
    const makeClock = (randomValue: number) => ({
      now: () => 0,
      sleep: async (ms: number) => {
        slept.push(ms)
      },
      random: () => randomValue,
    })

    await ResultTask.runExit(ResultTask.err('fail').retry({ times: 1, delayMs: 10 }), {
      clock: makeClock(0.5),
    })
    expect(slept).toEqual([10])

    slept.length = 0
    await ResultTask.runExit(
      ResultTask.err('fail').retry({ times: 1, delayMs: 10, jittered: true }),
      { clock: makeClock(0) },
    )
    await ResultTask.runExit(
      ResultTask.err('fail').retry({ times: 1, delayMs: 10, jittered: true }),
      { clock: makeClock(1) },
    )
    expect(slept).toEqual([0, 10])

    for (const badRandom of [Number.NaN, -0.1, 1.1]) {
      const badExit = await ResultTask.runExit(
        ResultTask.err('fail').retry({ times: 1, delayMs: 10, jittered: true }),
        { clock: makeClock(badRandom) },
      )
      expect(badExit._tag).toBe('Failure')
      if (badExit._tag === 'Failure') {
        expect(badExit.cause._tag).toBe('Die')
        if (badExit.cause._tag === 'Die') {
          expect(badExit.cause.defect).toEqual(
            new RangeError('Task clock random must return a number between zero and one'),
          )
        }
      }
    }
  })

  it('handles retry interruption during onRetry and during sleep', async () => {
    const controller1 = new AbortController()
    let sleepCalls = 0
    const clock1 = {
      now: () => 0,
      sleep: async () => {
        sleepCalls += 1
      },
      random: () => 0.5,
    }
    const retryTask1 = ResultTask.err('fail').retry(
      Retry.policy({
        times: 2,
        delayMs: 10,
        onRetry: async () => {
          controller1.abort('abort-in-onRetry')
          await new Promise<void>(() => {})
        },
      }),
    )
    expect(
      await ResultTask.runExit(retryTask1, { signal: controller1.signal, clock: clock1 }),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'abort-in-onRetry' } })
    expect(sleepCalls).toBe(0)

    const controller2 = new AbortController()
    const clock2 = {
      now: () => 0,
      sleep: async () => {
        controller2.abort('abort-in-sleep')
      },
      random: () => 0.5,
    }
    const curriedRetry = ResultTask.retry(Retry.policy({ times: 2, delayMs: 10 }))(
      ResultTask.err('fail'),
    )
    expect(
      await ResultTask.runExit(curriedRetry, { signal: controller2.signal, clock: clock2 }),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'abort-in-sleep' } })
  })

  it('preserves race winner signal, interrupts losers, and retains cleanup provenance across combinators', async () => {
    let loserReason: unknown
    let winnerSignal!: AbortSignal
    const winnerTask = ResultTask.tryPromise((signal) => {
      winnerSignal = signal
      return Promise.resolve(signal.aborted)
    })
    const loserTask = ResultTask.tryPromise(
      (signal) =>
        new Promise<boolean>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            loserReason = signal.reason
            reject(signal.reason)
          })
        }),
    )
    const raced = await ResultTask.runExit(ResultTask.race(winnerTask, loserTask))
    expect(raced).toEqual({ _tag: 'Success', value: false })
    expect(winnerSignal.aborted).toBe(false)
    expect(loserReason).toBe('ResultTask race lost')

    const winnerWithCleanup = ResultTask.scoped(
      ResultTask.acquireRelease({
        acquire: ResultTask.ok('w'),
        release: () => ResultTask.err('winner-cleanup'),
      }),
    )
    const slowLoser = ResultTask.tryPromise(
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason))
        }),
    )
    expect(await ResultTask.runExit(ResultTask.raceFirst(winnerWithCleanup, slowLoser))).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'winner-cleanup' },
    })

    // withoutInterruptions when left is Fail and right is Interrupt (left !== undefined && right === undefined)
    expect(
      await ResultTask.runExit(
        ResultTask.all([ResultTask.err('e1'), slowLoser], { concurrency: 2 }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'e1' } })

    const makeDelayedWinner = () =>
      ResultTask.tryPromise(
        () => new Promise<string>((resolve) => setTimeout(() => resolve('won'), 5)),
      )
    const singleCleanupFailure = ResultTask.scoped(
      ResultTask.acquireRelease({
        acquire: ResultTask.ok('a'),
        release: () => ResultTask.err('rel-1'),
      }),
    )

    // 1. sandbox preserves cleanup provenance only when originally cleanup-marked (including composite Parallel cleanup root)
    expect(
      await ResultTask.runExit(
        ResultTask.race(ResultTask.err('plain').sandbox(), makeDelayedWinner()),
      ),
    ).toEqual({ _tag: 'Success', value: 'won' })
    const sandboxCleanup = await ResultTask.runExit(
      ResultTask.race(singleCleanupFailure.sandbox(), makeDelayedWinner()),
    )
    expect(sandboxCleanup._tag).toBe('Failure')

    const compositeCleanupFailure = ResultTask.ok('v')
      .ensuring(() =>
        ResultTask.all(
          [
            ResultTask.tryPromise({
              try: () => Promise.reject('c1'),
              catch: (e) => String(e),
              interruption: 'detach',
            }),
            ResultTask.tryPromise({
              try: () => Promise.reject('c2'),
              catch: (e) => String(e),
              interruption: 'detach',
            }),
          ],
          { concurrency: 2 },
        ),
      )
      .sandbox()
    const sandboxCompositeCleanup = await ResultTask.runExit(
      ResultTask.race(compositeCleanupFailure, makeDelayedWinner()),
    )
    expect(sandboxCompositeCleanup).toEqual({
      _tag: 'Failure',
      cause: {
        _tag: 'Fail',
        error: {
          _tag: 'Parallel',
          left: { _tag: 'Fail', error: 'c1' },
          right: { _tag: 'Fail', error: 'c2' },
        },
      },
    })

    // 1b. mapErr preserves cleanup provenance on single-leaf cleanup cause
    expect(
      await ResultTask.runExit(
        ResultTask.race(
          singleCleanupFailure.mapErr((e) => `${e}!`),
          makeDelayedWinner(),
        ),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'rel-1!' } })

    // 1c. transformCause over depth-2 nested Cause tree
    const deepCause: Cause<string> = {
      _tag: 'Sequential',
      left: {
        _tag: 'Sequential',
        left: { _tag: 'Fail', error: 'a' },
        right: { _tag: 'Fail', error: 'b' },
      },
      right: {
        _tag: 'Parallel',
        left: { _tag: 'Fail', error: 'c' },
        right: { _tag: 'Fail', error: 'd' },
      },
    }
    expect(
      await ResultTask.runExit(
        ResultTask.err(deepCause)
          .unsandbox()
          .mapErr((s) => s.toUpperCase()),
      ),
    ).toEqual({
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: {
          _tag: 'Sequential',
          left: { _tag: 'Fail', error: 'A' },
          right: { _tag: 'Fail', error: 'B' },
        },
        right: {
          _tag: 'Parallel',
          left: { _tag: 'Fail', error: 'C' },
          right: { _tag: 'Fail', error: 'D' },
        },
      },
    })

    // 2. catchCause preserves cleanup provenance only when originally cleanup-marked
    expect(
      await ResultTask.runExit(
        ResultTask.race(
          ResultTask.err('plain').catchCause(() => ResultTask.err('remapped')),
          makeDelayedWinner(),
        ),
      ),
    ).toEqual({ _tag: 'Success', value: 'won' })
    const catchCauseCleanup = await ResultTask.runExit(
      ResultTask.race(
        singleCleanupFailure.catchCause(() => ResultTask.err('remapped')),
        makeDelayedWinner(),
      ),
    )
    expect(catchCauseCleanup).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'remapped' },
    })

    // 3. tapError synchronous throw preserves cleanup provenance only when originally cleanup-marked
    const tapThrowPlain = await ResultTask.runExit(
      ResultTask.race(
        ResultTask.err('plain').tapError(() => {
          throw 'tap-defect'
        }),
        makeDelayedWinner(),
      ),
    )
    expect(tapThrowPlain).toEqual({ _tag: 'Success', value: 'won' })
    const tapThrowCleanup = await ResultTask.runExit(
      ResultTask.race(
        singleCleanupFailure.tapError(() => {
          throw 'tap-defect'
        }),
        makeDelayedWinner(),
      ),
    )
    expect(tapThrowCleanup).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Die', defect: 'tap-defect' },
    })

    // 4. tapError returning failing ResultTask preserves cleanup provenance only when originally cleanup-marked
    expect(
      await ResultTask.runExit(
        ResultTask.race(
          ResultTask.err('plain').tapError(() => ResultTask.err('tap-fail')),
          makeDelayedWinner(),
        ),
      ),
    ).toEqual({ _tag: 'Success', value: 'won' })
    expect(
      await ResultTask.runExit(
        ResultTask.race(
          singleCleanupFailure.tapError(() => ResultTask.err('tap-fail')),
          makeDelayedWinner(),
        ),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'tap-fail' } })

    // 5. ensuring marks cleanup failure
    expect(
      await ResultTask.runExit(
        ResultTask.race(
          ResultTask.ok('v').ensuring(() => ResultTask.err('ensuring-fail')),
          makeDelayedWinner(),
        ),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'ensuring-fail' } })
  })

  it('handles catchCause, sandbox, unsandbox, and tapCause across internal and external interruptions', async () => {
    // catchCause and tapCause on Success
    let catchSuccessCalled = false
    let tapSuccessCalled = false
    expect(
      await ResultTask.runResult(
        ResultTask.ok(1)
          .catchCause(() => {
            catchSuccessCalled = true
            return ResultTask.ok(2)
          })
          .tapCause(() => {
            tapSuccessCalled = true
          }),
      ),
    ).toEqual(ok(1))
    expect(catchSuccessCalled).toBe(false)
    expect(tapSuccessCalled).toBe(false)

    // catchCause reuses context when context.signal is not aborted
    const activeController = new AbortController()
    expect(
      await ResultTask.runResult(
        ResultTask.err('e').catchCause(() =>
          ResultTask.tryPromise((s) => Promise.resolve(s === activeController.signal)),
        ),
        { signal: activeController.signal },
      ),
    ).toEqual(ok(true))

    // Internal Interrupt (outer signal is not aborted)
    const internalInterrupt = ResultTask.err({
      _tag: 'Interrupt',
      reason: 'internal',
    } as Cause<never>).unsandbox()
    expect(
      await ResultTask.runExit(
        internalInterrupt.catchCause((cause) => ResultTask.ok(`recovered:${cause._tag}`)),
      ),
    ).toEqual({ _tag: 'Success', value: 'recovered:Interrupt' })

    expect(await ResultTask.runExit(internalInterrupt.sandbox())).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: { _tag: 'Interrupt', reason: 'internal' } },
    })

    const tappedCauses: Cause<unknown>[] = []
    expect(
      await ResultTask.runExit(
        internalInterrupt.tapCause((cause) => {
          tappedCauses.push(cause)
        }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'internal' } })
    expect(tappedCauses).toEqual([{ _tag: 'Interrupt', reason: 'internal' }])

    // External Interrupt (outer signal is aborted) bypasses catchCause, sandbox, and tapCause
    const makeAbortedTask = () => {
      const controller = new AbortController()
      const task = ResultTask.sync(() => {
        controller.abort('external')
        return 'done'
      })
      return { controller, task }
    }

    const ext1 = makeAbortedTask()
    let catchCalled = false
    expect(
      await ResultTask.runExit(
        ext1.task.catchCause(() => {
          catchCalled = true
          return ResultTask.ok('recovered')
        }),
        { signal: ext1.controller.signal },
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'external' } })
    expect(catchCalled).toBe(false)

    const ext2 = makeAbortedTask()
    expect(
      await ResultTask.runExit(ext2.task.sandbox(), { signal: ext2.controller.signal }),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'external' } })

    const ext3 = makeAbortedTask()
    let tapCauseCalled = false
    expect(
      await ResultTask.runExit(
        ext3.task.tapCause(() => {
          tapCauseCalled = true
        }),
        { signal: ext3.controller.signal },
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'external' } })
    expect(tapCauseCalled).toBe(false)

    // Interrupted task with failing scope finalizer + catchCause
    const makeInterruptedCleanupTask = () => {
      const controller = new AbortController()
      const scoped = ResultTask.scoped(
        ResultTask.acquireRelease({
          acquire: ResultTask.sync(() => {
            controller.abort('stop-scope')
            return 'res'
          }),
          release: () => ResultTask.err('cleanup-err'),
        }),
      )
      return { controller, scoped }
    }

    const ic1 = makeInterruptedCleanupTask()
    expect(
      await ResultTask.runExit(
        ic1.scoped.catchCause(() => ResultTask.ok('recovered')),
        { signal: ic1.controller.signal },
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'stop-scope' } })

    const ic2 = makeInterruptedCleanupTask()
    expect(
      await ResultTask.runExit(
        ic2.scoped.catchCause(() => ResultTask.err('handler-err')),
        { signal: ic2.controller.signal },
      ),
    ).toEqual({
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Interrupt', reason: 'stop-scope' },
        right: { _tag: 'Fail', error: 'handler-err' },
      },
    })

    expect(
      await ResultTask.runExit(
        ResultTask.err('boom').catchCause(() => {
          throw 'sync-defect'
        }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'sync-defect' } })

    // unsandbox on Die (including Die whose defect looks like a Cause) and non-Cause Fail
    const dieTask = ResultTask.sync(() => {
      throw 'defect'
    }) as ResultTask<never, Cause<string>>
    expect(await ResultTask.runExit(dieTask.unsandbox())).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Die', defect: 'defect' },
    })
    const dieWithCauseLikeDefect = ResultTask.sync(() => {
      throw { _tag: 'Fail', error: 'inner' }
    }) as ResultTask<never, Cause<string>>
    expect(await ResultTask.runExit(dieWithCauseLikeDefect.unsandbox())).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Die', defect: { _tag: 'Fail', error: 'inner' } },
    })
    expect(
      await ResultTask.runExit(
        (ResultTask.err('plain') as unknown as ResultTask<never, Cause<string>>).unsandbox(),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'plain' } })

    // tapCause with async Promise and sync throw
    let asyncTapped = false
    expect(
      await ResultTask.runExit(
        ResultTask.err('e').tapCause(async () => {
          await Promise.resolve()
          asyncTapped = true
        }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'e' } })
    expect(asyncTapped).toBe(true)

    expect(
      await ResultTask.runExit(
        ResultTask.err('e').tapCause(() => {
          throw 'tap-cause-defect'
        }),
      ),
    ).toEqual({
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Fail', error: 'e' },
        right: { _tag: 'Die', defect: 'tap-cause-defect' },
      },
    })
  })

  it('distinguishes normal child scope from cleanup child scope when scheduler fails', async () => {
    let inNormalChild = false
    let normalChildStep2Ran = false
    const normalExit = await ResultTask.runExit(
      ResultTask.all([
        ResultTask.sync(() => {
          inNormalChild = true
          return 1
        }).andThen(() =>
          ResultTask.sync(() => {
            normalChildStep2Ran = true
            return 2
          }),
        ),
      ]),
      {
        scheduler: {
          yield: async () => {
            if (!inNormalChild) return
            throw 'sched-err'
          },
        },
        yieldEvery: 1,
      },
    )
    expect(normalChildStep2Ran).toBe(false)
    expect(normalExit).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'sched-err' } })

    const steps: string[] = []
    let schedCount = 0
    let inCleanupChild = false
    const cleanupExit = await ResultTask.runExit(
      ResultTask.ok('ok').ensuring(() =>
        ResultTask.all([
          ResultTask.sync(() => {
            inCleanupChild = true
            steps.push('step1')
            return 1
          }).andThen(() =>
            ResultTask.sync(() => {
              steps.push('step2')
              return 2
            }),
          ),
        ]),
      ),
      {
        scheduler: {
          yield: async () => {
            if (!inCleanupChild) return
            schedCount += 1
            throw `sched-${schedCount}`
          },
        },
        yieldEvery: 1,
      },
    )
    expect(steps).toEqual(['step1', 'step2'])
    expect(cleanupExit._tag).toBe('Failure')
    if (cleanupExit._tag === 'Failure') {
      expect(cleanupExit.cause._tag).toBe('Die')
    }
  })

  it('covers collection combinators: all, forEach, and validateAll edge cases', async () => {
    expect(await ResultTask.runExit(ResultTask.all([]))).toEqual({ _tag: 'Success', value: [] })

    let stoppedReason: unknown
    const slowChild = ResultTask.tryPromise(
      (signal) =>
        new Promise<number>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            stoppedReason = signal.reason
            reject(signal.reason)
          })
        }),
    )
    expect(
      await ResultTask.runExit(
        ResultTask.all([ResultTask.err('boom'), slowChild], { concurrency: 2 }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'boom' } })
    expect(stoppedReason).toBe('ResultTask collection stopped')

    expect(
      await ResultTask.runExit(
        ResultTask.all([
          ResultTask.err({
            _tag: 'Sequential',
            left: { _tag: 'Fail', error: 'left-fail' },
            right: { _tag: 'Interrupt', reason: 'right-int' },
          } satisfies Cause<string>).unsandbox(),
        ]),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'left-fail' } })

    const abortAllController = new AbortController()
    expect(
      await ResultTask.runExit(
        ResultTask.all([
          ResultTask.try({
            try: () => {
              abortAllController.abort('abort-all')
              throw 'fail-2'
            },
            catch: (e) => e,
          }),
        ]),
        { signal: abortAllController.signal },
      ),
    ).toEqual({
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Interrupt', reason: 'abort-all' },
        right: { _tag: 'Fail', error: 'fail-2' },
      },
    })

    const parallelFail = await ResultTask.runExit(
      ResultTask.all(
        [
          ResultTask.tryPromise({
            try: () => Promise.reject('e1'),
            catch: (e) => e,
            interruption: 'detach',
          }),
          ResultTask.tryPromise({
            try: () => Promise.reject('e2'),
            catch: (e) => e,
            interruption: 'detach',
          }),
        ],
        { concurrency: 2 },
      ),
    )
    expect(parallelFail).toEqual({
      _tag: 'Failure',
      cause: {
        _tag: 'Parallel',
        left: { _tag: 'Fail', error: 'e1' },
        right: { _tag: 'Fail', error: 'e2' },
      },
    })

    const recordFail = await ResultTask.runExit(
      ResultTask.all({ a: ResultTask.ok(1), b: ResultTask.err('rec-err') }),
    )
    expect(recordFail).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'rec-err' } })

    let mappedCount = 0
    const forEachThrow = await ResultTask.runExit(
      ResultTask.forEach(
        [1, 2, 3],
        (n) => {
          mappedCount += 1
          if (n === 1) throw 'mapper-boom'
          return ResultTask.ok(n)
        },
        { concurrency: 2 },
      ),
    )
    expect(forEachThrow).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'mapper-boom' } })
    expect(mappedCount).toBe(1)

    expect(
      await ResultTask.runResult(
        ResultTask.validateAll([ResultTask.ok(1), ResultTask.ok(2)], (t) => t),
      ),
    ).toEqual(ok([1, 2]))
    expect(
      await ResultTask.runResult(
        ResultTask.validateAll(
          [ResultTask.ok(1), ResultTask.err('bad'), ResultTask.ok(3)],
          (t) => t,
        ),
      ),
    ).toEqual(err(['bad']))

    const controller = new AbortController()
    const abortedValidate = await ResultTask.runExit(
      ResultTask.validateAll(
        [
          ResultTask.sync(() => {
            controller.abort('stop-validate')
            return 1
          }),
          ResultTask.err('ignored'),
        ],
        (t) => t,
      ),
      { signal: controller.signal },
    )
    expect(abortedValidate).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'stop-validate' },
    })
  })

  it('covers catchReason, catchReasons, unwrapReason, tapBoth, inspect*, and static type guards', async () => {
    type TaggedWithReason =
      | {
          readonly _tag: 'Outer'
          readonly reason: { readonly _tag: 'Inner'; readonly msg: string }
        }
      | {
          readonly _tag: 'Outer'
          readonly reason: { readonly _tag: 'Other'; readonly code: number }
        }
      | {
          readonly _tag: 'Different'
          readonly reason: { readonly _tag: 'Inner'; readonly msg: string }
        }

    const differentVal = { _tag: 'Different', reason: { _tag: 'Inner', msg: 'no' } } as const
    const nonMatchingVal = { _tag: 'Outer', reason: { _tag: 'Other', code: 404 } } as const
    const nullReasonVal = { _tag: 'Outer', reason: null } as const
    const primitiveReasonVal = { _tag: 'Outer', reason: 'primitive' } as const
    const taglessReasonVal = { _tag: 'Outer', reason: {} } as const

    for (const expectedError of [
      differentVal,
      nonMatchingVal,
      nullReasonVal,
      primitiveReasonVal,
      taglessReasonVal,
    ]) {
      const task = ResultTask.err(expectedError) as unknown as ResultTask<string, TaggedWithReason>
      expect(
        await ResultTask.runResult(task.catchReason('Outer', 'Inner', () => ok('ok'))),
      ).toEqual(err(expectedError))
      expect(
        await ResultTask.runResult(task.catchReasons('Outer', { Inner: () => ok('ok') })),
      ).toEqual(err(expectedError))
    }
    const diffTask = ResultTask.err(differentVal) as unknown as ResultTask<string, TaggedWithReason>
    expect(await ResultTask.runResult(diffTask.unwrapReason('Outer'))).toEqual(err(differentVal))

    const matchingTask: ResultTask<string, TaggedWithReason> = ResultTask.err({
      _tag: 'Outer',
      reason: { _tag: 'Inner', msg: 'found' },
    })
    expect(
      await ResultTask.runResult(
        ResultTask.catchReason(matchingTask, 'Outer', 'Inner', (r) => ok(r.msg)),
      ),
    ).toEqual(ok('found'))
    expect(
      await ResultTask.runResult(
        pipe(
          matchingTask,
          ResultTask.catchReason('Outer', 'Inner', (r) => ok(r.msg)),
        ),
      ),
    ).toEqual(ok('found'))
    expect(
      await ResultTask.runResult(
        ResultTask.catchReasons(matchingTask, 'Outer', { Inner: (r) => ok(r.msg) }),
      ),
    ).toEqual(ok('found'))
    expect(
      await ResultTask.runResult(
        pipe(
          matchingTask,
          ResultTask.catchReasons('Outer', { Inner: (r) => ResultTask.ok(r.msg) }),
        ),
      ),
    ).toEqual(ok('found'))
    expect(await ResultTask.runResult(ResultTask.unwrapReason(matchingTask, 'Outer'))).toEqual(
      err({ _tag: 'Inner', msg: 'found' }),
    )
    expect(
      await ResultTask.runResult(pipe(matchingTask, ResultTask.unwrapReason('Outer'))),
    ).toEqual(err({ _tag: 'Inner', msg: 'found' }))

    // tapBoth & inspectBoth overloads (including onSuccess/onFailure) and errors
    const events: string[] = []
    await ResultTask.runResult(
      ResultTask.ok(1).tapBoth({
        ok: (v) => {
          events.push(`ok:${v}`)
        },
        error: (e) => {
          events.push(`err:${String(e)}`)
        },
      }),
    )
    await ResultTask.runResult(
      ResultTask.ok(10).tapBoth({
        onSuccess: (v) => {
          events.push(`onSuccess:${v}`)
        },
        onFailure: (e) => {
          events.push(`onFailure:${String(e)}`)
        },
      }),
    )
    await ResultTask.runResult(
      ResultTask.err('bad').tapBoth(
        (v) => {
          events.push(`ok:${String(v)}`)
        },
        (e) => {
          events.push(`err:${e}`)
        },
      ),
    )
    await ResultTask.runResult(
      ResultTask.tapBoth(
        ResultTask.ok(2),
        (v) => {
          events.push(`static-ok:${v}`)
        },
        (e) => {
          events.push(`static-err:${String(e)}`)
        },
      ),
    )
    await ResultTask.runResult(
      ResultTask.tapBoth<number, string>(
        (v) => {
          events.push(`curried-ok:${v}`)
        },
        (e) => {
          events.push(`curried-err:${e}`)
        },
      )(ResultTask.err('e2')),
    )
    await ResultTask.runResult(
      ResultTask.tapBoth<number, string>({
        ok: (v) => {
          events.push(`curried-obj-ok:${v}`)
        },
        error: (e) => {
          events.push(`curried-obj-err:${e}`)
        },
      })(ResultTask.ok(3)),
    )
    await ResultTask.runResult(
      ResultTask.inspectBoth(
        ResultTask.ok(4),
        (v) => {
          events.push(`insp-ok:${v}`)
        },
        (e) => {
          events.push(`insp-err:${String(e)}`)
        },
      ),
    )
    await ResultTask.runResult(
      ResultTask.inspectBoth<number, string>(
        (v) => {
          events.push(`insp-curried-ok:${v}`)
        },
        (e) => {
          events.push(`insp-curried-err:${e}`)
        },
      )(ResultTask.err('e4')),
    )
    await ResultTask.runResult(
      ResultTask.inspectBoth(ResultTask.ok(5), {
        onSuccess: (v) => {
          events.push(`insp-obj-ok:${v}`)
        },
        onFailure: (e) => {
          events.push(`insp-obj-err:${String(e)}`)
        },
      }),
    )
    expect(events).toEqual([
      'ok:1',
      'onSuccess:10',
      'err:bad',
      'static-ok:2',
      'curried-err:e2',
      'curried-obj-ok:3',
      'insp-ok:4',
      'insp-curried-err:e4',
      'insp-obj-ok:5',
    ])

    // inspectError on Success & Die, inspectCause on Success, static inspect & inspectCause
    let inspectedErr = false
    await ResultTask.runExit(
      ResultTask.ok(1).inspectError(() => {
        inspectedErr = true
      }),
    )
    await ResultTask.runExit(
      ResultTask.sync(() => {
        throw 'boom'
      }).inspectError(() => {
        inspectedErr = true
      }),
    )
    await ResultTask.runExit(
      ResultTask.ok(1).inspectCause(() => {
        inspectedErr = true
      }),
    )
    expect(inspectedErr).toBe(false)

    const staticInspected: unknown[] = []
    await ResultTask.runExit(
      ResultTask.inspect(ResultTask.ok('a'), (v) => {
        staticInspected.push(v)
      }),
    )
    await ResultTask.runExit(
      ResultTask.inspect<string>((v) => {
        staticInspected.push(`c:${v}`)
      })(ResultTask.ok('b')),
    )
    await ResultTask.runExit(
      ResultTask.inspectCause(ResultTask.err('ce'), (c) => {
        staticInspected.push(c._tag)
      }),
    )
    await ResultTask.runExit(
      ResultTask.inspectCause<string>((c) => {
        staticInspected.push(`cc:${c._tag}`)
      })(ResultTask.err('ce2')),
    )
    expect(staticInspected).toEqual(['a', 'c:b', 'Fail', 'cc:Fail'])

    // unwrapOr direct & curried
    expect(await ResultTask.runResult(ResultTask.unwrapOr(ResultTask.err('e'), 99))).toEqual(ok(99))
    expect(await ResultTask.runResult(ResultTask.unwrapOr(42)(ResultTask.err('e')))).toEqual(ok(42))

    // race curried
    expect(
      await ResultTask.runResult(ResultTask.race(ResultTask.ok('r'))(ResultTask.ok('l'))),
    ).toEqual(ok('l'))

    // zip static & curried forms (including sync Result, empty options {}, and sequential short-circuit)
    expect(await ResultTask.runResult(ResultTask.ok(1).zip(ResultTask.ok(2), {}))).toEqual(
      ok([1, 2]),
    )
    let rightStarted = false
    expect(
      await ResultTask.runResult(
        ResultTask.err('left-err').zip(
          ResultTask.sync(() => {
            rightStarted = true
            return 2
          }),
          { concurrent: false },
        ),
      ),
    ).toEqual(err('left-err'))
    expect(rightStarted).toBe(false)

    expect(await ResultTask.runResult(ResultTask.zip(ResultTask.ok(2))(ResultTask.ok(1)))).toEqual(
      ok([1, 2]),
    )
    expect(
      await ResultTask.runResult(
        ResultTask.zip(ResultTask.ok(2), { concurrent: false })(ResultTask.ok(1)),
      ),
    ).toEqual(ok([1, 2]))
    expect(await ResultTask.runResult(ResultTask.zip(ResultTask.ok(1), ok(2)))).toEqual(ok([1, 2]))
    expect(await ResultTask.runResult(ResultTask.zip(ok(2))(ResultTask.ok(1)))).toEqual(ok([1, 2]))

    // Static TypeError guards
    const ok1 = ResultTask.ok(1)
    expect(() => (ok1.tapBoth as unknown as (fn: () => void) => unknown)(() => {})).toThrow(
      new TypeError('ResultTask.tapBoth requires an error side-effect function'),
    )
    expect(() =>
      (ResultTask.tapBoth as (t: unknown, fn: () => void) => unknown)(ok1, () => {}),
    ).toThrow(new TypeError('ResultTask.tapBoth requires an error side-effect function'))
    expect(() => (ok1.inspectBoth as unknown as (fn: () => void) => unknown)(() => {})).toThrow(
      new TypeError('ResultTask.inspectBoth requires an error handler'),
    )
    expect(() =>
      (ResultTask.inspectBoth as (t: unknown, fn: () => void) => unknown)(ok1, () => {}),
    ).toThrow(new TypeError('ResultTask.inspectBoth requires an error handler'))
    expect(() => Semaphore.make(1).withPermits(1, 'bad' as never)).toThrow(
      new TypeError('Semaphore.withPermits requires a task'),
    )
    expect(() => (ResultTask.race as () => unknown)()).toThrow(
      new TypeError('ResultTask.race requires a task'),
    )
    expect(() => ResultTask.race(ok1, undefined as never)).toThrow(
      new TypeError('ResultTask.race requires two tasks'),
    )
    expect(() => (ResultTask.raceFirst as () => unknown)()).toThrow(
      new TypeError('ResultTask.raceFirst requires a task'),
    )
    expect(() => ResultTask.raceFirst(ok1, undefined as never)).toThrow(
      new TypeError('ResultTask.raceFirst requires two tasks'),
    )
    expect(() => (ResultTask.unwrapOr as (t: unknown) => unknown)(ok1)).toThrow(
      new TypeError('ResultTask.unwrapOr requires a default value'),
    )
    expect(() => ResultTask.unwrapOr('bad' as never, 1)).toThrow(
      new TypeError('ResultTask.unwrapOr requires a task'),
    )
    expect(() => ResultTask.catchTags('bad' as never, {})).toThrow(
      new TypeError('ResultTask.catchTags requires a task'),
    )
    expect(() =>
      ResultTask.catchReason(null as never, 'A' as never, 'B' as never, () => ok1),
    ).toThrow(new TypeError('ResultTask.catchReason requires a task'))
    expect(() => ResultTask.catchReasons(null as never, 'A' as never, {} as never)).toThrow(
      new TypeError('ResultTask.catchReasons requires a task'),
    )
    expect(() => ResultTask.unwrapReason(null as never, 'A' as never)).toThrow(
      new TypeError('ResultTask.unwrapReason requires a task'),
    )
    expect(() => ResultTask.catchCause('bad' as never, () => ok1)).toThrow(
      new TypeError('ResultTask.catchCause requires a task'),
    )
    expect(() => ResultTask.sandbox('bad' as never)).toThrow(
      new TypeError('ResultTask.sandbox requires a task'),
    )
    expect(() => ResultTask.unsandbox('bad' as never)).toThrow(
      new TypeError('ResultTask.unsandbox requires a task'),
    )
    expect(() => ResultTask.inspect('bad' as never, () => {})).toThrow(
      new TypeError('ResultTask.inspect requires a task'),
    )
    expect(() => ResultTask.inspectError('bad' as never, () => {})).toThrow(
      new TypeError('ResultTask.inspectError requires a task'),
    )
    expect(() => ResultTask.inspectCause('bad' as never, () => {})).toThrow(
      new TypeError('ResultTask.inspectCause requires a task'),
    )
    expect(() => ResultTask.asVoid('bad' as never)).toThrow(
      new TypeError('ResultTask.asVoid requires a task'),
    )
    expect(() => ResultTask.delay('bad' as never, 10)).toThrow(
      new TypeError('ResultTask.delay requires a task'),
    )
    expect(() => ResultTask.timed('bad' as never)).toThrow(
      new TypeError('ResultTask.timed requires a task'),
    )
    expect(() => ResultTask.ensuring('bad' as never, () => {})).toThrow(
      new TypeError('ResultTask.ensuring requires a task'),
    )
    expect(() => ResultTask.ensuring(ok1, 'bad' as never)).toThrow(
      new TypeError('ResultTask.ensuring requires a finalizer function'),
    )
    expect(() => ResultTask.onExit('bad' as never, () => {})).toThrow(
      new TypeError('ResultTask.onExit requires a task'),
    )
    expect(() => ResultTask.onExit(ok1, 'bad' as never)).toThrow(
      new TypeError('ResultTask.onExit requires a finalizer function'),
    )
    expect(() => ResultTask.zip('bad' as never, ok1)).toThrow(
      new TypeError('ResultTask.zip requires a task'),
    )
  })

  it('covers ensuring/onExit promise & throw finalizers, Semaphore abort-after-acquire, and control-flow combinator edge cases', async () => {
    let promiseFinalizerDone = false
    expect(
      await ResultTask.runExit(
        ResultTask.onExit(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 5))
          promiseFinalizerDone = true
        })(ResultTask.ok('v')),
      ),
    ).toEqual({ _tag: 'Success', value: 'v' })
    expect(promiseFinalizerDone).toBe(true)

    expect(
      await ResultTask.runExit(
        ResultTask.ensuring(ResultTask.ok('v'), () => {
          throw 'finalizer-defect'
        }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'finalizer-defect' } })

    // Retry edge cases: abort during attempt with legacy options & clock defect during sleep
    const retryAbortController = new AbortController()
    let retryAttempts = 0
    expect(
      await ResultTask.runExit(
        ResultTask.retry(
          ResultTask.try({
            try: () => {
              retryAttempts += 1
              retryAbortController.abort('stop-retry')
              throw 'retry-err'
            },
            catch: (e) => String(e),
          }),
          { times: 2 },
        ),
        { signal: retryAbortController.signal },
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'retry-err' } })
    expect(retryAttempts).toBe(1)

    expect(
      await ResultTask.runExit(ResultTask.retry(ResultTask.err('e'), { times: 2, delayMs: 10 }), {
        clock: { now: () => 0, sleep: () => Promise.reject('clock-defect'), random: () => 0.5 },
      }),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'clock-defect' } })

    // Semaphore abort right when permit is granted
    const sem = Semaphore.make(1)
    let releaseHolder!: () => void
    const holder = sem.withPermits(
      1,
      ResultTask.tryPromise(
        () =>
          new Promise<string>((resolve) => {
            releaseHolder = () => resolve('held')
          }),
      ),
    )
    const holderFiber = ResultTask.runFork(holder)
    await Promise.resolve()

    const waiterController = new AbortController()
    let waiterBodyRan = false
    const waiterFiber = ResultTask.runFork(
      sem.withPermits(
        1,
        ResultTask.sync(() => {
          waiterBodyRan = true
          return 'waiter'
        }),
      ),
      { signal: waiterController.signal },
    )
    await Promise.resolve()
    releaseHolder()
    waiterController.abort('cancel-waiter')
    expect(await ResultTask.runExit(waiterFiber.join())).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'cancel-waiter' },
    })
    expect(waiterBodyRan).toBe(false)
    expect(await ResultTask.runExit(holderFiber.join())).toEqual({ _tag: 'Success', value: 'held' })

    // Control-flow combinators: firstSuccessOf, if, when, loop, iterate, runFork pre-aborted
    const preAborted = AbortSignal.abort('pre-aborted')
    expect(
      await ResultTask.runExit(ResultTask.firstSuccessOf([ResultTask.ok(1)]), {
        signal: preAborted,
      }),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'pre-aborted' } })

    const midFirstController = new AbortController()
    expect(
      await ResultTask.runExit(
        ResultTask.firstSuccessOf([
          () => {
            midFirstController.abort('mid-first')
            return err('e1')
          },
          () => err('e2'),
        ]),
        { signal: midFirstController.signal },
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'mid-first' } })

    expect(
      await ResultTask.runExit(
        ResultTask.firstSuccessOf([
          ResultTask.sync(() => {
            throw 'fatal'
          }),
          ResultTask.ok(2),
        ]),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'fatal' } })

    expect(
      await ResultTask.runExit(
        ResultTask.when(
          () => {
            throw 'cond-boom'
          },
          () => ResultTask.ok(1),
        ),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'cond-boom' } })

    expect(
      await ResultTask.runExit(
        ResultTask.when(true, () => {
          throw 'branch-boom'
        }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'branch-boom' } })

    expect(
      await ResultTask.runExit(
        ResultTask.if(ResultTask.err('cond-err'), {
          onTrue: () => ResultTask.ok(1),
          onFalse: () => ResultTask.ok(0),
        }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'cond-err' } })

    expect(
      await ResultTask.runExit(
        ResultTask.loop(0, {
          while: (n) => n < 2,
          step: (n) => n + 1,
          body: (n) => ResultTask.ok(n),
        }),
        { signal: preAborted },
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'pre-aborted' } })

    const abortInStepController = new AbortController()
    expect(
      await ResultTask.runExit(
        ResultTask.loop(0, {
          while: (n) => n < 2,
          step: (n) => {
            abortInStepController.abort('abort-in-step')
            return n + 1
          },
          body: (n) => (n === 0 ? ok(0) : err('should-not-run')),
        }),
        { signal: abortInStepController.signal },
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'abort-in-step' } })

    expect(
      await ResultTask.runExit(
        ResultTask.loop(0, {
          while: () => {
            throw 'while-boom'
          },
          step: (n) => n + 1,
          body: (n) => ResultTask.ok(n),
        }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'while-boom' } })

    expect(
      await ResultTask.runExit(
        ResultTask.loop(0, {
          while: (n) => n < 2,
          step: (n) => n + 1,
          body: () => ResultTask.err('loop-body-err'),
        }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'loop-body-err' } })

    expect(
      await ResultTask.runExit(
        ResultTask.loop(0, {
          while: (n) => n < 2,
          step: () => {
            throw 'step-boom'
          },
          body: (n) => ResultTask.ok(n),
        }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'step-boom' } })

    expect(
      await ResultTask.runExit(
        ResultTask.iterate(0, { while: (n) => n < 2, body: (n) => ResultTask.ok(n + 1) }),
        { signal: preAborted },
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'pre-aborted' } })

    expect(
      await ResultTask.runExit(
        ResultTask.iterate(0, {
          while: () => {
            throw 'iter-while-boom'
          },
          body: (n) => ResultTask.ok(n + 1),
        }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'iter-while-boom' } })

    expect(
      await ResultTask.runExit(
        ResultTask.iterate(0, { while: (n) => n < 2, body: () => ResultTask.err('iter-body-err') }),
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'iter-body-err' } })

    const preAbortedFork = ResultTask.runFork(
      ResultTask.tryPromise(
        (signal) =>
          new Promise<number>((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason)
          }),
      ),
      { signal: preAborted },
    )
    expect(await ResultTask.runExit(preAbortedFork.join())).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'pre-aborted' },
    })
  })

  it('covers remaining branches in cause, match, retry, clock, scheduler, scope, semaphore, fiber, result-async, and result-task', async () => {
    expect(
      Cause.defects({
        _tag: 'Sequential',
        left: { _tag: 'Fail', error: 'e' },
        right: { _tag: 'Die', defect: 'boom' },
      }),
    ).toEqual(['boom'])

    expect(
      Match.value(null as unknown as { readonly _tag: 'A' })
        .tag('A', () => 1)
        .orElse(() => 0),
    ).toBe(0)
    expect(
      Match.value(Object.assign(() => 'fn', { _tag: 'Fn' as const }))
        .tag('Fn', () => 1)
        .exhaustive(),
    ).toBe(1)

    const badRandomExit = await ResultTask.runExit(
      ResultTask.err('e').retry(Retry.policy({ times: 1, delayMs: 10, jittered: 0.5 })),
      { clock: { now: () => 0, sleep: async () => {}, random: () => -1 } },
    )
    expect(badRandomExit._tag).toBe('Failure')
    if (badRandomExit._tag === 'Failure') {
      expect(badRandomExit.cause._tag).toBe('Die')
    }

    const closingScope = new TaskScope()
    void closingScope.close({ _tag: 'Success', value: undefined })
    expect(() =>
      closingScope.addChild({
        interrupt: () => {},
        close: async () => ({ _tag: 'Success', value: undefined }),
      }),
    ).toThrow('Cannot fork into a closing ResultTask scope')

    const multiChildScope = new TaskScope()
    multiChildScope.addChild({
      interrupt: () => {},
      close: async () => ({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'child-a' } }),
    })
    multiChildScope.addChild({
      interrupt: () => {},
      close: async () => ({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'child-b' } }),
    })
    expect(await multiChildScope.close({ _tag: 'Success', value: undefined })).toEqual({
      _tag: 'Failure',
      cause: {
        _tag: 'Parallel',
        left: { _tag: 'Fail', error: 'child-a' },
        right: { _tag: 'Fail', error: 'child-b' },
      },
    })

    expect(
      await detachedPromise(
        AbortSignal.abort('pre-detach'),
        async () => 1,
        (e) => e,
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'pre-detach' } })

    const mutableSignal = {
      aborted: false,
      reason: 'late-abort',
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    expect(
      await detachedPromise(
        mutableSignal as unknown as AbortSignal,
        async () => {
          mutableSignal.aborted = true
          throw new Error('ignored')
        },
        (e) => e,
      ),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'late-abort' } })

    expect(
      await ResultTask.runPromise(
        ResultTask.all([ResultTask.ok(1).map((x) => x + 1), ResultTask.ok(2).map((x) => x + 1)], {
          concurrency: 2,
        }),
        { yieldEvery: 1 },
      ),
    ).toEqual([2, 3])

    expect(() => Clock.virtual(-1)).toThrow(RangeError)
    expect(typeof Clock.live.now()).toBe('number')
    expect(Clock.live.random()).toBeGreaterThanOrEqual(0)
    await expect(Clock.live.sleep(10, AbortSignal.abort('stop-live'))).rejects.toThrow(
      'Task sleep interrupted',
    )
    const nowSpy = vi.spyOn(performance, 'now')
    try {
      const readings = [100, 100, 100.5, 100.5, 102]
      nowSpy.mockImplementation(() => readings.shift() ?? 102)
      await Clock.live.sleep(1, new AbortController().signal)
    } finally {
      nowSpy.mockRestore()
    }
    expect(Clock.virtual().random()).toBe(0.5)
    await expect(Clock.virtual().sleep(10, AbortSignal.abort('stop-virt'))).rejects.toThrow(
      'Task sleep interrupted',
    )
    const maxClock = Clock.virtual(Number.MAX_VALUE)
    await expect(maxClock.advanceBy(Number.MAX_VALUE)).rejects.toThrow(RangeError)

    const prevSemFactory = registerSemaphoreTaskFactory(undefined)
    try {
      expect(() => Semaphore.make(1).withPermit(ResultTask.ok(1))).toThrow(
        'ResultTask has not initialized',
      )
    } finally {
      registerSemaphoreTaskFactory(prevSemFactory)
    }
    expect(() => Semaphore.withPermit(null as never)).toThrow(TypeError)
    expect(() => Semaphore.withPermits({} as never, 1)).toThrow(TypeError)
    expect(
      await ResultTask.runPromise(Semaphore.withPermits(Semaphore.make(1), 1, ResultTask.ok(42))),
    ).toBe(42)
    expect(
      await ResultTask.runPromise(Semaphore.withPermit(Semaphore.make(1))(ResultTask.ok(42))),
    ).toBe(42)

    let abortReads = 0
    const flipAbortSignal = {
      get aborted() {
        abortReads += 1
        return abortReads >= 3
      },
      reason: 'flip-abort',
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as AbortSignal
    expect(
      await ResultTask.runExit(Semaphore.make(1).withPermit(ResultTask.ok(1)), {
        signal: flipAbortSignal,
      }),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'flip-abort' } })

    const prevFiberFactory = registerFiberTaskFactory(undefined)
    try {
      const dummyFiber = ResultTask.runFork(ResultTask.ok(1))
      expect(() => Fiber.await(dummyFiber)).toThrow('ResultTask has not initialized')
    } finally {
      registerFiberTaskFactory(prevFiberFactory)
    }

    const throwingCustomFiber = {
      id: 999,
      poll: () => ({ _tag: 'Success' as const, value: 1 }),
      await: () => ResultTask.ok({ _tag: 'Success' as const, value: 1 }),
      join: () => {
        throw 'custom-join-boom'
      },
      interrupt: () => ResultTask.ok({ _tag: 'Success' as const, value: 1 }),
      addObserver: () => () => {},
    }
    expect(
      await ResultTask.runExit(Fiber.join(throwingCustomFiber, { interruption: 'detach' })),
    ).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect: 'custom-join-boom' } })

    const rawRejectOutcome = Promise.reject(new Error('raw-fiber-reject'))
    const rawRejectHandle = createFiberHandle<number, never>({
      outcome: rawRejectOutcome,
      interrupt: () => {},
      observe: () => {},
    })
    const rawRejectExit = await ResultTask.runExit(Fiber.join(rawRejectHandle))
    expect(rawRejectExit._tag).toBe('Failure')
    const lateDisposer = rawRejectHandle.addObserver(() => {})
    lateDisposer()

    const preAbortedStartFiber = startFiber({
      scope: new TaskScope(),
      signal: AbortSignal.abort('start-fiber-pre'),
      prepare: (_scope, signal) => ({
        execute: async () =>
          signal.aborted
            ? { _tag: 'Failure', cause: { _tag: 'Interrupt', reason: signal.reason } }
            : { _tag: 'Success', value: 1 },
        complete: (exit) => exit,
      }),
    })
    expect(await ResultTask.runExit(Fiber.await(preAbortedStartFiber.handle))).toEqual({
      _tag: 'Success',
      value: { _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'start-fiber-pre' } },
    })

    const rejectingStartFiber = startFiber({
      scope: new TaskScope(),
      signal: new AbortController().signal,
      prepare: () => ({
        execute: () => Promise.reject('raw-execute-reject'),
        complete: (exit) => exit,
      }),
    })
    expect(await ResultTask.runExit(Fiber.await(rejectingStartFiber.handle))).toEqual({
      _tag: 'Success',
      value: { _tag: 'Failure', cause: { _tag: 'Die', defect: 'raw-execute-reject' } },
    })

    const fnIterable = Object.assign(() => {}, {
      *[Symbol.iterator]() {
        yield ResultAsync.ok(7)
      },
    })
    expect(
      (
        await ResultAsync.combine(fnIterable as unknown as readonly [ResultAsync<number, never>])
      )._unsafeUnwrap(),
    ).toEqual([7])
    expect(await ResultAsync.combine('' as never)).toEqual(Result.ok({}))

    await expect(
      ResultAsync.forEach([1], () => {
        throw 'raw-string-throw'
      }),
    ).rejects.toThrow('raw-string-throw')

    await expect(
      ResultAsync.forEach(
        [1, 2],
        (x) => {
          if (x === 1) {
            return new ResultAsync(Promise.reject(new Error('reject-1')))
          }
          throw new Error('reject-2')
        },
        { concurrency: 2 },
      ),
    ).rejects.toThrow('reject-2')

    const seenErr: string[] = []
    const errDisposable = ResultAsync.err('disp-err').toAsyncDisposable((_val, errVal) => {
      if (errVal !== undefined) seenErr.push(errVal)
    })
    await errDisposable[Symbol.asyncDispose]()
    expect(seenErr).toEqual(['disp-err'])

    type TaggedWithReasons =
      | { readonly _tag: 'Target'; readonly reason: { readonly _tag: 'R' } }
      | { readonly _tag: 'Other' }
    const nonMatchingReasonResult = await (
      ResultAsync.err({ _tag: 'Other' }) as ResultAsync<number, TaggedWithReasons>
    ).catchReasons('Target', { R: () => Result.ok(1) })
    expect(nonMatchingReasonResult).toEqual(Result.err({ _tag: 'Other' }))

    expect(
      await ResultTask.runResult(ResultTask.err('retry-no-delay').retry({ times: 1 })),
    ).toEqual(Result.err('retry-no-delay'))
    expect(
      await ResultTask.runResult(
        (
          ResultTask.err({ _tag: 'B' as const }) as ResultTask<
            number,
            { readonly _tag: 'A' } | { readonly _tag: 'B' }
          >
        ).catchTag('A', () => ResultTask.ok(1)),
      ),
    ).toEqual(Result.err({ _tag: 'B' }))

    expect(
      await ResultTask.runResult(ResultTask.err('a').catchCause(() => Result.err('b'))),
    ).toEqual(Result.err('b'))

    expect(
      await ResultTask.runPromise(ResultTask.ok(1).zip(Result.ok(2), { concurrent: true })),
    ).toEqual([1, 2])

    /* eslint-disable typescript/no-deprecated -- Verifies retained deprecated static ResultTask methods. */
    expect(() => ResultTask.mapError(null as never)).toThrow(TypeError)
    expect(() => ResultTask.flatMap(null as never)).toThrow(TypeError)
    expect(() => ResultTask.catchAll(null as never)).toThrow(TypeError)
    /* eslint-enable typescript/no-deprecated */
    expect(() => ResultTask.orElseSucceed(null as never)).toThrow(TypeError)
    expect(() => ResultTask.tapCause(null as never)).toThrow(TypeError)

    expect(await ResultTask.runResult(ResultTask.timed(ResultTask.err('timed-err')))).toEqual(
      Result.err('timed-err'),
    )
    expect(
      await ResultTask.runResult(ResultTask.when(Result.err('cond-err'), ResultTask.ok(1))),
    ).toEqual(Result.err('cond-err'))

    const badOptionsFork = ResultTask.runFork(ResultTask.ok(1), {
      get signal(): AbortSignal {
        throw 'bad-signal-getter'
      },
    })
    expect(await ResultTask.runExit(badOptionsFork.interrupt())).toEqual({
      _tag: 'Success',
      value: { _tag: 'Failure', cause: { _tag: 'Die', defect: 'bad-signal-getter' } },
    })
  })
})
