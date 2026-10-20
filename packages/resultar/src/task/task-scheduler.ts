import { AbortError } from '../core/abort-error.js'
import { toNativeAbortSignal } from './exit.js'
import type { TaskClock } from './task-clock.js'

/**
 * Cooperative scheduler used by `ResultTask` fibers to yield control back to the host event loop
 * when the `yieldEvery` instruction budget is exhausted.
 */
export interface TaskScheduler {
  /** Yields execution until the scheduler resumes the fiber or `signal` aborts. */
  readonly yield: (signal: AbortSignal) => PromiseLike<void>
}

const live: TaskScheduler = Object.freeze({
  yield: (signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new AbortError('Task yield interrupted', { cause: signal.reason }))
        return
      }

      const onAbort = (): void => {
        clearImmediate(handle)
        signal.removeEventListener('abort', onAbort)
        reject(new AbortError('Task yield interrupted', { cause: signal.reason }))
      }
      const handle = setImmediate(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      })
      signal.addEventListener('abort', onAbort, { once: true })
    }),
})

/**
 * Built-in `ResultTask` schedulers.
 *
 * @example
 * ```ts
 * import { ResultTask, Scheduler } from 'resultar'
 *
 * const result = await ResultTask.ok(42)
 *   .runResult({ scheduler: Scheduler.live, yieldEvery: 128 })
 * ```
 */
export const Scheduler: {
  /** Default macrotask scheduler that yields to the event loop via `setImmediate`. */
  readonly live: TaskScheduler
} = Object.freeze({ live })

/** Mutable operation budget belonging to one running fiber. */
export interface TaskScheduling {
  scheduler: TaskScheduler
  readonly yieldEvery: number
  readonly clock: TaskClock
  remaining: number
}

const createSchedulingWithOptions = (
  clock: TaskClock,
  options: { readonly scheduler?: TaskScheduler; readonly yieldEvery?: number },
): TaskScheduling => {
  const yieldEvery = options.yieldEvery ?? 2048
  if (yieldEvery !== Infinity && (!Number.isSafeInteger(yieldEvery) || yieldEvery < 1)) {
    throw new RangeError('Task yieldEvery must be a positive safe integer or Infinity')
  }
  const scheduler = options.scheduler ?? Scheduler.live
  if (typeof scheduler.yield !== 'function') {
    throw new TypeError('Task scheduler must provide a yield function')
  }
  return { scheduler, yieldEvery, clock, remaining: yieldEvery }
}

/** A positive operation budget, or Infinity to disable automatic yields. */
export const createScheduling = (
  clock: TaskClock,
  options?: { readonly scheduler?: TaskScheduler; readonly yieldEvery?: number },
): TaskScheduling =>
  // Stryker disable next-line ConditionalExpression,EqualityOperator: default 2048 is a valid positive safe integer and Scheduler.live has a valid yield function.
  options === undefined
    ? { scheduler: Scheduler.live, yieldEvery: 2048, clock, remaining: 2048 }
    : createSchedulingWithOptions(clock, options)

/** Child fibers share the dispatcher but start with an independent operation budget. */
export const forkScheduling = (parent: TaskScheduling): TaskScheduling => ({
  scheduler: parent.scheduler,
  yieldEvery: parent.yieldEvery,
  clock: parent.clock,
  remaining: parent.yieldEvery,
})

/** A failed dispatcher cannot prevent registered finalizers from being executed. */
export const recoverScheduling = (scheduling: TaskScheduling): void => {
  scheduling.scheduler = Scheduler.live
  scheduling.remaining = scheduling.yieldEvery
}

const scheduledTasks = new WeakMap<TaskClock, number>()

/** Virtual clocks drain only their own queued default-dispatcher work before advancing time. */
export const hasScheduledTasks = (clock: TaskClock): boolean => (scheduledTasks.get(clock) ?? 0) > 0

const dispatch = (scheduling: TaskScheduling, signal: AbortSignal): Promise<void> => {
  if (scheduling.scheduler !== Scheduler.live) {
    return Promise.resolve(scheduling.scheduler.yield(toNativeAbortSignal(signal)))
  }
  const clock = scheduling.clock
  scheduledTasks.set(clock, (scheduledTasks.get(clock) ?? 0) + 1)
  const settled = (): void => {
    const remaining = (scheduledTasks.get(clock) as unknown as number) - 1
    if (remaining === 0) scheduledTasks.delete(clock)
    else scheduledTasks.set(clock, remaining)
  }
  return Promise.resolve(scheduling.scheduler.yield(signal)).finally(settled)
}

/** Returns no Promise on the fast path, avoiding an extra microtask per instruction. */
export const schedulerCheckpoint = (
  scheduling: TaskScheduling | undefined,
  signal: AbortSignal,
): Promise<void> | undefined => {
  if (scheduling === undefined) return undefined
  scheduling.remaining -= 1
  if (scheduling.remaining > 0) return undefined
  if (signal.aborted) {
    scheduling.remaining += 1
    return undefined
  }
  scheduling.remaining = scheduling.yieldEvery
  return dispatch(scheduling, signal)
}
