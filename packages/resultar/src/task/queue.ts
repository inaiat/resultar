import { failure, interrupted, success } from './exit.js'
import { NEVER_ABORTED_SIGNAL } from './promise-interruption.js'
import { ResultTask } from './result-task.js'
import type { Exit } from './result-task.js'
import { createRuntimeTask } from './task-runtime-bridge.js'

const createQueueShutdownExit = (): Exit<never, never> =>
  failure({ _tag: 'Interrupt', reason: 'Queue shut down' })

interface Taker<A> {
  signal: AbortSignal | undefined
  resolve: ((exit: Exit<A, never>) => void) | undefined
  onAbort: (() => void) | undefined
  settled: boolean
}

interface Putter<A> {
  value: A | undefined
  signal: AbortSignal | undefined
  resolve: ((exit: Exit<boolean, never>) => void) | undefined
  onAbort: (() => void) | undefined
  settled: boolean
}

const assertPositiveCapacity = (capacity: number): void => {
  if (typeof capacity !== 'number' || !Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError('Queue.bounded capacity must be a positive safe integer')
  }
}

const assertNonNegativeLimit = (max: number): void => {
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 0) {
    throw new RangeError('Queue.takeUpTo max must be a non-negative safe integer')
  }
}

const shiftWaiter = <T>(waiters: Set<T>): T | undefined => {
  for (const waiter of waiters) {
    waiters.delete(waiter)
    return waiter
  }
  return undefined
}

const detachSignal = (
  signal: AbortSignal | undefined,
  listener: (() => void) | undefined,
): void => {
  if (signal !== undefined && listener !== undefined && signal !== NEVER_ABORTED_SIGNAL) {
    signal.removeEventListener('abort', listener)
  }
}

const clearTaker = <A>(taker: Taker<A>): void => {
  taker.signal = undefined
  taker.resolve = undefined
  taker.onAbort = undefined
}

const clearPutter = <A>(putter: Putter<A>): void => {
  putter.value = undefined
  putter.signal = undefined
  putter.resolve = undefined
  putter.onAbort = undefined
}

const makePutterAbortHandler =
  <A>(putters: Set<Putter<A>>, putter: Putter<A>): (() => void) =>
  () => {
    if (putter.settled) return
    putter.settled = true
    putters.delete(putter)
    const finish = putter.resolve
    const abortSignal = putter.signal
    clearPutter(putter)
    if (finish !== undefined && abortSignal !== undefined) {
      finish(interrupted(abortSignal))
    }
  }

const makeTakerAbortHandler =
  <A>(takers: Set<Taker<A>>, taker: Taker<A>): (() => void) =>
  () => {
    if (taker.settled) return
    taker.settled = true
    takers.delete(taker)
    const finish = taker.resolve
    const abortSignal = taker.signal
    clearTaker(taker)
    if (finish !== undefined && abortSignal !== undefined) {
      finish(interrupted(abortSignal))
    }
  }

const enqueuePutter = <A>(
  putters: Set<Putter<A>>,
  value: A,
  signal: AbortSignal,
): Promise<Exit<boolean, never>> =>
  new Promise<Exit<boolean, never>>((resolve) => {
    const putter: Putter<A> = { value, signal, resolve, onAbort: undefined, settled: false }
    const onAbort = makePutterAbortHandler(putters, putter)
    putter.onAbort = onAbort
    if (signal !== NEVER_ABORTED_SIGNAL) {
      signal.addEventListener('abort', onAbort, { once: true })
    }
    putters.add(putter)
  })

const enqueueTaker = <A>(takers: Set<Taker<A>>, signal: AbortSignal): Promise<Exit<A, never>> =>
  new Promise<Exit<A, never>>((resolve) => {
    const taker: Taker<A> = { signal, resolve, onAbort: undefined, settled: false }
    const onAbort = makeTakerAbortHandler(takers, taker)
    taker.onAbort = onAbort
    if (signal !== NEVER_ABORTED_SIGNAL) {
      signal.addEventListener('abort', onAbort, { once: true })
    }
    takers.add(taker)
  })

/**
 * Cooperative, backpressure-aware FIFO queue for producer-consumer `ResultTask` workflows.
 *
 * Bounded queues suspend `offer` when at capacity and resume producers in FIFO order as consumers
 * drain items. Calling `shutdown()` rejects new offers (`false`), interrupts blocked takers, and
 * lets consumers drain any already-buffered items before interrupting once empty.
 *
 * @example
 * ```ts
 * import { Queue, ResultTask } from 'resultar'
 *
 * const queue = Queue.bounded<string>(4)
 * const program = ResultTask.gen(function* () {
 *   yield* queue.offer('job-1')
 *   yield* queue.offer('job-2')
 *   const first = yield* queue.take()
 *   const rest = yield* queue.takeAll()
 *   return [first, ...rest]
 * })
 * ```
 */
export interface Queue<A> {
  /** Maximum buffered items (`Infinity` for unbounded queues). */
  readonly capacity: number
  /** Enqueues `value`, suspending on backpressure if bounded and full. Returns `false` if shut down. */
  readonly offer: (value: A) => ResultTask<boolean>
  /** Enqueues every item from `values` in order, stopping with `false` if the queue shuts down. */
  readonly offerAll: (values: Iterable<A>) => ResultTask<boolean>
  /** Dequeues the next item FIFO, suspending until available. Interrupts once shut down and empty. */
  readonly take: () => ResultTask<A>
  /** Non-blocking dequeue; returns `undefined` if no item is buffered. */
  readonly poll: () => ResultTask<A | undefined>
  /** Drains all currently buffered items without blocking and wakes waiting producers. */
  readonly takeAll: () => ResultTask<readonly A[]>
  /** Drains up to `max` currently buffered items without blocking and wakes waiting producers. */
  readonly takeUpTo: (max: number) => ResultTask<readonly A[]>
  /** Shuts down the queue: rejects new offers (`false`) and interrupts waiting takers. Idempotent. */
  readonly shutdown: () => ResultTask<void>
  /** Returns the number of currently buffered items. */
  readonly size: () => ResultTask<number>
  /** Reports whether `shutdown()` has been called. */
  readonly isShutdown: () => ResultTask<boolean>
}

