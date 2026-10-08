import { describe, expect, expectTypeOf, it } from 'vite-plus/test'
import {
  constant,
  flow,
  identity,
  err,
  ok,
  pipe,
  ResultTask,
  ResultTaskCauseError,
} from '../src/index.js'
import type { ResultTaskScope } from '../src/index.js'

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
      return yield* ResultTask.succeed(this.base + id + extra)
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
        yield* ResultTask.fail<Missing>({ _tag: 'Missing', id })
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
    const source: ResultTask<number, Missing | Denied> = ResultTask.fail({
      _tag: 'Missing',
      id: 'abc',
    })
    const recover = (error: Missing) => ResultTask.succeed(error.id)
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
        ResultTask.fail<Missing | Denied>({ _tag: 'Denied' }).catchTags(handlers),
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
      ResultTask.catchTag('Other', () => ResultTask.succeed(1))(source)
    }
  })

  it('preserves scope errors and composite defects during recovery', async () => {
    const releaseError: Denied = { _tag: 'Denied' }
    const acquired = ResultTask.acquireRelease({
      acquire: ResultTask.succeed(1),
      release: () => ResultTask.fail(releaseError),
    })
    const task = acquired
      .flatMap(() => ResultTask.fail<Missing>({ _tag: 'Missing', id: 'abc' }))
      .catchTag('Missing', () => ResultTask.succeed(2))
    expectTypeOf(task).toEqualTypeOf<ResultTask<number, never, ResultTaskScope<Denied>>>()
    expect(await ResultTask.runExit(ResultTask.scoped(task))).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: releaseError },
    })
    const composite = ResultTask.scoped(
      acquired.flatMap(() => ResultTask.fail<Missing>({ _tag: 'Missing', id: 'abc' })),
    )
    const exit = await ResultTask.runExit(
      composite.catchTags({ Missing: () => ResultTask.succeed(2) }),
    )
    expect(exit._tag).toBe('Failure')
    if (exit._tag === 'Failure' && exit.cause._tag === 'Die')
      expect(exit.cause.defect).toBeInstanceOf(ResultTaskCauseError)
  })

  it('unions recovery errors and requirements and propagates callback defects', async () => {
    const Clock = ResultTask.service<{ now: () => number }>()('RecoveryClock')
    const source: ResultTask<number, Missing | Denied> = ResultTask.fail({
      _tag: 'Missing',
      id: 'abc',
    })
    const recovered = source.catchTags({
      Missing: () =>
        ResultTask.gen(function* () {
          const clock = yield* Clock
          return yield* ResultTask.fail(clock.now())
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
      return ResultTask.succeed(1)
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
          ResultTask.succeed({
            [Symbol.dispose]: () => {
              events.push('first')
            },
          }),
        )
        return yield* ResultTask.acquireDisposable(ResultTask.succeed(resource))
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
      ResultTask.succeed({
        [Symbol.dispose]: () => {
          throw defect
        },
      }),
    ).flatMap(() => ResultTask.fail('body'))
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
    const acquire: ResultTask<Resource, Missing> = ResultTask.fail({ _tag: 'Missing', id: 'abc' })
    const failed = ResultTask.acquireDisposable(acquire)
    expect((await ResultTask.runExit(failed))._tag).toBe('Failure')
    let disposed = false
    const defect = new Error('async disposal')
    const acquired = ResultTask.acquireDisposable(
      ResultTask.succeed({
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
      ResultTask.acquireDisposable(ResultTask.succeed({ value: 1 }))
    }
  })
})
