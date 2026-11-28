import { describe, expect, it, vi } from 'vite-plus/test'

import { Cause, err, ok, ResultTask, serviceTag } from '../src/index.js'
import type { TaskScope } from '../src/task/scope.js'

const errMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const makeAbortAfterFirstRead = (reason: string): AbortSignal => {
  let reads = 0
  return {
    get aborted() {
      reads += 1
      return reads > 1
    },
    reason,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as AbortSignal
}

const makeTaskWithScopeCloseRejection = (asyncBody: boolean): ResultTask<number> => {
  const base = ResultTask.ok(1)
  ;(base as unknown as { run: (ctx: { scope: TaskScope }) => unknown }).run = (ctx) => {
    ctx.scope.add(() => ({ _tag: 'Success', value: undefined }))
    ctx.scope.closeSyncOrAsync = () => Promise.reject(new Error('scope-close-reject'))
    if (asyncBody) {
      return Promise.resolve({ _tag: 'Success', value: 1 })
    }
    return { _tag: 'Success', value: 1 }
  }
  return base
}

describe('ResultTask fused tryPromise & orElse fast-path coverage', () => {
  it('covers fused tryPromise mapErr, map+mapErr+orElse, and non-tryPromise fallbacks', async () => {
    const mapErrCatchReject = await ResultTask.tryPromise(
      () => Promise.reject(new Error('raw')),
      errMessage,
    )
      .mapErr((e) => `mapped:${e}`)
      .orElse((e) => ResultTask.ok(`recovered:${e}`))
      .runExit()
    expect(mapErrCatchReject).toEqual({ _tag: 'Success', value: 'recovered:mapped:raw' })

    const mapMapErrResolve = await ResultTask.tryPromise(() => Promise.resolve(3), errMessage)
      .map((n) => n * 2)
      .mapErr((e) => `m:${e}`)
      .orElse(() => ResultTask.ok(0))
      .runExit()
    expect(mapMapErrResolve).toEqual({ _tag: 'Success', value: 6 })

    const mapMapErrReject = await ResultTask.tryPromise(
      (): Promise<number> => Promise.reject(new Error('bad')),
      errMessage,
    )
      .map((n) => n * 2)
      .mapErr((e) => `m:${e}`)
      .orElse((e) => ResultTask.ok(e))
      .runExit()
    expect(mapMapErrReject).toEqual({ _tag: 'Success', value: 'm:bad' })

    // Non-tryPromise deepLeaf fallbacks for L1053 and L1061
    const nonTryMapMapErr = await ResultTask.ok<number, string>(4)
      .map((n) => n + 1)
      .mapErr((e) => e)
      .orElse(() => ResultTask.ok(0))
      .runExit()
    expect(nonTryMapMapErr).toEqual({ _tag: 'Success', value: 5 })

    const nonTryFlatMapErr = await ResultTask.ok<number, string>(4)
      .mapErr((e) => e)
      .andThen((n) => ResultTask.ok(n + 2))
      .orElse(() => ResultTask.ok(0))
      .runExit()
    expect(nonTryFlatMapErr).toEqual({ _tag: 'Success', value: 6 })
  })

  it('covers mapped orElse recovery paths (#finishMappedCatchAll & outerMapOk) and mapErr+andThen fusion', async () => {
    const recoveredMapped = await ResultTask.tryPromise(
      (): Promise<number> => Promise.reject(new Error('fail')),
      errMessage,
    )
      .orElse(() => ResultTask.ok(10))
      .map((n) => n * 3)
      .runExit()
    expect(recoveredMapped).toEqual({ _tag: 'Success', value: 30 })

    const resolvedMapped = await ResultTask.tryPromise(() => Promise.resolve(7), errMessage)
      .orElse(() => ResultTask.ok(0))
      .map((n) => n + 1)
      .runExit()
    expect(resolvedMapped).toEqual({ _tag: 'Success', value: 8 })

    const syncRecoveryMapped = await ResultTask.tryPromise(
      (): Promise<number> => Promise.reject(new Error('fail')),
      errMessage,
    )
      .orElse(() => ResultTask.sync(() => 11))
      .map((n) => n + 1)
      .runExit()
    expect(syncRecoveryMapped).toEqual({ _tag: 'Success', value: 12 })

    const flatMapAfterMapErr = await ResultTask.tryPromise(() => Promise.resolve(5), errMessage)
      .mapErr((e) => `e:${e}`)
      .andThen((n) => ResultTask.ok(n * 2))
      .runExit()
    expect(flatMapAfterMapErr).toEqual({ _tag: 'Success', value: 10 })

    const flatMapAfterMapErrRej = await ResultTask.tryPromise(
      (): Promise<number> => Promise.reject(new Error('err')),
      errMessage,
    )
      .mapErr((e) => `e:${e}`)
      .andThen((n) => ResultTask.ok(n * 2))
      .runExit()
    expect(flatMapAfterMapErrRej).toEqual({ _tag: 'Failure', cause: Cause.fail('e:err') })

    const lowBudgetResult = await ResultTask.tryPromise(() => Promise.resolve(2), errMessage)
      .mapErr((e) => e)
      .andThen((n) => ResultTask.ok(n + 3))
      .runExit({ yieldEvery: 6 })
    expect(lowBudgetResult).toEqual({ _tag: 'Success', value: 5 })
  })

  it('covers executeFusedTryPromise failure, flatMap, async flatMap, and sync-throw branches', async () => {
    const mapRejected = await ResultTask.tryPromise(
      (): Promise<number> => Promise.reject(new Error('boom')),
      errMessage,
    )
      .map((n) => n + 1)
      .runExit()
    expect(mapRejected).toEqual({ _tag: 'Failure', cause: Cause.fail('boom') })

    const syncThrow = await ResultTask.tryPromise((): Promise<number> => {
      throw new Error('sync-try')
    }, errMessage)
      .map((n) => n + 1)
      .runExit()
    expect(syncThrow).toEqual({ _tag: 'Failure', cause: Cause.fail('sync-try') })

    const flatMapRecovered = await ResultTask.tryPromise(() => Promise.resolve(1), errMessage)
      .andThen(() => ResultTask.err('inner' as const))
      .orElse((e) => ResultTask.ok(`fixed:${e}`))
      .runExit()
    expect(flatMapRecovered).toEqual({ _tag: 'Success', value: 'fixed:inner' })

    const flatMapAsync = await ResultTask.tryPromise(() => Promise.resolve(2), errMessage)
      .andThen((n) => ResultTask.fromPromise(() => Promise.resolve(n * 4)))
      .orElse(() => ResultTask.ok(0))
      .runExit()
    expect(flatMapAsync).toEqual({ _tag: 'Success', value: 8 })

    const fmDefect = new Error('fm-throw')
    const flatMapThrowNoCatch = await ResultTask.tryPromise(() => Promise.resolve(1), errMessage)
      .andThen((): ResultTask<number> => {
        throw fmDefect
      })
      .runExit()
    expect(flatMapThrowNoCatch).toEqual({ _tag: 'Failure', cause: Cause.die(fmDefect) })

    const flatMapThrowWithCatch = await ResultTask.tryPromise(() => Promise.resolve(1), errMessage)
      .andThen((): ResultTask<number> => {
        throw fmDefect
      })
      .orElse(() => ResultTask.ok(99))
      .runExit()
    expect(flatMapThrowWithCatch).toEqual({ _tag: 'Failure', cause: Cause.die(fmDefect) })
  })

  it('covers finishFusedFlatMapExit outerMapOk and signal abort branches in fused tryPromise', async () => {
    const okOuter = await ResultTask.tryPromise(() => Promise.resolve(3), errMessage)
      .andThen((n) => ResultTask.ok(n + 1))
      .orElse(() => ResultTask.ok(0))
      .map((n) => n * 10)
      .runExit()
    expect(okOuter).toEqual({ _tag: 'Success', value: 40 })

    const outerAbortCtrl = new AbortController()
    const abortOuter = await ResultTask.tryPromise(() => Promise.resolve(3), errMessage)
      .andThen((n) => ResultTask.ok(n + 1))
      .orElse(() => ResultTask.ok(0))
      .map((n) => {
        outerAbortCtrl.abort('outer-stop')
        return n
      })
      .runExit({ signal: outerAbortCtrl.signal })
    expect(abortOuter).toEqual({ _tag: 'Failure', cause: Cause.interrupt('outer-stop') })

    const outerDefect = new Error('outer-boom')
    const throwOuter = await ResultTask.tryPromise(() => Promise.resolve(3), errMessage)
      .andThen((n) => ResultTask.ok(n + 1))
      .orElse(() => ResultTask.ok(0))
      .map(() => {
        throw outerDefect
      })
      .runExit()
    expect(throwOuter).toEqual({ _tag: 'Failure', cause: Cause.die(outerDefect) })

    const innerTaskAbort = new AbortController()
    const innerAbortExit = await ResultTask.tryPromise(() => Promise.resolve(1), errMessage)
      .andThen(() =>
        ResultTask.sync(() => {
          innerTaskAbort.abort('inner-task-stop')
          return 2
        }),
      )
      .runExit({ signal: innerTaskAbort.signal })
    expect(innerAbortExit).toEqual({ _tag: 'Failure', cause: Cause.interrupt('inner-task-stop') })

    const beforeTaskAbort = new AbortController()
    const beforeTaskExit = await ResultTask.tryPromise(() => Promise.resolve(1), errMessage)
      .andThen(() => {
        beforeTaskAbort.abort('before-task-stop')
        return ResultTask.ok(2)
      })
      .runExit({ signal: beforeTaskAbort.signal })
    expect(beforeTaskExit).toEqual({ _tag: 'Failure', cause: Cause.interrupt('before-task-stop') })
  })

  it('covers sync Result flatMap abort and single-map abort in fused tryPromise', async () => {
    const syncResAbort = new AbortController()
    const syncResExit = await ResultTask.tryPromise(() => Promise.resolve(1), errMessage)
      .andThen(() => {
        syncResAbort.abort('sync-res-stop')
        return ok(2)
      })
      .runExit({ signal: syncResAbort.signal })
    expect(syncResExit).toEqual({ _tag: 'Failure', cause: Cause.interrupt('sync-res-stop') })

    const syncResOuterAbort = new AbortController()
    const syncResOuterExit = await ResultTask.tryPromise(() => Promise.resolve(1), errMessage)
      .andThen(() => ok(2))
      .orElse(() => ResultTask.ok(0))
      .map((n) => {
        syncResOuterAbort.abort('sync-res-outer-stop')
        return n
      })
      .runExit({ signal: syncResOuterAbort.signal })
    expect(syncResOuterExit).toEqual({
      _tag: 'Failure',
      cause: Cause.interrupt('sync-res-outer-stop'),
    })

    const mapAbort = new AbortController()
    const mapAbortExit = await ResultTask.tryPromise(() => Promise.resolve(1), errMessage)
      .map((n) => {
        mapAbort.abort('map-stop')
        return n + 1
      })
      .runExit({ signal: mapAbort.signal })
    expect(mapAbortExit).toEqual({ _tag: 'Failure', cause: Cause.interrupt('map-stop') })
  })
})

describe('ResultTask inspectCause fused & fallback coverage', () => {
  it('covers low-budget fallbacks, non-tryPromise map, and fused inspectCause edge cases', async () => {
    const seen: unknown[] = []

    await ResultTask.tryPromise(() => Promise.reject(new Error('low-1')), errMessage)
      .inspectCause((c) => seen.push(c))
      .runExit({ yieldEvery: 4 })
    await ResultTask.tryPromise(
      (): Promise<number> => Promise.reject(new Error('low-2')),
      errMessage,
    )
      .map((x) => x)
      .inspectCause((c) => seen.push(c))
      .runExit({ yieldEvery: 4 })
    await ResultTask.ok(1)
      .map((x) => x + 1)
      .inspectCause((c) => seen.push(c))
      .runExit()

    const preAborted = await ResultTask.tryPromise(() => Promise.resolve(1), errMessage)
      .inspectCause((c) => seen.push(c))
      .runExit({ signal: makeAbortAfterFirstRead('ic-pre') })
    expect(preAborted).toEqual({ _tag: 'Failure', cause: Cause.interrupt('ic-pre') })

    const okNoMap = await ResultTask.tryPromise(() => Promise.resolve(42), errMessage)
      .inspectCause((c) => seen.push(c))
      .runExit()
    expect(okNoMap).toEqual({ _tag: 'Success', value: 42 })

    const mapCtrl = new AbortController()
    const abortInMap = await ResultTask.tryPromise(() => Promise.resolve(1), errMessage)
      .map((n) => {
        mapCtrl.abort('ic-map')
        return n
      })
      .inspectCause((c) => seen.push(c))
      .runExit({ signal: mapCtrl.signal })
    expect(abortInMap).toEqual({ _tag: 'Failure', cause: Cause.interrupt('ic-map') })

    const rejCtrl = new AbortController()
    const abortInRej = await ResultTask.tryPromise(() => {
      rejCtrl.abort('ic-rej')
      return Promise.reject(new Error('ignored'))
    }, errMessage)
      .inspectCause((c) => seen.push(c))
      .runExit({ signal: rejCtrl.signal })
    expect(abortInRej).toEqual({ _tag: 'Failure', cause: Cause.interrupt('ic-rej') })

    const catchDie = new Error('ic-catch-die')
    const catchThrowExit = await ResultTask.tryPromise({
      try: () => Promise.reject(new Error('err')),
      catch: () => {
        throw catchDie
      },
    })
      .inspectCause((c) => seen.push(c))
      .runExit()
    expect(catchThrowExit).toEqual({ _tag: 'Failure', cause: Cause.die(catchDie) })

    const syncThrowExit = await ResultTask.tryPromise((): Promise<number> => {
      throw new Error('ic-sync-throw')
    }, errMessage)
      .inspectCause((c) => seen.push(c))
      .runExit()
    expect(syncThrowExit).toEqual({ _tag: 'Failure', cause: Cause.fail('ic-sync-throw') })
    expect(seen.length).toBeGreaterThanOrEqual(7)
  })
})

describe('ResultTask runResult fast-path, gen slow-path, JIT, and runFork coverage', () => {
  it('covers #runResultFastPath budget exhaustion, OP_FAIL continuation, and sync catch defect', async () => {
    const consumeFastResultBudget = (
      hops: number,
      terminal: () => ResultTask<string, string>,
    ): ResultTask<string, string> => {
      const step = (remaining: number): ResultTask<string, string> =>
        remaining === 0
          ? terminal()
          : ResultTask.tryPromise(() => Promise.resolve(remaining), errMessage).andThen(() =>
              step(remaining - 1),
            )
      return step(hops)
    }

    // Odd budget path: depth-2 head consumes 3 (2048 -> 2045), 1021 hops consume 2042 (-> 3),
    // final depth-1 hop enters #runResultFastPath(target, 1) where budget <= 1.
    const leafAtBudgetOne = ResultTask.tryPromise(() => Promise.resolve(0), errMessage)
      .map((n) => n + 1)
      .andThen(() =>
        consumeFastResultBudget(1022, () =>
          ResultTask.tryPromise(() => Promise.resolve('hit-leaf'), errMessage),
        ),
      )
    expect(await leafAtBudgetOne.runResult()).toEqual(ok('hit-leaf'))

    const chainAtBudgetOne = ResultTask.tryPromise(() => Promise.resolve(0), errMessage)
      .map((n) => n + 1)
      .andThen(() =>
        consumeFastResultBudget(1022, () =>
          ResultTask.tryPromise(() => Promise.resolve('hit-chain'), errMessage).map((s) => `${s}!`),
        ),
      )
    expect(await chainAtBudgetOne.runResult()).toEqual(ok('hit-chain!'))

    // Even budget path: 1023 hops consume 2046 (2048 -> 2), final depth-2 chain runs flatMap at
    // index = 1 (> 0) with remaining === 0 (hits #advanceFastContinuation L6926-6927).
    const yieldWithTail = consumeFastResultBudget(1023, () =>
      ResultTask.tryPromise(() => Promise.resolve('tail'), errMessage)
        .andThen((s) => ResultTask.sync(() => s))
        .map((s) => `${s}!`),
    )
    expect(await yieldWithTail.runResult()).toEqual(ok('tail!'))

    const failContinuation = await ResultTask.tryPromise(() => Promise.resolve(1), errMessage)
      .andThen(() => ResultTask.err('fast-fail' as const))
      .map((n: never) => n)
      .runResult()
    expect(failContinuation).toEqual(err('fast-fail'))

    const catchDefect = new Error('fast-catch-defect')
    await expect(
      ResultTask.tryPromise({
        try: (): Promise<number> => {
          throw new Error('sync-source')
        },
        catch: () => {
          throw catchDefect
        },
      })
        .map((x) => x)
        .runResult(),
    ).rejects.toBe(catchDefect)
  })

  it('covers dirty scope sync/async closure inside #runResultFromTaskAndSteps', async () => {
    const released: string[] = []
    const withSyncFinalizer = ResultTask.tryPromise(() => Promise.resolve(1), errMessage)
      .andThen(() =>
        ResultTask.acquireRelease({
          acquire: ResultTask.tryPromise(() => Promise.resolve(10), errMessage),
          release: () =>
            ResultTask.sync(() => {
              released.push('sync')
            }),
        }),
      )
      .map((n) => n + 1) as unknown as ResultTask<number, string>
    expect(await withSyncFinalizer.runResult()).toEqual(ok(11))

    const withAsyncFinalizer = ResultTask.tryPromise(() => Promise.resolve(1), errMessage)
      .andThen(() =>
        ResultTask.acquireRelease({
          acquire: ResultTask.tryPromise(() => Promise.resolve(20), errMessage),
          release: () =>
            ResultTask.fromPromise(async () => {
              released.push('async')
            }),
        }),
      )
      .map((n) => n + 1) as unknown as ResultTask<number, string>
    expect(await withAsyncFinalizer.runResult()).toEqual(ok(21))
    expect(released).toEqual(['sync', 'async'])
  })

  it('covers #runGenSlow yielding Err, JIT OP_TRY_PROMISE compilation, and JIT acquiring sync resumer', async () => {
    const Svc = serviceTag<number>('GenSlowErrSvc')
    const genSlowErr = ResultTask.gen(function* () {
      const n = yield* Svc
      if (n > 0) {
        yield* err('slow-gen-err' as const)
      }
      return n
    })
    expect(await genSlowErr.provideService(Svc, 1).runResult()).toEqual(err('slow-gen-err'))

    const jitTryPromise = ResultTask.tryPromise(() => Promise.resolve(1), errMessage)
      .map((n) => n + 1)
      .map((n) => n + 1)
      .map((n) => n + 1)
    expect(await jitTryPromise.runExit()).toEqual({ _tag: 'Success', value: 4 })
    expect(await jitTryPromise.runExit()).toEqual({ _tag: 'Success', value: 4 })
    expect(await jitTryPromise.runExit()).toEqual({ _tag: 'Success', value: 4 })

    const jitAcquire = ResultTask.ok(1)
      .map((n) => n + 1)
      .map((n) => n + 1)
      .andThen((n) => ResultTask.sync(() => n + 1))
    const acquireWrapper = ResultTask.acquireRelease({
      acquire: jitAcquire,
      release: () => ResultTask.ok(undefined),
    }).scoped()
    for (const yieldEvery of [10, 10, 3, 4, 5, 6]) {
      expect(await acquireWrapper.runExit({ yieldEvery })).toEqual({ _tag: 'Success', value: 4 })
    }
  })

  it('covers #runForkPooled and #finishRootFork async scope closes and host rejection defenses', async () => {
    const releaseSpy = vi.fn<() => void>()

    const pooledAsyncScope = ResultTask.acquireRelease({
      acquire: ResultTask.fromPromise(() => Promise.resolve(10)),
      release: () =>
        ResultTask.fromPromise(async () => {
          releaseSpy()
        }),
    }) as unknown as ResultTask<number>
    expect(await pooledAsyncScope.runFork().await().runPromise()).toEqual({
      _tag: 'Success',
      value: 10,
    })

    const pooledSyncScope = ResultTask.acquireRelease({
      acquire: ResultTask.ok(20),
      release: () =>
        ResultTask.fromPromise(async () => {
          releaseSpy()
        }),
    }) as unknown as ResultTask<number>
    expect(await pooledSyncScope.runFork().await().runPromise()).toEqual({
      _tag: 'Success',
      value: 20,
    })
    expect(releaseSpy).toHaveBeenCalledTimes(2)

    const syncThrowTask = ResultTask.ok(1)
    ;(syncThrowTask as unknown as { run: () => never }).run = () => {
      throw new Error('pooled-sync-throw')
    }
    expect((await syncThrowTask.runFork().await().runPromise())._tag).toBe('Failure')

    const rawRejectTask = ResultTask.ok(1)
    ;(rawRejectTask as unknown as { run: () => Promise<never> }).run = () =>
      Promise.reject(new Error('raw-reject'))
    expect((await rawRejectTask.runFork().await().runPromise())._tag).toBe('Failure')
    expect((await rawRejectTask.runFork({}).await().runPromise())._tag).toBe('Failure')

    expect(
      (await makeTaskWithScopeCloseRejection(true).runFork({}).await().runPromise())._tag,
    ).toBe('Failure')
    expect(
      (await makeTaskWithScopeCloseRejection(false).runFork({}).await().runPromise())._tag,
    ).toBe('Failure')
    expect((await makeTaskWithScopeCloseRejection(true).runFork().await().runPromise())._tag).toBe(
      'Failure',
    )
    expect((await makeTaskWithScopeCloseRejection(false).runFork().await().runPromise())._tag).toBe(
      'Failure',
    )
  })
})
