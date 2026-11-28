import { getEventListeners } from 'node:events'

import { describe, expect, it, vi } from 'vite-plus/test'

import { canUseJit } from '../src/core/jit.js'
import {
  isPromiseLike,
  isRetryElapsedExceeded,
  isRetryPolicy,
  Retry,
  retryContext,
  retryPolicyDelay,
} from '../src/core/retry.js'
import { Cause, Match, ok, Queue, ResultTask, Semaphore } from '../src/index.js'
import { isCleanupCause } from '../src/task/cleanup-cause.js'
import { detachedPromise, NEVER_ABORTED_SIGNAL } from '../src/task/promise-interruption.js'
import { TaskScope, type ScopeChild } from '../src/task/scope.js'
import { registerSemaphoreTaskFactory, type SemaphoreAcquire } from '../src/task/semaphore.js'

const DEFAULT_SCOPE_EXIT = { _tag: 'Success', value: undefined } as const

const makeScopeChild = (
  closeResult:
    | { readonly _tag: 'Success'; readonly value: unknown }
    | { readonly _tag: 'Failure'; readonly cause: Cause<unknown> } = DEFAULT_SCOPE_EXIT,
): ScopeChild & {
  readonly interrupt: ReturnType<typeof vi.fn<(reason: unknown) => void>>
  readonly close: ReturnType<typeof vi.fn<() => Promise<typeof closeResult>>>
} => ({
  interrupt: vi.fn<(reason: unknown) => void>(),
  close: vi.fn<() => Promise<typeof closeResult>>(async () => closeResult),
  owner: undefined,
})

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

describe('promise-interruption mutation coverage', () => {
  it('resolves cleanly with NEVER_ABORTED_SIGNAL without attaching abort listeners', async () => {
    const deferred = Promise.withResolvers<string>()
    const pending = detachedPromise(NEVER_ABORTED_SIGNAL, () => deferred.promise, String)
    expect(getEventListeners(NEVER_ABORTED_SIGNAL, 'abort')).toHaveLength(0)
    deferred.resolve('ok')
    expect(await pending).toEqual({ _tag: 'Success', value: 'ok' })
  })

  it('registers abort listeners with once: true and detaches them cleanly on resolution', async () => {
    const controller = new AbortController()
    const addSpy = vi.spyOn(controller.signal, 'addEventListener')
    const deferred = Promise.withResolvers<number>()

    const pending = detachedPromise(controller.signal, () => deferred.promise, String)
    expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)

    deferred.resolve(42)
    expect(await pending).toEqual({ _tag: 'Success', value: 42 })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('guards settlement so late fulfillment does not detach abort listeners twice', async () => {
    const controller = new AbortController()
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener')
    const deferred = Promise.withResolvers<string>()

    const pending = detachedPromise(controller.signal, () => deferred.promise, String)
    controller.abort('cancelled')
    expect(await pending).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'cancelled' },
    })
    expect(removeSpy).toHaveBeenCalledTimes(1)

    deferred.resolve('late')
    await Promise.resolve()
    await Promise.resolve()
    expect(removeSpy).toHaveBeenCalledTimes(1)
  })

  it('ignores late rejections in onFailure once already settled by abort', async () => {
    const listeners: (() => void)[] = []
    let abortedReads = 0
    const mockSignal = {
      get aborted(): boolean {
        abortedReads += 1
        return false
      },
      reason: 'custom-abort',
      addEventListener: (_type: string, listener: () => void) => {
        listeners.push(listener)
      },
      removeEventListener: () => undefined,
    } as unknown as AbortSignal

    const deferred = Promise.withResolvers<string>()
    const mapError = vi.fn(String)
    const pending = detachedPromise(mockSignal, () => deferred.promise, mapError)
    expect(abortedReads).toBe(1)

    for (const listener of listeners) listener()
    expect(await pending).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'custom-abort' },
    })

    deferred.reject(new Error('late-failure'))
    await Promise.resolve()
    await Promise.resolve()
    expect(abortedReads).toBe(1)
    expect(mapError).not.toHaveBeenCalled()
  })

  it('uses the native Promise fast path without an extra async-wrapper microtask tick', async () => {
    const order: string[] = []
    const resolved = Promise.resolve('fast')
    const pending = detachedPromise(NEVER_ABORTED_SIGNAL, () => resolved, String)
    void pending.then(() => {
      order.push('detached')
    })
    void Promise.resolve()
      .then(() => undefined)
      .then(() => {
        order.push('tick2')
      })

    expect(await pending).toEqual({ _tag: 'Success', value: 'fast' })
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['detached', 'tick2'])
  })
})

