import {
  isRetryPolicy,
  observeRetry,
  retryContext,
  retryPolicyDelay,
  validateRetryPolicy,
} from '../core/retry.js'
import type { RetryContext, RetryPolicy } from '../core/retry.js'
import type { Result } from '../result.js'
import type { Cause } from './cause.js'
import { transformCause, withoutInterruptions } from './cause-transform.js'
import { isCleanupCause } from './cleanup-cause.js'
import { combineExits, died, failure, success } from './exit.js'
import type { SupervisedFiber } from './fiber-runtime.js'
import { detachedPromise } from './promise-interruption.js'
import type { Exit } from './result-task.js'
import type { TaskClock } from './task-clock.js'
import type { ResultTaskRuntimeContext } from './task-service.js'

/** Concurrency defaults to one; unbounded execution must be requested explicitly. */
export interface ResultTaskConcurrencyOptions {
  readonly concurrency?: number | 'unbounded'
}

/** Controls whether `zip` evaluates both tasks sequentially (default) or concurrently. */
export interface ResultTaskZipOptions {
  readonly concurrent?: boolean
}

/** Retries count additional attempts; only simple typed failures are retried. */
export interface ResultTaskRetryOptions<E> {
  readonly times: number
  readonly delayMs?: number | ((retry: number, error: E) => number)
  readonly backoff?: number
  readonly jittered?: boolean
  readonly while?: (error: E, retry: number) => boolean
}

export type ResultTaskRetryInput<E> = ResultTaskRetryOptions<E> | RetryPolicy<E>

/** Rejection used when a simplified boundary cannot represent multiple failures. */
export class ResultTaskCauseError extends Error {
  public override readonly cause!: Cause<unknown>

  public constructor(cause: Cause<unknown>) {
    super('ResultTask execution failed with multiple causes')
    this.name = 'ResultTaskCauseError'
    Object.defineProperty(this, 'cause', {
      configurable: true,
      enumerable: false,
      value: cause,
      writable: true,
    })
  }
}

/** Handlers for matching both success and failure cases of a ResultTask. */
export type ResultTaskMatchOptions<A, E, B, C = B> =
  | { readonly ok: (value: A) => B; readonly err: (error: E) => C }
  | { readonly ok: (value: A) => B; readonly error: (error: E) => C }
  | { readonly onSuccess: (value: A) => B; readonly onFailure: (error: E) => C }

export const taskSuccessHandler = <A, E, B, C>(
  handlers: ResultTaskMatchOptions<A, E, B, C>,
): ((value: A) => B) => ('onSuccess' in handlers ? handlers.onSuccess : handlers.ok)

export const taskFailureHandler = <A, E, B, C>(
  handlers: ResultTaskMatchOptions<A, E, B, C>,
): ((error: E) => C) => {
  if ('onFailure' in handlers) return handlers.onFailure
  if ('error' in handlers) return handlers.error
  return handlers.err
}

export const getReason = (value: unknown): unknown =>
  (value as { readonly reason?: unknown }).reason

/**
 * A lazy, composable workflow that can succeed with `A`, fail with a typed error `E`,
 * and declare execution requirements `R` (such as `ServiceTag`s or `ResultTaskScope`).
 *
 * Constructing a `ResultTask` never starts its work. Use `ResultTask.runResult`,
 * `ResultTask.runExit`, `ResultTask.runPromise`, or `ResultTask.runFork` at an
 * explicit application boundary to execute it.
 *
 * @example
 * ```ts
 * import { ResultTask } from 'resultar'
 *
 * const task = ResultTask.ok(21).map((n) => n * 2)
 * const result = await ResultTask.runResult(task)
 * // Ok(42)
 * ```
 */
export type ResultAsyncFinalizer<T, E> = (
  value: T | undefined,
  error: E | undefined,
) => void | Promise<void>

/**
 * Wrapper around a Result-producing Promise that also implements AsyncDisposable (`await using`).
 */
