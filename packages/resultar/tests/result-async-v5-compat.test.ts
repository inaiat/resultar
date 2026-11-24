/* eslint-disable unicorn/no-array-for-each, unicorn/no-array-method-this-argument -- Exercising static ResultAsync.forEach(items, fn, options). */
import { deepStrictEqual, equal, rejects, strictEqual } from 'node:assert'
import { describe, it, vi } from 'vite-plus/test'

import {
  DisposableResultAsync,
  ResultAsync,
  errAsync,
  fromThrowableAsync,
  okAsync,
  runPromise,
  safeTry,
} from '../src/entries/async.js'
import { ResultTask, Retry, ok, type Result } from '../src/index.js'

describe('resultar/async v5 deprecated compatibility surface', () => {
  it('supports DisposableResultAsync, toAsyncDisposable, idempotent disposal, and swallowed finalizer errors', async () => {
    const calls: { readonly value: number | undefined; readonly error: string | undefined }[] = []
    const okDisp = okAsync<number, string>(42).toAsyncDisposable((value, error) => {
      calls.push({ value, error })
    })
    equal(okDisp instanceof DisposableResultAsync, true)
    const okRes = await okDisp
    equal(okRes._unsafeUnwrap(), 42)
    await okDisp[Symbol.asyncDispose]()
    // Second dispose must be a no-op (#disposed guard).
    await okDisp[Symbol.asyncDispose]()
    deepStrictEqual(calls, [{ value: 42, error: undefined }])

    const errCalls: { readonly value: number | undefined; readonly error: string | undefined }[] =
      []
    const errDisp = errAsync<number, string>('failed').toAsyncDisposable(async (value, error) => {
      await Promise.resolve()
      errCalls.push({ value, error })
      throw new Error('finalizer boom')
    })
    const errRes = await errDisp
    equal(errRes._unsafeUnwrapErr(), 'failed')
    await errDisp[Symbol.asyncDispose]()
    deepStrictEqual(errCalls, [{ value: undefined, error: 'failed' }])
  })

  it('supports ResultAsync.combine, ResultAsync.all, ResultAsync.combineWithAllErrors, ResultAsync.validateAll, and ResultAsync.zip', async () => {
    const arrOk = await ResultAsync.combine([okAsync(1), okAsync('two')] as const)
    deepStrictEqual(arrOk._unsafeUnwrap(), [1, 'two'])

    const setOk = await ResultAsync.all(new Set([okAsync(10), okAsync(20)]))
    deepStrictEqual(setOk._unsafeUnwrap(), [10, 20])

    const fnIterable = Object.assign(() => undefined, {
      *[Symbol.iterator]() {
        yield okAsync(3)
        yield okAsync(4)
      },
    })
    const fnIterOk = await ResultAsync.combine(fnIterable)
    deepStrictEqual(fnIterOk._unsafeUnwrap(), [3, 4])

    const recOk = await ResultAsync.all({ a: okAsync(1), b: okAsync('b') })
    deepStrictEqual(recOk._unsafeUnwrap(), { a: 1, b: 'b' })

    const nonObjectIterablePrimitive = await ResultAsync.combine(
      '' as unknown as Record<string, ResultAsync<unknown, unknown>>,
    )
    deepStrictEqual(nonObjectIterablePrimitive._unsafeUnwrap(), {})

    const recErr = await ResultAsync.combine({
      a: okAsync<number, string>(1),
      b: errAsync<number, string>('bad-b'),
    })
    equal(recErr._unsafeUnwrapErr(), 'bad-b')

    const valArr = await ResultAsync.validateAll([
      okAsync<number, string>(1),
      errAsync<number, string>('e1'),
      errAsync<number, string>('e2'),
    ])
    deepStrictEqual(valArr._unsafeUnwrapErr(), ['e1', 'e2'])

    const allErrSet = await ResultAsync.combineWithAllErrors(
      new Set([errAsync<number, string>('s1'), okAsync<number, string>(2), errAsync('s2')]),
    )
    deepStrictEqual(allErrSet._unsafeUnwrapErr(), ['s1', 's2'])

    const allErrRecOk = await ResultAsync.combineWithAllErrors({
      x: okAsync<number, string>(7),
      y: okAsync<string, string>('ok'),
    })
    deepStrictEqual(allErrRecOk._unsafeUnwrap(), { x: 7, y: 'ok' })

    const allErrRecFail = await ResultAsync.combineWithAllErrors({
      x: errAsync<number, string>('rx'),
      y: errAsync<number, string>('ry'),
    })
    deepStrictEqual(allErrRecFail._unsafeUnwrapErr(), ['rx', 'ry'])

    const mappedOk = await ResultAsync.validateAll([1, 2, 3], (n) => okAsync(n * 2))
    deepStrictEqual(mappedOk._unsafeUnwrap(), [2, 4, 6])

    await rejects(
      Promise.resolve(ResultAsync.validateAll([1, 2], (n) => okAsync(n), { concurrency: 0 })),
      /positive integer/iu,
    )

    const zipped = await ResultAsync.zip(okAsync(1), okAsync('z'))
    deepStrictEqual(zipped._unsafeUnwrap(), [1, 'z'])
    const zippedErr = await ResultAsync.zip(
      okAsync<number, string>(1),
      errAsync<string, string>('ze'),
    )
    equal(zippedErr._unsafeUnwrapErr(), 'ze')
  })

  it('supports ResultAsync.tryCatch, fromThrowableAsync, fromTask, runPromise, tap, and tapError', async () => {
    const tcOk = await ResultAsync.tryCatch(() => Promise.resolve(9))
    equal(tcOk._unsafeUnwrap(), 9)

    const tcDirectRej = await ResultAsync.tryCatch(Promise.reject(new Error('raw')))
    equal((tcDirectRej._unsafeUnwrapErr() as Error).message, 'raw')

    const tcMapped = await ResultAsync.tryCatch(
      () => {
        throw new Error('sync-throw')
      },
      (e) => `mapped:${(e as Error).message}`,
    )
    equal(tcMapped._unsafeUnwrapErr(), 'mapped:sync-throw')

    const wrappedRaw = ResultAsync.fromThrowable(async (n: number) => {
      await Promise.resolve()
      if (n < 0) throw new Error('neg')
      return n * 3
    })
    equal((await wrappedRaw(4))._unsafeUnwrap(), 12)
    equal(((await wrappedRaw(-1))._unsafeUnwrapErr() as Error).message, 'neg')

    const wrappedMapped = fromThrowableAsync(
      async (n: number) => {
        await Promise.resolve()
        if (n === 0) throw new Error('zero')
        return n
      },
      (e) => (e as Error).message.toUpperCase(),
    )
    equal((await wrappedMapped(5))._unsafeUnwrap(), 5)
    equal((await wrappedMapped(0))._unsafeUnwrapErr(), 'ZERO')

    const observed: (string | number)[] = []
    const fromTask = ResultAsync.fromTask(ResultTask.ok(11))
      .tap((v) => {
        observed.push(v)
      })
      .tapError(() => {
        observed.push('unexpected-err')
      })
    equal(await runPromise(fromTask), 11)

    const errObserved = await ResultAsync.fromTask(ResultTask.err('task-err'))
      .tap(() => {
        observed.push('unexpected-ok')
      })
      .tapError((e) => {
        observed.push(e)
      })
    equal(errObserved._unsafeUnwrapErr(), 'task-err')
    deepStrictEqual(observed, [11, 'task-err'])
    await rejects(runPromise(errAsync(new Error('boom-promise'))), /boom-promise/u)
  })

  it('supports ResultAsync.firstSuccessOf, loop, iterate, and forEach error/discard/empty paths', async () => {
    const firstOk = await ResultAsync.firstSuccessOf([
      () => errAsync<number, string>('e1'),
      () => okAsync<number, string>(77),
      () => errAsync<number, string>('unreachable'),
    ])
    equal(firstOk._unsafeUnwrap(), 77)

    const allFail = await ResultAsync.firstSuccessOf([
      () => errAsync<number, string>('e1'),
      () => errAsync<number, string>('e2'),
    ])
    equal(allFail._unsafeUnwrapErr(), 'e2')

    await rejects(Promise.resolve(ResultAsync.firstSuccessOf([])), {
      name: 'IllegalArgumentException',
    })

    const loopOk = await ResultAsync.loop(0, {
      while: (n) => n < 3,
      step: (n) => n + 1,
      body: (n) => okAsync(n * 10),
    })
    deepStrictEqual(loopOk._unsafeUnwrap(), [0, 10, 20])

    const loopEmpty = await ResultAsync.loop(5, {
      while: (n) => n < 3,
      step: (n) => n + 1,
      body: (n) => okAsync(n),
    })
    deepStrictEqual(loopEmpty._unsafeUnwrap(), [])

    const loopErr = await ResultAsync.loop(0, {
      while: (n) => n < 3,
      step: (n) => n + 1,
      body: (n) => (n === 1 ? errAsync<number, string>('loop-fail') : okAsync(n)),
    })
    equal(loopErr._unsafeUnwrapErr(), 'loop-fail')

    const visitedDiscard: number[] = []
    const loopDiscardOk = await ResultAsync.loop(0, {
      discard: true,
      while: (n) => n < 3,
      step: (n) => n + 1,
      body: (n) => {
        visitedDiscard.push(n)
        return okAsync(n)
      },
    })
    strictEqual(loopDiscardOk._unsafeUnwrap(), undefined)
    deepStrictEqual(visitedDiscard, [0, 1, 2])

    const loopDiscardErr = await ResultAsync.loop(0, {
      discard: true,
      while: (n) => n < 3,
      step: (n) => n + 1,
      body: (n) => (n === 1 ? errAsync<number, string>('discard-fail') : okAsync(n)),
    })
    equal(loopDiscardErr._unsafeUnwrapErr(), 'discard-fail')

    const iterOk = await ResultAsync.iterate(1, {
      while: (n) => n < 8,
      body: (n) => okAsync(n * 2),
    })
    equal(iterOk._unsafeUnwrap(), 8)

    const iterImmediate = await ResultAsync.iterate(10, {
      while: (n) => n < 8,
      body: (n) => okAsync(n * 2),
    })
    equal(iterImmediate._unsafeUnwrap(), 10)

    const iterErr = await ResultAsync.iterate(1, {
      while: (n) => n < 8,
      body: (n) => (n === 4 ? errAsync<number, string>('iter-err') : okAsync(n * 2)),
    })
    equal(iterErr._unsafeUnwrapErr(), 'iter-err')

    const emptyForEach = await ResultAsync.forEach([] as number[], (n) => okAsync(n))
    deepStrictEqual(emptyForEach._unsafeUnwrap(), [])

    const startedItems: number[] = []
    const discardErr = await ResultAsync.forEach(
      [1, 2, 3, 4],
      (n) => {
        startedItems.push(n)
        if (n === 2) return errAsync<number, string>('stop-at-2')
        return okAsync<number, string>(n)
      },
      { discard: true, concurrency: 1 },
    )
    equal(discardErr._unsafeUnwrapErr(), 'stop-at-2')
    deepStrictEqual(startedItems, [1, 2])

    const throwingIterable: Iterable<number> = {
      [Symbol.iterator]: () => ({
        next: () => {
          throw new Error('iterator-boom')
        },
      }),
    }
    await rejects(
      Promise.resolve(ResultAsync.forEach(throwingIterable, (n) => okAsync(n))),
      /iterator-boom/u,
    )

    await rejects(
      Promise.resolve(
        ResultAsync.forEach([1], () => {
          throw new Error('mapper-boom')
        }),
      ),
      /mapper-boom/u,
    )
  })

  it('covers Retry.policy integration on ResultAsync.retry, raceWith signal getter, and unmapped async safeTry rejections', async () => {
    // eslint-disable-next-line oxc/no-rest-spread-properties -- Verify execution validates a spread policy with changed timings.
    const corruptedPolicy = { ...Retry.policy({ times: 1 }), backoff: 0 }
    await rejects(
      Promise.resolve(ResultAsync.retry(() => errAsync('x'), corruptedPolicy)),
      RangeError,
    )

    const delays: number[] = []
    const policy = Retry.policy<string>({
      times: 2,
      delayMs: (ctx, error) => {
        delays.push(ctx.attempt + error.length)
        return 0
      },
    })
    const retried = await ResultAsync.retry(
      (attempt) => (attempt < 2 ? errAsync('ab') : okAsync(99)),
      policy,
    )
    equal(retried._unsafeUnwrap(), 99)
    deepStrictEqual(delays, [2, 3])

    let now = 100
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => {
      const cur = now
      now += 50
      return cur
    })
    try {
      let attempts = 0
      let onRetryCalls = 0
      const budgetBeforeDelay = await ResultAsync.retry(
        () => {
          attempts += 1
          return errAsync('budget-1')
        },
        Retry.policy({
          times: 5,
          delayMs: 0,
          maxElapsedMs: 10,
          onRetry: () => {
            onRetryCalls += 1
          },
        }),
      )
      equal(budgetBeforeDelay._unsafeUnwrapErr(), 'budget-1')
      equal(attempts, 1)
      equal(onRetryCalls, 0)
    } finally {
      nowSpy.mockRestore()
    }

    let attempts2 = 0
    const budgetWithNextDelay = await ResultAsync.retry(
      () => {
        attempts2 += 1
        return errAsync('budget-2')
      },
      Retry.policy({ times: 5, delayMs: 1000, maxElapsedMs: 10 }),
    )
    equal(budgetWithNextDelay._unsafeUnwrapErr(), 'budget-2')
    equal(attempts2, 1)

    const whileCalls: number[] = []
    const legacyRes = await ResultAsync.retry(() => errAsync('legacy-e'), {
      times: 0,
      while: (_e, ctx) => {
        whileCalls.push(ctx.attempt)
        return true
      },
    })
    equal(legacyRes._unsafeUnwrapErr(), 'legacy-e')
    deepStrictEqual(whileCalls, [0])

    const policyWhileCalls: number[] = []
    await ResultAsync.retry(
      () => errAsync('policy-e'),
      Retry.policy({
        times: 0,
        while: (_e, ctx) => {
          policyWhileCalls.push(ctx.attempt)
          return true
        },
      }),
    )
    deepStrictEqual(policyWhileCalls, [])

    let sawSignalAborted: boolean | undefined = undefined
    const raced = await ResultAsync.raceWith(
      () => okAsync(5),
      (signal) =>
        new ResultAsync(
          new Promise<Result<number, never>>((resolve) => {
            signal.addEventListener('abort', () => resolve(ok(0)), { once: true })
          }),
        ),
      {
        onLeftDone: (res, right) => {
          const before = right.signal.aborted
          right.abort()
          sawSignalAborted = !before && right.signal.aborted
          return right.wait().map(() => res._unsafeUnwrap())
        },
        onRightDone: (res) => res,
      },
    )
    equal(raced._unsafeUnwrap(), 5)
    equal(sawSignalAborted, true)

    await rejects(
      Promise.resolve(
        safeTry({
          async *try() {
            await Promise.resolve()
            yield* ok(1)
            throw new Error('uncaught-safe-try')
          },
        }),
      ),
      /uncaught-safe-try/u,
    )
  })

  it('covers ResultAsync traversal rejection, array combineWithAllErrors, and race startup/rejection paths', async () => {
    // Non-Error rejection in traverseResultAsync (toResultAsyncRejectionError)
    await rejects(
      Promise.resolve(
        ResultAsync.forEach([1], () => {
          // eslint-disable-next-line no-throw-literal, @typescript-eslint/only-throw-error
          throw 'raw-string-boom'
        }),
      ),
      /raw-string-boom/u,
    )

    // In-flight item settling after traverseResultAsync already settled (if (settled) return in finally)
    const deferred = Promise.withResolvers<Result<number, never>>()
    const concurrentTraverse = ResultAsync.forEach(
      [1, 2],
      (item) => {
        if (item === 1) return new ResultAsync(deferred.promise)
        throw new Error('item-2-boom')
      },
      { concurrency: 2 },
    )
    await rejects(Promise.resolve(concurrentTraverse), /item-2-boom/u)
    deferred.resolve(ok(1))
    await Promise.resolve()

    // ResultAsync.combineWithAllErrors array fast path
    const combinedArr = await ResultAsync.combineWithAllErrors([
      okAsync<number, string>(1),
      errAsync<number, string>('e1'),
      errAsync<number, string>('e2'),
    ])
    deepStrictEqual(combinedArr._unsafeUnwrapErr(), ['e1', 'e2'])

    // observeRaceResultAsyncTasks startup throw aborts already-started tasks and swallows their rejections
    let firstAborted = false
    const raceStartupFail = ResultAsync.raceAll([
      (signal) =>
        new ResultAsync(
          new Promise<Result<number, never>>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                firstAborted = true
                reject(new Error('first-aborted'))
              },
              { once: true },
            )
          }),
        ),
      () => {
        throw new Error('second-start-boom')
      },
    ])
    await rejects(Promise.resolve(raceStartupFail), /second-start-boom/u)
    equal(firstAborted, true)

    // ResultAsync.raceWith right startup throw aborts left and swallows left rejection
    let leftAbortedOnStartThrow = false
    const raceWithStartThrow = ResultAsync.raceWith(
      (signal) =>
        new ResultAsync(
          new Promise<Result<number, never>>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                leftAbortedOnStartThrow = true
                reject(new Error('left-aborted'))
              },
              { once: true },
            )
          }),
        ),
      () => {
        throw new Error('right-start-boom')
      },
      { onLeftDone: (r) => r, onRightDone: (r) => r },
    )
    await rejects(Promise.resolve(raceWithStartThrow), /right-start-boom/u)
    equal(leftAbortedOnStartThrow, true)

    // ResultAsync.raceWith right rejects first (aborts left, marks settled so onLeftDone never fires)
    let leftAbortedOnRightReject = false
    let onLeftDoneCalls = 0
    const rightRejectsFirst = ResultAsync.raceWith(
      (signal) =>
        new ResultAsync(
          new Promise<Result<number, never>>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                leftAbortedOnRightReject = true
                resolve(ok(1))
              },
              { once: true },
            )
          }),
        ),
      () => new ResultAsync<number, never>(Promise.reject(new Error('right-reject-first'))),
      {
        onLeftDone: (r) => {
          onLeftDoneCalls += 1
          return r
        },
        onRightDone: (r) => r,
      },
    )
    await rejects(Promise.resolve(rightRejectsFirst), /right-reject-first/u)
    await new Promise((resolve) => {
      setImmediate(resolve)
    })
    equal(leftAbortedOnRightReject, true)
    equal(onLeftDoneCalls, 0)

    // ResultAsync.raceWith left settles first, then right rejects later (settled guard keeps left signal unaborted)
    const lateRight = Promise.withResolvers<Result<number, never>>()
    let leftSignalOnWin: { readonly aborted: boolean } | undefined = undefined
    const leftWinsBeforeRightReject = await ResultAsync.raceWith(
      (signal) => {
        leftSignalOnWin = signal
        return okAsync(42)
      },
      () => new ResultAsync(lateRight.promise),
      { onLeftDone: (r) => r, onRightDone: (r) => r },
    )
    equal(leftWinsBeforeRightReject._unsafeUnwrap(), 42)
    lateRight.reject(new Error('late-right-reject'))
    await new Promise((resolve) => {
      setImmediate(resolve)
    })
    equal((leftSignalOnWin as { readonly aborted: boolean } | undefined)?.aborted, false)
  })
})