describe('retry core mutation coverage', () => {
  it('accepts zero boundaries and emits descriptive messages on negative bounds', () => {
    const zeroPolicy = Retry.policy({ times: 1, maxDelayMs: 0, maxElapsedMs: 0, jittered: 0 })
    expect(zeroPolicy.maxDelayMs).toBe(0)
    expect(zeroPolicy.maxElapsedMs).toBe(0)
    expect(zeroPolicy.jittered).toBe(0)

    expect(() => Retry.policy({ times: 1, maxDelayMs: -1 })).toThrow(
      new RangeError('Retry maxDelayMs must be a finite non-negative number'),
    )
    expect(() => Retry.policy({ times: 1, maxElapsedMs: -1 })).toThrow(
      new RangeError('Retry maxElapsedMs must be a finite non-negative number'),
    )
  })

  it('rejects null, primitives, and branded functions in isRetryPolicy', () => {
    const brand = Symbol.for('resultar/RetryPolicy')
    const brandedFn = Object.assign(() => undefined, { [brand]: brand })

    expect(isRetryPolicy(null)).toBe(false)
    expect(isRetryPolicy(undefined)).toBe(false)
    expect(isRetryPolicy(42)).toBe(false)
    expect(isRetryPolicy(brandedFn)).toBe(false)
    expect(isRetryPolicy(Retry.policy({ times: 1 }))).toBe(true)
  })

  it('handles zero base overflow, skips random when unnecessary, and guards zero jitter value', () => {
    const failRandom = (): number => {
      throw new Error('random should not be called')
    }

    const zeroBaseOverflow = Retry.policy({ times: 500, delayMs: 0, backoff: 10 })
    expect(retryPolicyDelay(zeroBaseOverflow, retryContext(400, 500), { random: failRandom })).toBe(
      0,
    )

    const noJitter = Retry.policy({ times: 1, delayMs: 50, jittered: 0 })
    expect(retryPolicyDelay(noJitter, retryContext(0, 1), { random: failRandom })).toBe(50)

    const zeroDelayWithJitter = Retry.policy({ times: 1, delayMs: 0, jittered: 0.5 })
    expect(retryPolicyDelay(zeroDelayWithJitter, retryContext(0, 1), { random: failRandom })).toBe(
      0,
    )

    const hugeJitter = Retry.policy({ times: 1, delayMs: Number.MAX_VALUE, jittered: 1 })
    expect(retryPolicyDelay(hugeJitter, retryContext(0, 1), { random: () => 0 })).toBe(0)
  })

  it('evaluates isRetryElapsedExceeded timing boundaries and isPromiseLike null safely', () => {
    const unreadTiming = {
      get startedAt(): number {
        throw new Error('should not read startedAt')
      },
      get now(): number {
        throw new Error('should not read now')
      },
      nextDelayMs: 10,
    }
    expect(isRetryElapsedExceeded(undefined, unreadTiming)).toBe(false)
    expect(isRetryElapsedExceeded(50, { startedAt: 1000, now: 1020, nextDelayMs: 10 })).toBe(false)
    expect(isRetryElapsedExceeded(50, { startedAt: 0, now: 50, nextDelayMs: 0 })).toBe(true)
    expect(isPromiseLike(null)).toBe(false)
  })
})

