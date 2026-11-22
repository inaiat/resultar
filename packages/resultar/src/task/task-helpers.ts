import {
  isRetryElapsedExceeded,
  observeRetry,
  retryContext,
  retryPolicyDelay,
  validateRetryPolicy,
} from '../core/retry.js'
import type { RetryContext, RetryPolicy } from '../core/retry.js'
import { Cause } from './cause.js'
import { transformCause, withoutInterruptions } from './cause-transform.js'
import { isCleanupCause } from './cleanup-cause.js'
import { combineExits, died, failure, success } from './exit.js'
import type { SupervisedFiber } from './fiber-runtime.js'
import { detachedPromise, NEVER_ABORTED_SIGNAL } from './promise-interruption.js'
import type { Exit, ResultTask } from './result-task.js'
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

/** Rejection used when a simplified boundary cannot represent multiple failures. */
export class ResultTaskCauseError extends Error {
  public override readonly cause!: Cause<unknown>

  public constructor(cause: Cause<unknown>) {
    super(`ResultTask execution failed with multiple causes:\n${Cause.pretty(cause)}`)
    this.name = 'ResultTaskCauseError'
    Object.defineProperty(this, 'cause', {
      configurable: true,
      enumerable: false,
      value: cause,
      writable: true,
    })
  }

  /** Human-readable formatted breakdown of every leaf and span trace in {@link cause}. */
  public get prettyCause(): string {
    return Cause.pretty(this.cause)
  }

  static {
    Object.defineProperty(
      ResultTaskCauseError.prototype,
      Symbol.for('nodejs.util.inspect.custom'),
      {
        configurable: true,
        enumerable: false,
        value(this: ResultTaskCauseError): string {
          return `${this.name}: ${this.message}`
        },
        writable: true,
      },
    )
  }
}

/** Handlers for matching both success and failure cases of a ResultTask. */
export type ResultTaskMatchOptions<A, E, B, C = B> = {
  readonly ok: (value: A) => B
  readonly err: (error: E) => C
}

export const taskSuccessHandler = <A, E, B, C>(
  handlers: ResultTaskMatchOptions<A, E, B, C>,
): ((value: A) => B) => handlers.ok

export const taskFailureHandler = <A, E, B, C>(
  handlers: ResultTaskMatchOptions<A, E, B, C>,
): ((error: E) => C) => handlers.err

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

interface CanonicalRetryRuntime {
  readonly policy: RetryPolicy<unknown>
  readonly clock: TaskClock
  readonly signal: AbortSignal
  readonly startedAt: number
}

type RetryPlan = Exit<number | undefined, never>

const ZERO_RETRY_PLAN: RetryPlan = success(0)

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

const canonicalRetryDelayAsync = async (
  error: unknown,
  context: RetryContext,
  runtime: CanonicalRetryRuntime,
): Promise<RetryPlan> => {
  const { policy, clock, signal, startedAt } = runtime
  const decision = await canonicalRetryDecision(policy, error, { context, signal })
  if (decision._tag === 'Failure') return decision
  if (!decision.value) return success(undefined)
  if (
    isRetryElapsedExceeded(policy.maxElapsedMs, { startedAt, now: clock.now(), nextDelayMs: 0 })
  ) {
    return success(undefined)
  }
  const observation = await detachedPromise(
    signal,
    () => observeRetry(policy, error, context),
    throwDefect,
  )
  if (observation._tag === 'Failure') return observation
  const delay = retryPolicyDelay(policy, context, { random: () => clock.random(), error })
  if (
    isRetryElapsedExceeded(policy.maxElapsedMs, { startedAt, now: clock.now(), nextDelayMs: delay })
  ) {
    return success(undefined)
  }
  return success(delay)
}

export const canonicalRetryDelay = (
  retryError: unknown,
  attempt: number,
  runtime: CanonicalRetryRuntime,
): RetryPlan | Promise<RetryPlan> => {
  const { policy, signal } = runtime
  /* Stryker disable all: uninterruptible zero-delay fast-path is equivalent to canonicalRetryDelayAsync. */
  if (
    signal === NEVER_ABORTED_SIGNAL &&
    policy.while === undefined &&
    policy.maxElapsedMs === undefined &&
    (policy.delayMs === undefined || policy.delayMs === 0)
  ) {
    if (policy.onRetry === undefined) return ZERO_RETRY_PLAN
    const context = retryContext(attempt, policy.times)
    try {
      const observation = policy.onRetry(retryError, context)
      if (observation === undefined) return ZERO_RETRY_PLAN
      return observation.then(
        () => ZERO_RETRY_PLAN,
        () => ZERO_RETRY_PLAN,
      )
    } catch {
      return ZERO_RETRY_PLAN
    }
  }
  /* Stryker restore all */
  return canonicalRetryDelayAsync(retryError, retryContext(attempt, policy.times), runtime)
}

