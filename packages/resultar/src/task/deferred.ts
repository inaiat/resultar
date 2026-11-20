import { died, failed, interrupted, success } from './exit.js'
import { NEVER_ABORTED_SIGNAL } from './promise-interruption.js'
import { ResultTask } from './result-task.js'
import type { Exit } from './result-task.js'
import { createRuntimeTask, runRuntimeTask } from './task-runtime-bridge.js'

interface DeferredWaiter<A, E> {
  readonly signal: AbortSignal
  readonly resolve: (exit: Exit<A, E>) => void
  readonly onAbort: () => void
}

/**
 * One-shot asynchronous coordination variable that fibers can await and complete at most once.
 *
 * Multiple fibers may await the same `Deferred`; once completed with `succeed`, `fail`, `die`,
 * `done`, or `complete`, every current and future waiter receives the exact same {@link Exit}.
 * Canceling an awaiting fiber unregisters its listener without affecting the `Deferred` or other
 * waiters.
 *
 * @example
 * ```ts
 * import { Deferred, ResultTask } from 'resultar'
 *
 * const ready = Deferred.make<string>()
 * const program = ResultTask.gen(function* () {
 *   const waiter = yield* ready.await().forkChild()
 *   yield* ready.succeed('connected')
 *   return yield* waiter.join()
 * }).scoped()
 * ```
 */
export interface Deferred<A, E = never> {
  /** Waits until this deferred completes and replays its `Exit`. Respects cancellation. */
  readonly await: () => ResultTask<A, E>
  /** Completes this deferred with `Success(value)` if still pending. Returns `true` iff completed by this call. */
  readonly succeed: (value: A) => ResultTask<boolean>
  /** Completes this deferred with `Fail(error)` if still pending. Returns `true` iff completed by this call. */
  readonly fail: (error: E) => ResultTask<boolean>
  /** Completes this deferred with `Die(defect)` if still pending. Returns `true` iff completed by this call. */
  readonly die: (defect: unknown) => ResultTask<boolean>
  /** Completes this deferred with an arbitrary `Exit<A, E>` if still pending. Returns `true` iff completed by this call. */
  readonly done: (exit: Exit<A, E>) => ResultTask<boolean>
  /** Runs `task` and completes this deferred with its resulting `Exit`. Returns `true` iff completed by this call. */
  readonly complete: <R>(task: ResultTask<A, E, R>) => ResultTask<boolean, never, R>
  /** Lazily checks the current `Exit` without blocking (`undefined` while pending). */
  readonly poll: () => ResultTask<Exit<A, E> | undefined>
  /** Lazily reports whether this deferred has already been completed. */
  readonly isDone: () => ResultTask<boolean>
}

const make = <A, E = never>(): Deferred<A, E> => {
  let settled: Exit<A, E> | undefined = undefined
  const waiters = new Set<DeferredWaiter<A, E>>()

  const settle = (exit: Exit<A, E>): boolean => {
    if (settled !== undefined) return false
    settled = exit
    for (const waiter of waiters) {
      if (waiter.signal !== NEVER_ABORTED_SIGNAL) {
        waiter.signal.removeEventListener('abort', waiter.onAbort)
      }
      waiter.resolve(exit)
    }
    waiters.clear()
    return true
  }

  return {
    await: () =>
      createRuntimeTask<A, E>(ResultTask, (context) => {
        if (settled !== undefined) return settled
        if (context.signal.aborted) return interrupted(context.signal)
        return new Promise<Exit<A, E>>((resolve) => {
          const waiter: DeferredWaiter<A, E> = {
            signal: context.signal,
            resolve,
            onAbort: () => {
              waiters.delete(waiter)
              resolve(interrupted(context.signal))
            },
          }
          if (context.signal !== NEVER_ABORTED_SIGNAL) {
            context.signal.addEventListener('abort', waiter.onAbort, { once: true })
          }
          waiters.add(waiter)
        })
      }),
    succeed: (value) => ResultTask.sync(() => settle(success(value))),
    fail: (error) => ResultTask.sync(() => settle(failed(error))),
    die: (defect) => ResultTask.sync(() => settle(died(defect))),
    done: (exit) => ResultTask.sync(() => settle(exit)),
    complete: <R>(task: ResultTask<A, E, R>) =>
      createRuntimeTask<boolean, never, R>(ResultTask, (context) => {
        const outcome = runRuntimeTask(ResultTask, task, context)
        if (outcome instanceof Promise) {
          return outcome.then((exit) => success(settle(exit)))
        }
        return success(settle(outcome))
      }),
    poll: () => ResultTask.sync(() => settled),
    isDone: () => ResultTask.sync(() => settled !== undefined),
  }
}

/**
 * Factory namespace for constructing one-shot {@link Deferred} coordination variables.
 *
 * @example
 * ```ts
 * import { Deferred } from 'resultar'
 *
 * const gate = Deferred.make<number>()
 * await gate.succeed(42).runPromise()
 * const value = await gate.await().runPromise()
 * // 42
 * ```
 */
export const Deferred: {
  /** Creates a new pending {@link Deferred} variable. */
  readonly make: <A, E = never>() => Deferred<A, E>
} = Object.freeze({ make })