describe('match mutation coverage', () => {
  it('returns false on non-matching inputs for built-in primitive predicates', () => {
    expect(Match.string(123)).toBe(false)
    expect(Match.number('123')).toBe(false)
    expect(Match.boolean(0)).toBe(false)
    expect(Match.bigint(1)).toBe(false)
    expect(Match.symbol('sym')).toBe(false)
    expect(Match.null(undefined)).toBe(false)

    expect(Match.string('a')).toBe(true)
    expect(Match.number(1)).toBe(true)
    expect(Match.boolean(true)).toBe(true)
    expect(Match.bigint(1n)).toBe(true)
    expect(Match.symbol(Symbol('s'))).toBe(true)
    expect(Match.null(null)).toBe(true)
  })

  it('JIT-compiles all built-in predicate emitters in Match.type without falling back', () => {
    const matcher = Match.type<unknown>()
      .when(Match.nonEmptyString, (s) => `non-empty:${s}`)
      .when(Match.string, () => 'empty-string')
      .when(Match.number, (n) => `num:${String(n)}`)
      .when(Match.boolean, (b) => `bool:${String(b)}`)
      .when(Match.bigint, (bi) => `big:${String(bi)}`)
      .when(Match.symbol, () => 'sym')
      .when(Match.null, () => 'null')
      .when(Match.date, () => 'date')
      .when(Match.record, () => 'record')
      .when(Match.defined, () => 'defined')
      .when(Match.any, () => 'any')
      .exhaustive()

    expect(matcher.name === 'resultarMatchType').toBe(canUseJit())
    expect(matcher('hi')).toBe('non-empty:hi')
    expect(matcher('')).toBe('empty-string')
    expect(matcher(7)).toBe('num:7')
    expect(matcher(false)).toBe('bool:false')
    expect(matcher(2n)).toBe('big:2')
    expect(matcher(Symbol('x'))).toBe('sym')
    expect(matcher(null)).toBe('null')
    expect(matcher(new Date(0))).toBe('date')
    expect(matcher({ a: 1 })).toBe('record')
    expect(matcher([1])).toBe('defined')
    expect(matcher(undefined)).toBe('any')
  })

  it('initializes Match.type with an empty case list so 128 cases stay JIT-compiled', () => {
    let builder: ReturnType<typeof Match.type<number>> = Match.type<number>()
    for (let index = 0; index < 128; index += 1) {
      builder = builder.when(index, () => index) as unknown as ReturnType<typeof Match.type<number>>
    }
    const compiled = builder.orElse(() => -1)
    expect(compiled.name === 'resultarMatchType').toBe(canUseJit())
    expect(compiled(0)).toBe(0)
    expect(compiled(127)).toBe(127)
    expect(compiled(128)).toBe(-1)
  })

  it('excludes the handler argument from whenAnd patterns and tag lists', () => {
    const whenAndHandler = vi.fn(() => false)
    const result = Match.value(5)
      .whenAnd(Match.number, (n) => n > 0, whenAndHandler)
      .orElse(() => true)
    expect(result).toBe(false)
    expect(whenAndHandler).toHaveBeenCalledTimes(1)

    const tagHandler = (): string => 'matched'
    const taggedWithFn = Match.value({ _tag: tagHandler as unknown as 'A' })
      .tag('A', tagHandler)
      .orElse(() => 'miss')
    expect(taggedWithFn).toBe('miss')
  })

  it('handles curried type mode, non-object/function inputs, and undefined entries in valueTags', () => {
    const calls: unknown[][] = []
    const curried = Match.valueTags<{ readonly _tag: 'A' }, { readonly A: () => string }>({
      A: (...args: unknown[]) => {
        calls.push(args)
        return 'a'
      },
    }) as unknown as (input: unknown, extra?: unknown) => unknown

    expect(curried.name === 'resultarMatchType').toBe(canUseJit())
    expect(curried({ _tag: 'A' }, 'ignored-extra')).toBe('a')
    expect(calls).toEqual([[{ _tag: 'A' }]])

    expect(() =>
      Match.valueTags(undefined as unknown as { readonly _tag: 'A' }, { A: () => 1 }),
    ).toThrow('Match: no case matched the input')
    expect(() =>
      Match.valueTags(null as unknown as { readonly _tag: 'A' }, { A: () => 1 }),
    ).toThrow('Match: no case matched the input')

    const taggedFn = Object.assign(() => undefined, { _tag: 'A' as const })
    expect(Match.valueTags(taggedFn, { A: () => 'fn-tag' })).toBe('fn-tag')
    expect(Match.valueTags({ _tag: 'A' } as never, { A: () => 'ok', B: undefined } as never)).toBe(
      'ok',
    )
    expect(() => Match.valueTags({ _tag: 'A' } as never, { A: undefined } as never)).toThrow(
      'Match: no case matched the input',
    )
  })
})