const createQueue = <A>(capacity: number): Queue<A> => {
  const buffer: (A | undefined)[] = []
  let bufferHead = 0
  const takers = new Set<Taker<A>>()
  const putters = new Set<Putter<A>>()
  let closed = false

  const bufferedSize = (): number => buffer.length - bufferHead

  const pushBuffer = (value: A): void => {
    buffer.push(value)
  }

  const shiftBuffer = (): A => {
    const value = buffer[bufferHead] as A
    buffer[bufferHead] = undefined
    bufferHead += 1
    if (bufferHead === buffer.length) {
      buffer.length = 0
      bufferHead = 0
    }
    return value
  }

  const refillFromPutters = (): void => {
    if (closed) return
    while (bufferedSize() < capacity) {
      const putter = shiftWaiter(putters)
      if (putter === undefined) break
      if (!putter.settled) {
        putter.settled = true
        const value = putter.value as A
        const finish = putter.resolve
        detachSignal(putter.signal, putter.onAbort)
        clearPutter(putter)
        pushBuffer(value)
        finish?.(success(true))
      }
    }
  }

  const deliverDirectOrBuffer = (value: A): boolean => {
    for (;;) {
      const taker = shiftWaiter(takers)
      if (taker === undefined) break
      if (!taker.settled) {
        taker.settled = true
        const finish = taker.resolve
        detachSignal(taker.signal, taker.onAbort)
        clearTaker(taker)
        finish?.(success(value))
        return true
      }
    }
    if (bufferedSize() < capacity) {
      pushBuffer(value)
      return true
    }
    return false
  }

  const drainBuffered = (limit: number): readonly A[] => {
    const count = Math.min(limit, bufferedSize())
    if (count === 0) return []
    const items: A[] = []
    for (let index = 0; index < count; index += 1) {
      items.push(shiftBuffer())
    }
    refillFromPutters()
    return items
  }

  const offer = (value: A): ResultTask<boolean> =>
    createRuntimeTask<boolean>(ResultTask, (context) => {
      if (context.signal.aborted) return interrupted(context.signal)
      if (closed) return success(false)
      if (deliverDirectOrBuffer(value)) return success(true)
      return enqueuePutter(putters, value, context.signal)
    })

  const take = (): ResultTask<A> =>
    createRuntimeTask<A>(ResultTask, (context) => {
      if (context.signal.aborted) return interrupted(context.signal)
      if (bufferedSize() > 0) {
        const value = shiftBuffer()
        refillFromPutters()
        return success(value)
      }
      if (closed) return createQueueShutdownExit()
      return enqueueTaker(takers, context.signal)
    })

  const offerAll = (values: Iterable<A>): ResultTask<boolean> =>
    ResultTask.gen(function* () {
      for (const value of values) {
        const accepted = yield* offer(value)
        if (!accepted) return false
      }
      return true
    })

  const shutdown = (): ResultTask<void> =>
    ResultTask.sync(() => {
      if (closed) return
      closed = true
      for (;;) {
        const putter = shiftWaiter(putters)
        if (putter === undefined) break
        if (!putter.settled) {
          putter.settled = true
          const finish = putter.resolve
          detachSignal(putter.signal, putter.onAbort)
          clearPutter(putter)
          finish?.(success(false))
        }
      }
      for (;;) {
        const taker = shiftWaiter(takers)
        if (taker === undefined) break
        if (!taker.settled) {
          taker.settled = true
          const finish = taker.resolve
          detachSignal(taker.signal, taker.onAbort)
          clearTaker(taker)
          finish?.(createQueueShutdownExit())
        }
      }
    })

  return {
    capacity,
    offer,
    offerAll,
    take,
    poll: () =>
      ResultTask.sync(() => {
        if (bufferedSize() === 0) return undefined
        const value = shiftBuffer()
        refillFromPutters()
        return value
      }),
    takeAll: () => ResultTask.sync(() => drainBuffered(bufferedSize())),
    takeUpTo: (max) => {
      assertNonNegativeLimit(max)
      return ResultTask.sync(() => drainBuffered(max))
    },
    shutdown,
    size: () => ResultTask.sync(bufferedSize),
    isShutdown: () => ResultTask.sync(() => closed),
  }
}

/**
 * Factory namespace for bounded and unbounded cooperative {@link Queue} instances.
 *
 * @example
 * ```ts
 * import { Queue } from 'resultar'
 *
 * const jobs = Queue.bounded<number>(16)
 * await jobs.offer(1).runPromise()
 * const next = await jobs.take().runPromise()
 * // 1
 * ```
 */
export const Queue: {
  /** Creates a bounded FIFO queue with backpressure at `capacity` (`>= 1`). */
  readonly bounded: <A>(capacity: number) => Queue<A>
  /** Creates an unbounded FIFO queue (`offer` never suspends). */
  readonly unbounded: <A>() => Queue<A>
} = Object.freeze({
  bounded: <A>(capacity: number): Queue<A> => {
    assertPositiveCapacity(capacity)
    return createQueue<A>(capacity)
  },
  unbounded: <A>(): Queue<A> => createQueue<A>(Infinity),
})
