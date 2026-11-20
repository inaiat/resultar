import { failure, interrupted, success } from './exit.js'
import { NEVER_ABORTED_SIGNAL } from './promise-interruption.js'
import { ResultTask } from './result-task.js'
import type { Exit } from './result-task.js'
import { createRuntimeTask } from './task-runtime-bridge.js'

const QUEUE_SHUTDOWN_EXIT: Exit<never, never> = failure({
  _tag: 'Interrupt',
  reason: 'Queue shut down',
})

interface Taker<A> {
  readonly signal: AbortSignal
  readonly resolve: (exit: Exit<A, never>) => void
  readonly onAbort: () => void
  settled: boolean
}

interface Putter<A> {
  readonly value: A
  readonly signal: AbortSignal
  readonly resolve: (exit: Exit<boolean, never>) => void
  readonly onAbort: () => void
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

const shiftActive = <T extends { settled: boolean }>(
  items: (T | undefined)[],
  state: { head: number },
): T | undefined => {
  while (state.head < items.length) {
    const entry = items[state.head]
    items[state.head] = undefined
    state.head += 1
    if (entry !== undefined && !entry.settled) {
      if (state.head === items.length) {
        items.length = 0
        state.head = 0
      }
      return entry
    }
  }
  items.length = 0
  state.head = 0
  return undefined
}

const detachSignal = (signal: AbortSignal, listener: () => void): void => {
  if (signal !== NEVER_ABORTED_SIGNAL) {
    signal.removeEventListener('abort', listener)
  }
}

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
  const takers: (Taker<A> | undefined)[] = []
  const takersState = { head: 0 }
  const putters: (Putter<A> | undefined)[] = []
  const puttersState = { head: 0 }
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
      const putter = shiftActive(putters, puttersState)
      if (putter === undefined) break
      putter.settled = true
      detachSignal(putter.signal, putter.onAbort)
      pushBuffer(putter.value)
      putter.resolve(success(true))
    }
  }

  const deliverDirectOrBuffer = (value: A): boolean => {
    const taker = shiftActive(takers, takersState)
    if (taker !== undefined) {
      taker.settled = true
      detachSignal(taker.signal, taker.onAbort)
      taker.resolve(success(value))
      return true
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
      return new Promise<Exit<boolean, never>>((resolve) => {
        const putter: Putter<A> = {
          value,
          signal: context.signal,
          resolve,
          settled: false,
          onAbort: () => {
            if (putter.settled) return
            putter.settled = true
            resolve(interrupted(context.signal))
          },
        }
        if (context.signal !== NEVER_ABORTED_SIGNAL) {
          context.signal.addEventListener('abort', putter.onAbort, { once: true })
        }
        putters.push(putter)
      })
    })

  const take = (): ResultTask<A> =>
    createRuntimeTask<A>(ResultTask, (context) => {
      if (context.signal.aborted) return interrupted(context.signal)
      if (bufferedSize() > 0) {
        const value = shiftBuffer()
        refillFromPutters()
        return success(value)
      }
      if (closed) return QUEUE_SHUTDOWN_EXIT
      return new Promise<Exit<A, never>>((resolve) => {
        const taker: Taker<A> = {
          signal: context.signal,
          resolve,
          settled: false,
          onAbort: () => {
            if (taker.settled) return
            taker.settled = true
            resolve(interrupted(context.signal))
          },
        }
        if (context.signal !== NEVER_ABORTED_SIGNAL) {
          context.signal.addEventListener('abort', taker.onAbort, { once: true })
        }
        takers.push(taker)
      })
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
        const putter = shiftActive(putters, puttersState)
        if (putter === undefined) break
        putter.settled = true
        detachSignal(putter.signal, putter.onAbort)
        putter.resolve(success(false))
      }
      for (;;) {
        const taker = shiftActive(takers, takersState)
        if (taker === undefined) break
        taker.settled = true
        detachSignal(taker.signal, taker.onAbort)
        taker.resolve(QUEUE_SHUTDOWN_EXIT)
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