describe('TaskScope mutation coverage', () => {
  it('enforces owner checks in unregisterChild and handles missing children set safely', () => {
    const scopeA = new TaskScope()
    const scopeB = new TaskScope()
    const child = makeScopeChild()
    scopeA.registerChild(child)

    scopeB.unregisterChild(child)
    expect(child.owner).toBe(scopeA)

    const freshScope = new TaskScope()
    const orphanChild = makeScopeChild()
    orphanChild.owner = freshScope
    freshScope.unregisterChild(orphanChild)
    expect(orphanChild.owner).toBeUndefined()
  })

  it('detaches children via addChild disposer so closing skips them', async () => {
    const scope = new TaskScope()
    const child = makeScopeChild()
    const remove = scope.addChild(child)
    remove()

    expect(child.owner).toBeUndefined()
    await scope.close({ _tag: 'Success', value: 1 })
    expect(child.interrupt).not.toHaveBeenCalled()
    expect(child.close).not.toHaveBeenCalled()
  })

  it('keeps parent clean when adopting empty drained child structures and clears adopted children', async () => {
    const emptyFinChild = new TaskScope()
    emptyFinChild.add(() => ({ _tag: 'Success', value: undefined }))
    await emptyFinChild.close({ _tag: 'Success', value: 1 })

    const parent1 = new TaskScope()
    parent1.adopt(emptyFinChild)
    expect(parent1.isClean()).toBe(true)

    const emptyChildSet = new TaskScope()
    const tempChild = makeScopeChild()
    emptyChildSet.registerChild(tempChild)
    emptyChildSet.unregisterChild(tempChild)

    const parent2 = new TaskScope()
    parent2.adopt(emptyChildSet)
    expect(parent2.isClean()).toBe(true)

    const donor = new TaskScope()
    const recipient = new TaskScope()
    const transferred = makeScopeChild()
    donor.registerChild(transferred)
    recipient.adopt(donor)

    await donor.close({ _tag: 'Success', value: 1 })
    expect(transferred.interrupt).not.toHaveBeenCalled()
    expect(transferred.owner).toBe(recipient)
  })

  it('returns a cached Promise from close() even on synchronous scopes', async () => {
    const scope = new TaskScope()
    const first = scope.close({ _tag: 'Success', value: 'done' })
    const second = scope.close({ _tag: 'Success', value: 'ignored' })

    expect(first).toBeInstanceOf(Promise)
    expect(second).toBe(first)
    expect(await first).toEqual({ _tag: 'Success', value: 'done' })
  })

  it('interrupts children with reason, clears child set after close, and marks cleanup causes', async () => {
    const cause1 = Cause.fail('child-1')
    const cause2 = Cause.fail('child-2')
    const child1 = makeScopeChild({ _tag: 'Failure', cause: cause1 })
    const child2 = makeScopeChild({ _tag: 'Failure', cause: cause2 })

    const scope = new TaskScope()
    scope.registerChild(child1)
    scope.registerChild(child2)
    await scope.close({ _tag: 'Success', value: undefined })

    expect(child1.interrupt).toHaveBeenCalledWith('ResultTask parent scope closed')
    expect(child2.interrupt).toHaveBeenCalledWith('ResultTask parent scope closed')
    expect(isCleanupCause(cause1)).toBe(true)
    expect(isCleanupCause(cause2)).toBe(true)
    expect(scope.cleanupExit._tag).toBe('Failure')
    if (scope.cleanupExit._tag === 'Failure') {
      expect(isCleanupCause(scope.cleanupExit.cause)).toBe(true)
    }

    const adopter = new TaskScope()
    adopter.adopt(scope)
    await adopter.close({ _tag: 'Success', value: undefined })
    expect(child1.close).toHaveBeenCalledTimes(1)
    expect(child2.close).toHaveBeenCalledTimes(1)
  })

  it('marks each failing finalizer and combined Sequential cleanup cause', async () => {
    const cause1 = Cause.fail('fin-1')
    const cause2 = Cause.fail('fin-2')
    const scope = new TaskScope()
    scope.add(() => ({ _tag: 'Failure', cause: cause1 }))
    scope.add(async () => ({ _tag: 'Failure', cause: cause2 }))

    await scope.close({ _tag: 'Success', value: undefined })
    expect(isCleanupCause(cause1)).toBe(true)
    expect(isCleanupCause(cause2)).toBe(true)
    expect(scope.cleanupExit._tag).toBe('Failure')
    if (scope.cleanupExit._tag === 'Failure') {
      expect(scope.cleanupExit.cause._tag).toBe('Sequential')
      expect(isCleanupCause(scope.cleanupExit.cause)).toBe(true)
    }
  })
})

