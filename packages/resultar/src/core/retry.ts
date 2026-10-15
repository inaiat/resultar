/** Metadata shared by canonical retry predicates, delays, and observers. */
export interface RetryContext {
  /** Current attempt number, starting at zero. */
  readonly attempt: number
  /** Next attempt number when another retry is scheduled. */
  readonly nextAttempt: number
  /** Retries available after the current failure, before scheduling the next attempt. */
  readonly retriesRemaining: number
}

/** A portable retry policy for both eager ResultAsync and lazy ResultTask operations. */
export interface RetryPolicyOptions<E = unknown> {
  /** Number of retries after the initial attempt. */
  readonly times: number
  /** Delay in milliseconds, before applying backoff and jitter. */
  readonly delayMs?: number | ((context: RetryContext) => number)
  /** Exponential multiplier, at least one, applied once per completed retry. */
  readonly backoff?: number
  /** Symmetric jitter factor. A factor of 0.5 varies delay by up to 50% in either direction. */
  readonly jittered?: number
  /** Evaluated only for failures with retry budget remaining. */
  readonly while?: (error: E, context: RetryContext) => boolean | Promise<boolean>
  /** Awaited before the retry delay; observer failures do not change the operation outcome. */
  readonly onRetry?: (error: E, context: RetryContext) => void | Promise<void>
}

const RetryPolicyTypeId: unique symbol = Symbol.for('resultar/RetryPolicy')

/** Branded policy created by Retry.policy; legacy callback signatures remain unambiguous. */
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
    options.jittered !== undefined &&
    (!Number.isFinite(options.jittered) || options.jittered < 0)
  ) {
    throw new RangeError('Retry jittered must be a finite non-negative number')
  }
}

/** Canonical retry construction; policies hold configuration and never retain attempt state. */
export const Retry: {
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
  random: () => number,
): number => {
  const base = checkedRetryDelay(
    typeof policy.delayMs === 'function' ? policy.delayMs(context) : (policy.delayMs ?? 0),
  )
  const delay = checkedRetryDelay(base === 0 ? 0 : base * (policy.backoff ?? 1) ** context.attempt)
  const jittered = policy.jittered ?? 0
  if (jittered === 0 || delay === 0) return delay
  const value = random()
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError('Retry random must return a finite number between zero and one')
  }
  const minimum = Math.max(0, delay - delay * jittered)
  const maximum = delay + delay * jittered
  return checkedRetryDelay(minimum + (maximum - minimum) * value)
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
