/**
 * Attempt metadata passed to retry predicates (`while`), dynamic delay callbacks (`delayMs`),
 * and retry observers (`onRetry`).
 */
export interface RetryContext {
  /** Zero-based index of the attempt that just failed (`0` on the initial failure). */
  readonly attempt: number
  /** One-based index of the retry attempt about to be scheduled (`attempt + 1`). */
  readonly nextAttempt: number
  /** Number of retries remaining after the current failure, before scheduling `nextAttempt`. */
  readonly retriesRemaining: number
}

/**
 * Configuration for creating a portable {@link RetryPolicy} shared by both eager `ResultAsync.retry`
 * and lazy `ResultTask.retry`.
 */
export interface RetryPolicyOptions<E = unknown> {
  /** Maximum number of retry attempts after the initial execution (`0` means no retries). */
  readonly times: number
  /** Base delay in milliseconds (or a function of `(context, error)`) before backoff, jitter, and capping. */
  readonly delayMs?: number | ((context: RetryContext, error: E) => number)
  /** Exponential multiplier (`>= 1`) applied per retry (`base * backoff ** attempt`). */
  readonly backoff?: number
  /** Upper bound in milliseconds on the computed delay after backoff and jitter. */
  readonly maxDelayMs?: number
  /** Total elapsed time budget in milliseconds across retries; stops retrying once exhausted. */
  readonly maxElapsedMs?: number
  /** Symmetric jitter factor (`>= 0`). A factor of `0.5` varies delay within `[0.5 * d, 1.5 * d]`. */
  readonly jittered?: number
  /** Predicate evaluated when retry budget remains; returning `false` stops retrying immediately. */
  readonly while?: (error: E, context: RetryContext) => boolean | Promise<boolean>
  /** Observer awaited before sleeping for the next retry; thrown errors are swallowed. */
  readonly onRetry?: (error: E, context: RetryContext) => void | Promise<void>
}

const RetryPolicyTypeId: unique symbol = Symbol.for('resultar/RetryPolicy')

/**
 * Immutable, branded retry policy created by {@link Retry.policy}.
 * Policies hold pure configuration and can be safely reused across concurrent runs.
 */
export interface RetryPolicy<E = unknown> extends RetryPolicyOptions<E> {
  readonly [RetryPolicyTypeId]: typeof RetryPolicyTypeId
}

const checkedRetryDelay = (delayMs: number): number => {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError('Retry delayMs must be a finite non-negative number')
  }
  return delayMs
}

/** Internal shared validation; branded policy spreads are checked at the execution boundary too. */
export const validateRetryPolicy = <E>(options: RetryPolicyOptions<E>): void => {
  if (!Number.isSafeInteger(options.times) || options.times < 0) {
    throw new RangeError('Retry times must be a non-negative safe integer')
  }
  if (typeof options.delayMs === 'number') checkedRetryDelay(options.delayMs)
  if (options.backoff !== undefined && (!Number.isFinite(options.backoff) || options.backoff < 1)) {
    throw new RangeError('Retry backoff must be a finite number at least one')
  }
  if (
    options.maxDelayMs !== undefined &&
    (!Number.isFinite(options.maxDelayMs) || options.maxDelayMs < 0)
  ) {
    throw new RangeError('Retry maxDelayMs must be a finite non-negative number')
  }
  if (
    options.maxElapsedMs !== undefined &&
    (!Number.isFinite(options.maxElapsedMs) || options.maxElapsedMs < 0)
  ) {
    throw new RangeError('Retry maxElapsedMs must be a finite non-negative number')
  }
  if (
    options.jittered !== undefined &&
    (!Number.isFinite(options.jittered) || options.jittered < 0)
  ) {
    throw new RangeError('Retry jittered must be a finite non-negative number')
  }
}

