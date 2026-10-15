import type { ResultTask } from './result-task.js'

export type SemaphoreTaskFactory = <A, E, R>(
  acquire: (signal: AbortSignal) => Promise<(() => void) | undefined>,
  task: ResultTask<A, E, R>,
  caller: string,
) => ResultTask<A, E, R>

let semaphoreTaskFactory: SemaphoreTaskFactory | undefined = undefined

export const registerSemaphoreTaskFactory = (
  factory: SemaphoreTaskFactory | undefined,
): SemaphoreTaskFactory | undefined => {
  const previous = semaphoreTaskFactory
  semaphoreTaskFactory = factory
  return previous
}

const createSemaphoreTask: SemaphoreTaskFactory = (acquire, task, caller) => {
  if (semaphoreTaskFactory === undefined) {
    throw new TypeError('ResultTask has not initialized')
  }
  return semaphoreTaskFactory(acquire, task, caller)
}

interface Waiter {
  readonly permits: number
  readonly signal: AbortSignal
  readonly resolve: (release: (() => void) | undefined) => void
  readonly onAbort: () => void
}

const assertPositiveSafeInteger = (permits: number, label: string): void => {
  if (typeof permits !== 'number' || !Number.isSafeInteger(permits) || permits < 1) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
}

/** Cooperative, shareable permit limiter for `ResultTask` workflows. */
export interface Semaphore {
  /** Returns the number of currently available permits. */
  readonly available: () => number
  /** Acquires `permits` in FIFO order before executing `task`, and always releases them on completion or interruption. */
  readonly withPermits: {
    (permits: number): <A, E, R>(task: ResultTask<A, E, R>) => ResultTask<A, E, R>
    <A, E, R>(permits: number, task: ResultTask<A, E, R>): ResultTask<A, E, R>
  }
  /** Acquires a single permit before executing `task`, and always releases it on completion or interruption. */
  readonly withPermit: <A, E, R>(task: ResultTask<A, E, R>) => ResultTask<A, E, R>
}

const make = (permits: number): Semaphore => {
  assertPositiveSafeInteger(permits, 'Semaphore.make permits')
  let currentPermits = permits
  const waiters: Waiter[] = []

  const makeRelease =
    (released: number): (() => void) =>
    () => {
      currentPermits += released
      drainQueue()
    }

  const drainQueue = (): void => {
    while (waiters.length > 0) {
      const next = waiters[0]
      if (next === undefined || next.permits > currentPermits) {
        break
      }
      waiters.shift()
      currentPermits -= next.permits
      next.signal.removeEventListener('abort', next.onAbort)
      next.resolve(makeRelease(next.permits))
    }
  }

  const acquire = (requested: number, signal: AbortSignal): Promise<(() => void) | undefined> => {
    if (signal.aborted) {
      return Promise.resolve(undefined)
    }
    if (waiters.length === 0 && currentPermits >= requested) {
      currentPermits -= requested
      return Promise.resolve(makeRelease(requested))
    }
    return new Promise<(() => void) | undefined>((resolve) => {
      const waiter: Waiter = {
        permits: requested,
        signal,
        resolve,
        onAbort: () => {
          waiters.splice(waiters.indexOf(waiter), 1)
          resolve(undefined)
          drainQueue()
        },
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      waiters.push(waiter)
    })
  }

  const runWithPermits = <A, E, R>(
    requested: number,
    task: ResultTask<A, E, R>,
    caller: string,
  ): ResultTask<A, E, R> =>
    createSemaphoreTask((signal) => acquire(requested, signal), task, caller)

  function withPermits(
    requested: number,
  ): <A, E, R>(task: ResultTask<A, E, R>) => ResultTask<A, E, R>
  function withPermits<A, E, R>(requested: number, task: ResultTask<A, E, R>): ResultTask<A, E, R>
  function withPermits<A, E, R>(
    requested: number,
    task?: ResultTask<A, E, R>,
  ):
    | ResultTask<A, E, R>
    | (<A2, E2, R2>(nextTask: ResultTask<A2, E2, R2>) => ResultTask<A2, E2, R2>) {
    assertPositiveSafeInteger(requested, 'Semaphore.withPermits permits')
    if (requested > permits) {
      throw new RangeError(
        `Semaphore.withPermits requested ${String(requested)} permits, exceeding capacity ${String(permits)}`,
      )
    }
    if (task === undefined) {
      return <A2, E2, R2>(nextTask: ResultTask<A2, E2, R2>) =>
        runWithPermits(requested, nextTask, 'Semaphore.withPermits')
    }
    return runWithPermits(requested, task, 'Semaphore.withPermits')
  }

  const withPermit = <A, E, R>(task: ResultTask<A, E, R>): ResultTask<A, E, R> =>
    runWithPermits(1, task, 'Semaphore.withPermit')

  return Object.freeze({ available: () => currentPermits, withPermits, withPermit })
}

const assertSemaphore = (semaphore: Semaphore, caller: string): void => {
  if (
    typeof semaphore !== 'object' ||
    semaphore === null ||
    typeof semaphore.withPermits !== 'function' ||
    typeof semaphore.withPermit !== 'function' ||
    typeof semaphore.available !== 'function'
  ) {
    throw new TypeError(`${caller} expects a Semaphore instance`)
  }
}

function withPermits(
  semaphore: Semaphore,
  permits: number,
): <A, E, R>(task: ResultTask<A, E, R>) => ResultTask<A, E, R>
function withPermits<A, E, R>(
  semaphore: Semaphore,
  permits: number,
  task: ResultTask<A, E, R>,
): ResultTask<A, E, R>
function withPermits<A, E, R>(
  semaphore: Semaphore,
  permits: number,
  task?: ResultTask<A, E, R>,
):
  | ResultTask<A, E, R>
  | (<A2, E2, R2>(nextTask: ResultTask<A2, E2, R2>) => ResultTask<A2, E2, R2>) {
  assertSemaphore(semaphore, 'Semaphore.withPermits')
  if (task === undefined) {
    return semaphore.withPermits(permits)
  }
  return semaphore.withPermits(permits, task)
}

function withPermit(
  semaphore: Semaphore,
): <A, E, R>(task: ResultTask<A, E, R>) => ResultTask<A, E, R>
function withPermit<A, E, R>(semaphore: Semaphore, task: ResultTask<A, E, R>): ResultTask<A, E, R>
function withPermit<A, E, R>(
  semaphore: Semaphore,
  task?: ResultTask<A, E, R>,
):
  | ResultTask<A, E, R>
  | (<A2, E2, R2>(nextTask: ResultTask<A2, E2, R2>) => ResultTask<A2, E2, R2>) {
  assertSemaphore(semaphore, 'Semaphore.withPermit')
  if (task === undefined) {
    return <A2, E2, R2>(nextTask: ResultTask<A2, E2, R2>) => semaphore.withPermit(nextTask)
  }
  return semaphore.withPermit(task)
}

/** Operations for creating and applying cooperative semaphores across `ResultTask` pipelines. */
export const Semaphore: {
  /** Creates a semaphore with `permits` available permits. */
  readonly make: (permits: number) => Semaphore
  /** Acquires `permits` on `semaphore` for the duration of `task`. */
  readonly withPermits: typeof withPermits
  /** Acquires 1 permit on `semaphore` for the duration of `task`. */
  readonly withPermit: typeof withPermit
} = Object.freeze({ make, withPermits, withPermit })