export class DisposableResultAsync<T, E> implements PromiseLike<Result<T, E>>, AsyncDisposable {
  readonly #promise: Promise<Result<T, E>>
  readonly #finalizer: ResultAsyncFinalizer<T, E>
  #disposed = false

  public constructor(promise: Promise<Result<T, E>>, finalizer: ResultAsyncFinalizer<T, E>) {
    this.#promise = promise
    this.#finalizer = finalizer
  }

  // eslint-disable-next-line unicorn/no-thenable -- Intentional PromiseLike implementation for `await using`.
  public then<TResult1 = Result<T, E>, TResult2 = never>(
    onfulfilled?: ((value: Result<T, E>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.#promise.then(onfulfilled, onrejected)
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) {
      return
    }

    this.#disposed = true
    const result = await this.#promise

    try {
      await this.#finalizer(
        result.isOk() ? result.value : undefined,
        result.isErr() ? result.error : undefined,
      )
    } catch {
      /* empty */
    }
  }
}

/** Scheduler defects are appended once at the cleanup boundary, never to intermediate yields. */
export const completeCleanup = <A, E>(
  exit: Exit<A, E>,
  context: ResultTaskRuntimeContext,
): Exit<A, E> =>
  context.cleanup === undefined
    ? exit
    : (combineExits(exit, context.cleanup.schedulerFailure, 'Sequential') as Exit<A, E>)

export const checkedDuration = (milliseconds: number): number => {
  if (!Number.isFinite(milliseconds) || milliseconds < 0)
    throw new RangeError('Task duration must be a finite non-negative number')
  return milliseconds
}

export const checkedConcurrency = (options?: ResultTaskConcurrencyOptions): number => {
  const concurrency = options?.concurrency ?? 1
  if (concurrency === 'unbounded') return Infinity
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new RangeError('Task concurrency must be a positive safe integer or unbounded')
  return concurrency
}

const checkedRandom = (clock: TaskClock): number => {
  const random = clock.random()
  if (!Number.isFinite(random) || random < 0 || random > 1)
    throw new RangeError('Task clock random must return a number between zero and one')
  return random
}

const retryFailure = (
  exit: Exit<unknown, unknown>,
  retry: number,
  options: ResultTaskRetryOptions<unknown>,
): { readonly error: unknown } | undefined => {
  if (exit._tag === 'Success' || exit.cause._tag !== 'Fail' || retry >= options.times)
    return undefined
  if (options.while?.(exit.cause.error, retry + 1) === false) return undefined
  return { error: exit.cause.error }
}

const retryDelay = (
  retry: number,
  error: unknown,
  policy: { readonly options: ResultTaskRetryOptions<unknown>; readonly clock: TaskClock },
): number => {
  const { options, clock } = policy
  const base =
    typeof options.delayMs === 'function'
      ? options.delayMs(retry + 1, error)
      : (options.delayMs ?? 0)
  const delay = checkedDuration(base * (options.backoff ?? 1) ** retry)
  return options.jittered === true ? delay * checkedRandom(clock) : delay
}

export const legacyRetryDelay = (
  exit: Exit<unknown, unknown>,
  retry: number,
  runtime: { readonly options: ResultTaskRetryOptions<unknown>; readonly clock: TaskClock },
): number | undefined => {
  const { options, clock } = runtime
  const next = retryFailure(exit, retry, options)
  return next === undefined ? undefined : retryDelay(retry, next.error, { options, clock })
}

const canonicalRetryDecision = async (
  policy: RetryPolicy<unknown>,
  error: unknown,
  runtime: { readonly context: RetryContext; readonly signal: AbortSignal },
): Promise<Exit<boolean, never>> => {
  const predicate = policy.while
  if (predicate === undefined) return success(true)
  return detachedPromise(
    runtime.signal,
    () => Promise.resolve(predicate(error, runtime.context)),
    throwDefect,
  )
}