/**
 * Namespace for constructing portable, reusable {@link RetryPolicy} instances.
 *
 * @example
 * ```ts
 * import { Retry, ResultTask } from 'resultar'
 *
 * const transientPolicy = Retry.policy<{ readonly retryable: boolean }>({
 *   times: 3,
 *   delayMs: 100,
 *   backoff: 2,
 *   jittered: 0.2,
 *   while: (err) => err.retryable,
 * })
 *
 * const task = ResultTask.try({
 *   try: () => ({ status: 200 }),
 *   catch: () => ({ retryable: true }),
 * }).retry(transientPolicy)
 * ```
 */
export const Retry: {
  /**
   * Validates and freezes a portable {@link RetryPolicy} that can be passed to `ResultTask.retry`,
   * `ResultAsync.retry`, and `ResultAsync.retryOrElse`.
   */
  readonly policy: <E = unknown>(options: RetryPolicyOptions<E>) => RetryPolicy<E>
} = Object.freeze({
  policy: <E = unknown>(options: RetryPolicyOptions<E>): RetryPolicy<E> => {
    validateRetryPolicy(options)
    const brand = { [RetryPolicyTypeId]: RetryPolicyTypeId as typeof RetryPolicyTypeId }
    return Object.freeze(Object.assign(brand, options))
  },
})

/** Internal runtime dispatch for shared policies, without inspecting callback arity. */
export const isRetryPolicy = <E>(value: unknown): value is RetryPolicy<E> =>
  typeof value === 'object' &&
  value !== null &&
  (value as Partial<RetryPolicy<E>>)[RetryPolicyTypeId] === RetryPolicyTypeId

/** Internal context construction shared by both execution models. */
export const retryContext = (attempt: number, times: number): RetryContext => ({
  attempt,
  nextAttempt: attempt + 1,
  retriesRemaining: Math.max(0, times - attempt),
})

/** Internal common delay calculation; randomness is supplied by the operation's runtime. */
export const retryPolicyDelay = <E>(
  policy: RetryPolicy<E>,
  context: RetryContext,
  runtime: { readonly random: () => number; readonly error?: E },
): number => {
  const base = checkedRetryDelay(
    typeof policy.delayMs === 'function'
      ? policy.delayMs(context, runtime.error as E)
      : (policy.delayMs ?? 0),
  )
  let delay = checkedRetryDelay(base === 0 ? 0 : base * (policy.backoff ?? 1) ** context.attempt)
  if (policy.maxDelayMs !== undefined && delay > policy.maxDelayMs) {
    delay = policy.maxDelayMs
  }
  const jittered = policy.jittered ?? 0
  if (jittered === 0 || delay === 0) return delay
  const value = runtime.random()
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError('Retry random must return a finite number between zero and one')
  }
  const minimum = Math.max(0, delay - delay * jittered)
  const maximum = delay + delay * jittered
  const computed = checkedRetryDelay(minimum + (maximum - minimum) * value)
  return policy.maxDelayMs !== undefined && computed > policy.maxDelayMs
    ? policy.maxDelayMs
    : computed
}

/** Returns `true` when elapsed retry time plus `nextDelayMs` exceeds `maxElapsedMs`. */
export const isRetryElapsedExceeded = (
  maxElapsedMs: number | undefined,
  timing: { readonly startedAt: number; readonly now: number; readonly nextDelayMs: number },
): boolean => {
  if (maxElapsedMs === undefined) return false
  const elapsed = Math.max(0, timing.now - timing.startedAt)
  return elapsed >= maxElapsedMs || elapsed + timing.nextDelayMs > maxElapsedMs
}

/** Internal best-effort hook shared by eager and lazy retry loops. */
export const observeRetry = async <E>(
  policy: Pick<RetryPolicyOptions<E>, 'onRetry'>,
  error: E,
  context: RetryContext,
): Promise<void> => {
  try {
    await policy.onRetry?.(error, context)
  } catch {
    // Observation cannot change the retry outcome.
  }
}
