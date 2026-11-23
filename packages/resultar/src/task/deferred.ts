import type { Cause } from './cause.js'
import { died, failed, failure, interrupted, success } from './exit.js'
import { NEVER_ABORTED_SIGNAL } from './promise-interruption.js'
import { ResultTask } from './result-task.js'
import type { Exit } from './result-task.js'
import { createRuntimeTask, runRuntimeTask } from './task-runtime-bridge.js'
import { copyCauseSpans } from './tracer.js'
import { isolateExitForObserver, transformCause } from './cause-transform.js'

const interruptedCompletion = (
  exit: Exit<unknown, unknown>,
  signal: AbortSignal,
): Exit<never, never> => {
  if (exit._tag === 'Success') return interrupted(signal)
  let hasInterrupt = false
  const remaining = transformCause(exit.cause, (leaf) => {
    if (leaf._tag === 'Fail') return undefined
    if (leaf._tag === 'Interrupt') hasInterrupt = true
    return leaf
  }) as Cause<never> | undefined
  if (hasInterrupt && remaining !== undefined) return failure(remaining)
  const interrupt: Cause<never> = { _tag: 'Interrupt', reason: signal.reason }
  const cause: Cause<never> =
    remaining === undefined ? interrupt : { _tag: 'Sequential', left: interrupt, right: remaining }
  copyCauseSpans(exit.cause, cause)
  return failure(cause)
}

interface DeferredWaiter<A, E> {
  readonly signal: AbortSignal
  readonly resolve: (exit: Exit<A, E>) => void
  readonly onAbort: () => void
}

/**
 * One-shot asynchronous coordination variable that fibers can await and complete at most once.
 *
 * Multiple fibers may await the same `Deferred`; once completed with `succeed`, `fail`, `die`,
 * `done`, or `complete`, each waiter receives the same outcome with an isolated failure cause.
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
  /** Runs `task` and completes this deferred with its resulting `Exit` unless the completing fiber is interrupted. Returns `true` iff completed by this call. */
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
    settled = isolateExitForObserver(exit)
    for (const waiter of waiters) {
      if (waiter.signal !== NEVER_ABORTED_SIGNAL) {
        waiter.signal.removeEventListener('abort', waiter.onAbort)
      }
      waiter.resolve(isolateExitForObserver(exit))
    }
    waiters.clear()
    return true
  }

  return {
    await: () =>
      createRuntimeTask<A, E>(ResultTask, (context) => {
        if (settled !== undefined) return isolateExitForObserver(settled)
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
        const finish = (exit: Exit<A, E>): Exit<boolean, never> =>
          context.signal.aborted
            ? interruptedCompletion(exit, context.signal)
            : success(settle(exit))
        return outcome instanceof Promise ? outcome.then(finish) : finish(outcome)
      }),
    poll: () =>
      ResultTask.sync(() => (settled === undefined ? undefined : isolateExitForObserver(settled))),
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