export const canonicalRetryDelay = async (
  exit: Exit<unknown, unknown>,
  attempt: number,
  runtime: {
    readonly policy: RetryPolicy<unknown>
    readonly clock: TaskClock
    readonly signal: AbortSignal
  },
): Promise<Exit<number | undefined, never>> => {
  const { policy, clock, signal } = runtime
  if (exit._tag === 'Success' || exit.cause._tag !== 'Fail' || attempt >= policy.times) {
    return success(undefined)
  }
  const context = retryContext(attempt, policy.times)
  const error = exit.cause.error
  const decision = await canonicalRetryDecision(policy, error, { context, signal })
  if (decision._tag === 'Failure') return decision
  if (!decision.value) return success(undefined)
  const observation = await detachedPromise(
    signal,
    () => observeRetry(policy, error, context),
    throwDefect,
  )
  if (observation._tag === 'Failure') return observation
  return success(retryPolicyDelay(policy, context, () => clock.random()))
}

export const validateTaskRetry = (options: ResultTaskRetryInput<unknown>): void => {
  if (isRetryPolicy(options)) {
    validateRetryPolicy(options)
    return
  }
  if (!Number.isSafeInteger(options.times) || options.times < 0) {
    throw new RangeError('Task retries must be a non-negative safe integer')
  }
  if (options.backoff !== undefined && (!Number.isFinite(options.backoff) || options.backoff < 1)) {
    throw new RangeError('Task backoff must be at least one')
  }
  if (typeof options.delayMs === 'number') checkedDuration(options.delayMs)
}

const collectionFailure = (
  exit: Exit<unknown, unknown>,
  validate: boolean,
): Exit<unknown, unknown> => {
  if (exit._tag === 'Success') return success(undefined)
  if (validate && exit.cause._tag === 'Fail') return success(undefined)
  const cause = withoutInterruptions(exit.cause)
  if (cause === undefined) return success(undefined)
  return validate ? died(new ResultTaskCauseError(cause)) : failure(cause)
}

export const collectOutcomes = (
  values: unknown[],
  outcomes: readonly Exit<unknown, unknown>[],
  validate: boolean,
): Exit<unknown, unknown> => {
  let combined: Exit<unknown, unknown> = success(values)
  for (const exit of outcomes)
    combined = combineExits(combined, collectionFailure(exit, validate), 'Parallel')
  return combined
}

export const finishRace = async (
  winner: Exit<unknown, unknown>,
  winnerIndex: number,
  children: readonly SupervisedFiber[],
): Promise<Exit<unknown, unknown>> => {
  for (const [index, child] of children.entries()) {
    if (index !== winnerIndex) child.interrupt('ResultTask race lost')
  }
  await Promise.all(children.map((child) => child.outcome))
  let result = winner
  for (const [index, child] of children.entries()) {
    if (index !== winnerIndex) result = combineExits(result, child.cleanup(), 'Sequential')
  }
  return result
}

export const throwDefect = (defect: unknown): never => {
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw defect
}

export const isObjectLike = (value: unknown): value is Record<PropertyKey, unknown> =>
  (typeof value === 'object' || typeof value === 'function') && value !== null

export const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const hasCleanupCause = (cause: Cause<unknown>): boolean =>
  transformCause(cause, (leaf) => (isCleanupCause(leaf) ? leaf : undefined), isCleanupCause) !==
  undefined

export const isExternalInterruptOnly = (cause: Cause<unknown>, signal: AbortSignal): boolean =>
  signal.aborted && withoutInterruptions(cause) === undefined

export const validateZipOptions = (options: unknown): ResultTaskZipOptions | undefined => {
  if (options === undefined) return undefined
  if (!isPlainRecord(options)) {
    throw new TypeError('ResultTask.zip options must be an object')
  }
  const concurrent = (options as { readonly concurrent?: unknown }).concurrent
  if (concurrent !== undefined && typeof concurrent !== 'boolean') {
    throw new TypeError('ResultTask.zip concurrent must be a boolean when provided')
  }
  return options as ResultTaskZipOptions
}