describe('Semaphore mutation coverage', () => {
  it('validates permit counts, task arguments, and Semaphore instance shapes with exact messages', () => {
    expect(() => Semaphore.make(1.5)).toThrow(
      new RangeError('Semaphore.make permits must be a positive safe integer'),
    )
    expect(() => Semaphore.make(Infinity)).toThrow(RangeError)
    expect(() => Semaphore.make('2' as never)).toThrow(RangeError)

    const sem = Semaphore.make(2)
    expect(() => sem.withPermits(0)).toThrow(
      new RangeError('Semaphore.withPermits permits must be a positive safe integer'),
    )
    expect(() => sem.withPermits(1)('bad' as never)).toThrow(
      new TypeError('Semaphore.withPermits requires a task'),
    )
    expect(() => sem.withPermit('bad' as never)).toThrow(
      new TypeError('Semaphore.withPermit requires a task'),
    )

    const invalidSemaphores = [
      42,
      undefined,
      null,
      Object.assign(() => undefined, {
        withPermits: () => undefined,
        withPermit: () => undefined,
        available: () => 0,
      }),
      { withPermit: () => undefined, available: () => 0 },
      { withPermits: () => undefined, available: () => 0 },
      { withPermits: () => undefined, withPermit: () => undefined },
    ]
    for (const invalid of invalidSemaphores) {
      expect(() => Semaphore.withPermits(invalid as never, 1)).toThrow(
        new TypeError('Semaphore.withPermits expects a Semaphore instance'),
      )
      expect(() => Semaphore.withPermit(invalid as never)).toThrow(
        new TypeError('Semaphore.withPermit expects a Semaphore instance'),
      )
    }
  })

  it('preserves data-last single-argument delegation and data-first Semaphore.withPermits', async () => {
    const mockWithPermits = vi.fn(() => (task: ResultTask<number>) => task)
    const mockSem = {
      available: () => 1,
      withPermit: <A, E, R>(task: ResultTask<A, E, R>) => task,
      withPermits: mockWithPermits,
    } as unknown as Semaphore

    Semaphore.withPermits(mockSem, 2)
    expect(mockWithPermits).toHaveBeenCalledWith(2)

    const sem = Semaphore.make(3)
    const result = await Semaphore.withPermits(
      sem,
      2,
      ResultTask.sync(() => sem.available()),
    ).runResult()
    expect(result).toEqual(ok(1))
    expect(sem.available()).toBe(3)
  })

  it('reuses cached acquireOne and releaseOne closures and honors pre-aborted signals', () => {
    const capturedAcquires: SemaphoreAcquire[] = []
    const prev = registerSemaphoreTaskFactory((acquire, task) => {
      capturedAcquires.push(acquire)
      return task
    })
    try {
      const sem = Semaphore.make(2)
      sem.withPermit(ResultTask.ok(1))
      sem.withPermit(ResultTask.ok(2))
      expect(capturedAcquires).toHaveLength(2)
      expect(capturedAcquires[0]).toBe(capturedAcquires[1])

      const [acquireOne] = capturedAcquires
      expect(acquireOne).toBeDefined()
      if (acquireOne === undefined) return
      const aborted = new AbortController()
      aborted.abort('already')
      expect(acquireOne(aborted.signal)).toBeUndefined()
      expect(sem.available()).toBe(2)

      const release1 = acquireOne(NEVER_ABORTED_SIGNAL)
      const release2 = acquireOne(NEVER_ABORTED_SIGNAL)
      expect(typeof release1).toBe('function')
      expect(release1).toBe(release2)
      if (typeof release1 === 'function') release1()
      if (typeof release2 === 'function') release2()
      expect(sem.available()).toBe(2)
    } finally {
      registerSemaphoreTaskFactory(prev)
    }
  })

  it('registers abort listeners with once: true, detaches on grant, and skips NEVER_ABORTED_SIGNAL', async () => {
    const sem = Semaphore.make(1)
    const gate = Promise.withResolvers<void>()
    const holder = sem.withPermit(ResultTask.fromPromise(() => gate.promise)).runExit()

    const defaultWaiter = sem.withPermit(ResultTask.ok('default')).runExit()
    expect(getEventListeners(NEVER_ABORTED_SIGNAL, 'abort')).toHaveLength(0)

    const controller = new AbortController()
    const addSpy = vi.spyOn(controller.signal, 'addEventListener')
    const abortableWaiter = sem
      .withPermit(ResultTask.ok('abortable'))
      .runExit({ signal: controller.signal })

    expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)

    gate.resolve()
    expect(await holder).toEqual({ _tag: 'Success', value: undefined })
    expect(await defaultWaiter).toEqual({ _tag: 'Success', value: 'default' })
    expect(await abortableWaiter).toEqual({ _tag: 'Success', value: 'abortable' })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('prevents permit barging ahead of queued waiters and wakes behind waiters on abort', async () => {
    const sem = Semaphore.make(2)
    const holdGate = Promise.withResolvers<void>()
    const order: string[] = []

    const holder = sem
      .withPermit(
        ResultTask.fromPromise(async () => {
          await holdGate.promise
          order.push('holder')
        }),
      )
      .runExit()
    expect(sem.available()).toBe(1)

    const waiterBController = new AbortController()
    const waiterB = sem
      .withPermits(
        2,
        ResultTask.sync(() => {
          order.push('B')
        }),
      )
      .runExit({ signal: waiterBController.signal })

    const waiterC = sem
      .withPermit(
        ResultTask.sync(() => {
          order.push('C')
        }),
      )
      .runExit()

    // C must wait FIFO behind B even though 1 permit is available.
    await Promise.resolve()
    expect(order).toEqual([])
    expect(sem.available()).toBe(1)

    // Aborting B must immediately drain the queue and grant C while holder still runs.
    waiterBController.abort('drop-B')
    expect((await waiterB)._tag).toBe('Failure')
    expect(await waiterC).toEqual({ _tag: 'Success', value: undefined })
    expect(order).toEqual(['C'])

    holdGate.resolve()
    expect(await holder).toEqual({ _tag: 'Success', value: undefined })
    expect(sem.available()).toBe(2)
  })

  it('preserves FIFO order across > 70 queued waiters exercising queue compaction', async () => {
    const sem = Semaphore.make(1)
    const gate = Promise.withResolvers<void>()
    const order: number[] = []

    const holder = sem.withPermit(ResultTask.fromPromise(() => gate.promise)).runExit()
    const waiters = Array.from({ length: 75 }, (_, index) =>
      sem
        .withPermit(
          ResultTask.sync(() => {
            order.push(index)
          }),
        )
        .runExit(),
    )

    gate.resolve()
    await holder
    await Promise.all(waiters)
    expect(order).toEqual(Array.from({ length: 75 }, (_, index) => index))
    expect(sem.available()).toBe(1)
  })
})

describe('Queue mutation coverage', () => {
  it('validates bounded capacity and takeUpTo limits with exact RangeError messages', () => {
    for (const badCapacity of [0, 1.5, Infinity, '1' as never]) {
      expect(() => Queue.bounded(badCapacity)).toThrow(
        new RangeError('Queue.bounded capacity must be a positive safe integer'),
      )
    }

    const queue = Queue.bounded<number>(2)
    for (const badMax of [-1, 1.5, Number.NaN, '1' as never]) {
      expect(() => queue.takeUpTo(badMax)).toThrow(
        new RangeError('Queue.takeUpTo max must be a non-negative safe integer'),
      )
    }
  })

  it('skips NEVER_ABORTED_SIGNAL listeners and detaches abort listeners on take, offer, and shutdown', async () => {
    const queue = Queue.bounded<string>(1)
    queue.offer('seed').runSync()

    // Blocked putter with NEVER_ABORTED_SIGNAL
    const defaultPut = queue.offer('default-put').runExit()
    expect(getEventListeners(NEVER_ABORTED_SIGNAL, 'abort')).toHaveLength(0)

    // Blocked putter with AbortController woken by take()
    const putCtrl = new AbortController()
    const putSpy = vi.spyOn(putCtrl.signal, 'addEventListener')
    const abortablePut = queue.offer('abortable-put').runExit({ signal: putCtrl.signal })
    expect(putSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true })
    expect(getEventListeners(putCtrl.signal, 'abort')).toHaveLength(1)

    expect(queue.take().runSync()).toEqual(ok('seed'))
    expect(await defaultPut).toEqual({ _tag: 'Success', value: true })
    expect(queue.take().runSync()).toEqual(ok('default-put'))
    expect(await abortablePut).toEqual({ _tag: 'Success', value: true })
    expect(getEventListeners(putCtrl.signal, 'abort')).toHaveLength(0)
    expect(queue.take().runSync()).toEqual(ok('abortable-put'))

    // Blocked taker with NEVER_ABORTED_SIGNAL and AbortController woken by offer()
    const defaultTake = queue.take().runExit()
    expect(getEventListeners(NEVER_ABORTED_SIGNAL, 'abort')).toHaveLength(0)

    const takeCtrl = new AbortController()
    const takeSpy = vi.spyOn(takeCtrl.signal, 'addEventListener')
    const abortableTake = queue.take().runExit({ signal: takeCtrl.signal })
    expect(takeSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true })
    expect(getEventListeners(takeCtrl.signal, 'abort')).toHaveLength(1)

    expect(queue.offer('to-default').runSync()).toEqual(ok(true))
    expect(queue.offer('to-abortable').runSync()).toEqual(ok(true))
    expect(await defaultTake).toEqual({ _tag: 'Success', value: 'to-default' })
    expect(await abortableTake).toEqual({ _tag: 'Success', value: 'to-abortable' })
    expect(getEventListeners(takeCtrl.signal, 'abort')).toHaveLength(0)
  })

  it('detaches abort listeners from blocked putters and takers woken by shutdown', async () => {
    const fullQueue = Queue.bounded<string>(1)
    fullQueue.offer('fill').runSync()
    const putCtrl = new AbortController()
    const pendingPut = fullQueue.offer('blocked').runExit({ signal: putCtrl.signal })
    expect(getEventListeners(putCtrl.signal, 'abort')).toHaveLength(1)
    fullQueue.shutdown().runSync()
    expect((await pendingPut)._tag).toBe('Failure')
    expect(getEventListeners(putCtrl.signal, 'abort')).toHaveLength(0)

    const emptyQueue = Queue.bounded<string>(1)
    const takeCtrl = new AbortController()
    const pendingTake = emptyQueue.take().runExit({ signal: takeCtrl.signal })
    expect(getEventListeners(takeCtrl.signal, 'abort')).toHaveLength(1)
    emptyQueue.shutdown().runSync()
    expect((await pendingTake)._tag).toBe('Failure')
    expect(getEventListeners(takeCtrl.signal, 'abort')).toHaveLength(0)
  })

  it('refills from blocked putters on poll and takeUpTo, and guards pre-aborted offer and empty poll', async () => {
    const queue = Queue.bounded<string>(1)

    // Pre-aborted offer must not buffer an item
    const abortedExit = await queue
      .offer('dropped')
      .runExit({ signal: makeAbortAfterFirstRead('pre-aborted') })
    expect(abortedExit._tag).toBe('Failure')
    expect(queue.size().runSync()).toEqual(ok(0))

    // Empty poll must not corrupt count or ring indices
    expect(queue.poll().runSync()).toEqual(ok(undefined))
    expect(queue.size().runSync()).toEqual(ok(0))

    // poll() wakes blocked putter
    expect(queue.offer('first').runSync()).toEqual(ok(true))
    const blockedByPoll = queue.offer('second').runExit()
    expect(queue.poll().runSync()).toEqual(ok('first'))
    expect(await blockedByPoll).toEqual({ _tag: 'Success', value: true })
    expect(queue.size().runSync()).toEqual(ok(1))

    // takeUpTo() / drainBuffered() wakes blocked putter
    const blockedByDrain = queue.offer('third').runExit()
    expect(queue.takeUpTo(1).runSync()).toEqual(ok(['second']))
    expect(await blockedByDrain).toEqual({ _tag: 'Success', value: true })
    expect(queue.takeAll().runSync()).toEqual(ok(['third']))
  })
})