export const validateTaskRetry = (policy: RetryPolicy<unknown>): void => {
  validateRetryPolicy(policy)
}

/** Configuration for repeating a succeeding `ResultTask` (`task.repeat(...)` / `ResultTask.repeat(...)`). */
export interface ResultTaskRepeatOptions<A = unknown> {
  /** Maximum number of additional repetitions after the initial execution (`0` means run once). */
  readonly times: number
  /** Base delay in milliseconds (or a function of `(context, value)`) before backoff, jitter, and capping. */
  readonly delayMs?: number | ((context: RetryContext, value: A) => number)
  /** Exponential multiplier (`>= 1`) applied per repetition (`base * backoff ** attempt`). */
  readonly backoff?: number
  /** Upper bound in milliseconds on the computed delay after backoff and jitter. */
  readonly maxDelayMs?: number
  /** Total elapsed time budget in milliseconds across repetitions; stops repeating once exhausted. */
  readonly maxElapsedMs?: number
  /** Symmetric jitter factor (`>= 0`). A factor of `0.5` varies delay within `[0.5 * d, 1.5 * d]`. */
  readonly jittered?: number
  /** Continues repeating while returning `true`. Returning `false` stops with the latest `Success`. */
  readonly while?: (value: A, context: RetryContext) => boolean | Promise<boolean>
  /** Stops repeating with the latest `Success` once returning `true`. */
  readonly until?: (value: A, context: RetryContext) => boolean | Promise<boolean>
  /** Observer awaited before sleeping for the next repetition; thrown errors are swallowed. */
  readonly onRepeat?: (value: A, context: RetryContext) => void | Promise<void>
}

export type ResultTaskRepeatInput<A = unknown> = ResultTaskRepeatOptions<A> | RetryPolicy<A>

export const validateTaskRepeat = <A>(options: ResultTaskRepeatInput<A>): void => {
  validateRetryPolicy(options)
}

export const repeatDelayPlan = async <A>(
  value: A,
  attempt: number,
  runtime: {
    readonly options: ResultTaskRepeatInput<A>
    readonly clock: TaskClock
    readonly signal: AbortSignal
    readonly startedAt: number
  },
): Promise<RetryPlan> => {
  const { options, clock, signal, startedAt } = runtime
  const context = retryContext(attempt, options.times)
  const whilePredicate = options.while
  if (whilePredicate !== undefined) {
    const keepGoing = await detachedPromise(
      signal,
      () => Promise.resolve(whilePredicate(value, context)),
      throwDefect,
    )
    if (keepGoing._tag === 'Failure') return keepGoing
    if (!keepGoing.value) return success(undefined)
  }
  const untilPredicate = 'until' in options ? options.until : undefined
  if (untilPredicate !== undefined) {
    const done = await detachedPromise(
      signal,
      () => Promise.resolve(untilPredicate(value, context)),
      throwDefect,
    )
    if (done._tag === 'Failure') return done
    if (done.value) return success(undefined)
  }
  if (
    isRetryElapsedExceeded(options.maxElapsedMs, { startedAt, now: clock.now(), nextDelayMs: 0 })
  ) {
    return success(undefined)
  }
  const observer =
    'onRepeat' in options
      ? options.onRepeat
      : (options as { readonly onRetry?: RetryPolicy<A>['onRetry'] }).onRetry
  // Stryker disable next-line ConditionalExpression: skip detachedPromise allocation when no repeat observer is configured.
  if (observer !== undefined) {
    const observed = await detachedPromise(
      signal,
      () => observeRetry({ onRetry: observer }, value, context),
      throwDefect,
    )
    if (observed._tag === 'Failure') return observed
  }
  const delay = retryPolicyDelay(options as RetryPolicy<A>, context, {
    random: () => clock.random(),
    error: value,
  })
  if (
    isRetryElapsedExceeded(options.maxElapsedMs, {
      startedAt,
      now: clock.now(),
      nextDelayMs: delay,
    })
  ) {
    return success(undefined)
  }
  return success(delay)
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

/** Type identifier symbol for nominal `ResultTask` branding and variance checks. */
export const ResultTaskTypeId: unique symbol = Symbol.for('resultar/ResultTask')

/** Returns true if a value is a `ResultTask` instance. */
export const isResultTask = (value: unknown): value is ResultTask<unknown, unknown, unknown> =>
  isObjectLike(value) && (value as Record<symbol, unknown>)[ResultTaskTypeId] !== undefined

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
