import type { ResultAsync } from '../src/index.js'
import { deepEqual, equal } from 'node:assert'
import { describe, expectTypeOf, it } from 'vite-plus/test'

import { AbortError, err, errAsync, ok, okAsync, ResultTask } from '../src/index.js'

describe('ResultTask Phase 1 - Lazy Core & Essential Combinators', () => {
  describe('mapErr', () => {
    it('transforms domain error on Fail', async () => {
      const task = ResultTask.err('network-error').mapErr((e) => `mapped-${e}`)
      const result = await ResultTask.runResult(task)

      deepEqual(result, err('mapped-network-error'))
    })

    it('bypasses mapper on Success', async () => {
      let called = false
      const task = ResultTask.ok(42).mapErr(() => {
        called = true
        return 'mapped'
      })
      const result = await ResultTask.runResult(task)

      deepEqual(result, ok(42))
      equal(called, false)
    })

    it('turns thrown error in mapper into Die', async () => {
      const boom = new Error('boom in mapErr')
      const task = ResultTask.err('initial').mapErr(() => {
        throw boom
      })
      const exit = await ResultTask.runExit(task)

      deepEqual(exit, { _tag: 'Failure', cause: { _tag: 'Die', defect: boom } })
    })

    it('supports curried syntax for pipe', async () => {
      const task = ResultTask.err(10).pipe(ResultTask.mapErr((n) => n * 2))
      const result = await ResultTask.runResult(task)

      deepEqual(result, err(20))
    })

    it('supports static data-first invocation', async () => {
      const task = ResultTask.mapErr(ResultTask.err('err'), (e) => e.toUpperCase())
      const result = await ResultTask.runResult(task)

      deepEqual(result, err('ERR'))
    })

    it('safely handles 10,000 chained mapErr calls with O(1) stack frames', async () => {
      let task = ResultTask.err<number>(0)
      for (let i = 0; i < 10_000; i += 1) {
        task = task.mapErr((n) => n + 1)
      }

      const result = await ResultTask.runResult(task)
      deepEqual(result, err(10_000))
    })
  })

  describe('tap', () => {
    it('executes side effect on Success and preserves original value', async () => {
      let observed = 0
      const task = ResultTask.ok(100).tap((val) => {
        observed = val
      })
      const result = await ResultTask.runResult(task)

      deepEqual(result, ok(100))
      equal(observed, 100)
    })

    it('bypasses side effect on Fail', async () => {
      let called = false
      const task = ResultTask.err('err').tap(() => {
        called = true
      })
      const result = await ResultTask.runResult(task)

      deepEqual(result, err('err'))
      equal(called, false)
    })

    it('supports side effect returning a successful ResultTask', async () => {
      let sideEffectRan = false
      const task = ResultTask.ok(10).tap(() =>
        ResultTask.sync(() => {
          sideEffectRan = true
        }),
      )
      const result = await ResultTask.runResult(task)

      deepEqual(result, ok(10))
      equal(sideEffectRan, true)
    })

    it('propagates failure if side effect ResultTask fails', async () => {
      const task = ResultTask.ok(10).tap(() => ResultTask.err('side-effect-failed'))
      const result = await ResultTask.runResult(task)

      deepEqual(result, err('side-effect-failed'))
    })

    it('supports async side effect returning a resolved Promise', async () => {
      let asyncRan = false
      const task = ResultTask.ok(5).tap(async () => {
        await Promise.resolve()
        asyncRan = true
      })
      const result = await ResultTask.runResult(task)

      deepEqual(result, ok(5))
      equal(asyncRan, true)
    })

    it('turns rejected Promise in side effect into Die', async () => {
      const defect = new Error('promise rejected')
      const task = ResultTask.ok(5).tap(async () => {
        await Promise.reject(defect)
      })
      const exit = await ResultTask.runExit(task)

      deepEqual(exit, { _tag: 'Failure', cause: { _tag: 'Die', defect } })
    })

    it('turns thrown synchronous exception in tap into Die', async () => {
      const defect = new Error('sync throw')
      const task = ResultTask.ok(5).tap(() => {
        throw defect
      })
      const exit = await ResultTask.runExit(task)

      deepEqual(exit, { _tag: 'Failure', cause: { _tag: 'Die', defect } })
    })

    it('supports curried syntax for pipe', async () => {
      let logged = ''
      const task = ResultTask.ok('hello').pipe(
        ResultTask.tap((msg) => {
          logged = msg
        }),
      )
      const result = await ResultTask.runResult(task)

      deepEqual(result, ok('hello'))
      equal(logged, 'hello')
    })

    it('safely handles 10,000 chained tap calls with O(1) stack frames', async () => {
      let counter = 0
      const increment = (): void => {
        counter += 1
      }
      let task = ResultTask.ok(1)
      for (let i = 0; i < 10_000; i += 1) {
        task = task.tap(increment)
      }

      const result = await ResultTask.runResult(task)
      deepEqual(result, ok(1))
      equal(counter, 10_000)
    })
  })

  describe('tapError', () => {
    it('executes side effect on Fail and preserves original error', async () => {
      let observed = ''
      const task = ResultTask.err('initial-error').tapError((e) => {
        observed = e
      })
      const result = await ResultTask.runResult(task)

      deepEqual(result, err('initial-error'))
      equal(observed, 'initial-error')
    })

    it('bypasses side effect on Success', async () => {
      let called = false
      const task = ResultTask.ok(42).tapError(() => {
        called = true
      })
      const result = await ResultTask.runResult(task)

      deepEqual(result, ok(42))
      equal(called, false)
    })

    it('supports side effect returning a successful ResultTask', async () => {
      let sideEffectRan = false
      const task = ResultTask.err('original').tapError(() =>
        ResultTask.sync(() => {
          sideEffectRan = true
        }),
      )
      const result = await ResultTask.runResult(task)

      deepEqual(result, err('original'))
      equal(sideEffectRan, true)
    })

    it('replaces failure if side effect ResultTask fails', async () => {
      const task = ResultTask.err('original').tapError(() => ResultTask.err('tap-failed'))
      const result = await ResultTask.runResult(task)

      deepEqual(result, err('tap-failed'))
    })

    it('supports curried syntax for pipe', async () => {
      let errorLog = ''
      const task = ResultTask.err('db-down').pipe(
        ResultTask.tapError((e) => {
          errorLog = e
        }),
      )
      const result = await ResultTask.runResult(task)

      deepEqual(result, err('db-down'))
      equal(errorLog, 'db-down')
    })
  })

  describe('as', () => {
    it('replaces success value with a constant', async () => {
      const task = ResultTask.ok(123).as('constant')
      const result = await ResultTask.runResult(task)

      deepEqual(result, ok('constant'))
    })

    it('does not replace error on failure', async () => {
      const task = ResultTask.err('failed').as('constant')
      const result = await ResultTask.runResult(task)

      deepEqual(result, err('failed'))
    })

    it('supports curried syntax for pipe', async () => {
      const task = ResultTask.ok(1).pipe(ResultTask.as('mapped-constant'))
      const result = await ResultTask.runResult(task)

      deepEqual(result, ok('mapped-constant'))
    })
  })

  describe('match', () => {
    it('matches both success and failure with { onSuccess, onFailure }', async () => {
      const okTask = ResultTask.ok<number, string>(10).match({
        onSuccess: (n) => `num: ${String(n)}`,
        onFailure: (e) => `err: ${e}`,
      })
      const errTask: ResultTask<number, string> = ResultTask.err('bad')
      const matchedErr = errTask.match({
        onSuccess: (n) => `num: ${String(n)}`,
        onFailure: (e) => `err: ${e}`,
      })

      deepEqual(await ResultTask.runResult(okTask), ok('num: 10'))
      deepEqual(await ResultTask.runResult(matchedErr), ok('err: bad'))
    })

    it('matches with { ok, err } alias handlers', async () => {
      const okTask = ResultTask.ok(10).match({ ok: (n) => n * 2, err: () => 0 })
      const errTask = ResultTask.err('bad').match({ ok: (n) => n * 2, err: () => 0 })

      deepEqual(await ResultTask.runResult(okTask), ok(20))
      deepEqual(await ResultTask.runResult(errTask), ok(0))
    })

    it('supports curried syntax for pipe', async () => {
      const task = ResultTask.ok(5).pipe(
        ResultTask.match({ onSuccess: (n) => n > 0, onFailure: () => false }),
      )
      const result = await ResultTask.runResult(task)

      deepEqual(result, ok(true))
    })

    it('eliminates the error type to never', () => {
      const task = ResultTask.ok<number, string>(10).match({ ok: (n) => n * 2, err: () => 0 })

      expectTypeOf(task).toEqualTypeOf<ResultTask<number, never, never>>()
    })
  })

  describe('Interoperability: ResultTask <-> ResultAsync', () => {
    it('converts an existing ResultAsync using ResultTask.fromResultAsync', async () => {
      const asyncOk = okAsync<number, string>(42)
      const taskOk = ResultTask.fromResultAsync(asyncOk)
      deepEqual(await ResultTask.runResult(taskOk), ok(42))

      const asyncErr = errAsync<number, string>('async-failed')
      const taskErr = ResultTask.fromResultAsync(asyncErr)
      deepEqual(await ResultTask.runResult(taskErr), err('async-failed'))
    })

    it('supports lazy factory in ResultTask.fromResultAsync to defer execution', async () => {
      let executionCount = 0
      const factory = (): ResultAsync<number, never> => {
        executionCount += 1
        return okAsync(executionCount)
      }

      const task = ResultTask.fromResultAsync(factory)
      equal(executionCount, 0) // Did not run during construction!

      const res1 = await ResultTask.runResult(task)
      equal(executionCount, 1)
      deepEqual(res1, ok(1))

      const res2 = await ResultTask.runResult(task)
      equal(executionCount, 2)
      deepEqual(res2, ok(2))
    })

    it('converts ResultTask to ResultAsync using ResultTask.toResultAsync and instance method', async () => {
      const task = ResultTask.ok('hello').map((s) => `${s} world`)

      const async1 = ResultTask.toResultAsync(task)
      expectTypeOf(async1).toExtend<ResultAsync<string, never>>()
      deepEqual(await async1, ok('hello world'))

      const async2 = task.toResultAsync()
      deepEqual(await async2, ok('hello world'))
    })

    it('converts ResultTask to ResultAsync using ResultTask.toResultAsync', async () => {
      const task = ResultTask.err('task-error')
      const resultAsync = ResultTask.toResultAsync(task)

      expectTypeOf(resultAsync).toExtend<ResultAsync<never, string>>()
      deepEqual(await resultAsync, err('task-error'))
    })

    it('supports full round-trip ResultAsync -> ResultTask -> ResultAsync', async () => {
      const original = okAsync({ id: 'user-123' })
      const task = ResultTask.fromResultAsync(original).map((u) => ({ id: u.id, active: true }))
      const backToAsync = ResultTask.toResultAsync(task)

      deepEqual(await backToAsync, ok({ id: 'user-123', active: true }))
    })

    it('respects AbortSignal cancellation in fromResultAsync', async () => {
      const controller = new AbortController()
      controller.abort('pre-aborted')

      const task = ResultTask.fromResultAsync(() => okAsync('value'))
      await ResultTask.runResult(task, { signal: controller.signal }).then(
        () => {
          throw new Error('should have rejected with AbortError')
        },
        (error: unknown) => {
          equal(error instanceof AbortError, true)
        },
      )
    })
  })

  describe('Pipe workflows with mixed combinators', () => {
    it('composes map, tap, mapErr, as and match fluently in pipe', async () => {
      let sideEffectVal = 0

      const pipeline = ResultTask.ok<number>(10).pipe(
        ResultTask.map((n: number) => n * 2),
        ResultTask.tap((n: number) => {
          sideEffectVal = n
        }),
        ResultTask.as('twenty'),
        ResultTask.match({ onSuccess: (s: string) => s.toUpperCase(), onFailure: () => 'ERROR' }),
      )

      const result = await ResultTask.runResult(pipeline)
      deepEqual(result, ok('TWENTY'))
      equal(sideEffectVal, 20)
    })

    it('short-circuits appropriately in pipe chains', async () => {
      let tapCalled = false
      let mapCalled = false

      const pipeline = ResultTask.err('early-fail').pipe(
        ResultTask.map((n) => {
          mapCalled = true
          return n
        }),
        ResultTask.tap(() => {
          tapCalled = true
        }),
        ResultTask.mapErr((error) => `handled-${error}`),
      )

      const result = await ResultTask.runResult(pipeline)
      deepEqual(result, err('handled-early-fail'))
      equal(mapCalled, false)
      equal(tapCalled, false)
    })
  })
})
