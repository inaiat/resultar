/**
 * Async Resilience (`ResultAsync.timeout`, `retry`, `retryOrElse`, `race`, `raceAll`, `raceFirst`, `raceWith`)
 *
 * This module demonstrates cooperative cancellation via `AbortSignal`, timeouts,
 * retry loops (both inline options and portable `Retry.policy` schedules), and
 * racing concurrent `ResultAsync` tasks.
 */
import {
  AbortError,
  ResultAsync,
  Retry,
  createTaggedError,
  errAsync,
  fromPromise,
  isAbortError,
  okAsync,
  type ResultAsyncAbortSignal,
  type ResultAsyncRaceTask,
} from "resultar";

export interface RemoteUser {
  readonly id: string;
  readonly name: string;
}

export interface CatalogItem {
  readonly sku: string;
  readonly source: "cache" | "primary";
}

export interface PriceQuote {
  readonly cents: number;
  readonly region: string;
}

export class RemoteUserError extends createTaggedError({
  name: "RemoteUserError",
  message: "Could not load user $id",
}) {}

export class UserTimeoutError extends createTaggedError({
  name: "UserTimeoutError",
  message: "Timed out while loading user $id",
}) {}

export class CatalogUnavailableError extends createTaggedError({
  name: "CatalogUnavailableError",
  message: "Catalog is unavailable for $sku",
}) {}

export class PriceProviderError extends createTaggedError({
  name: "PriceProviderError",
  message: "Price provider $region failed",
}) {}

/**
 * Helper that simulates an asynchronous call honoring a `ResultAsyncAbortSignal`.
 * When `signal` aborts (e.g., on timeout or race loss), the timer is cleared immediately.
 */
const delay = <T>(
  value: T,
  delayMs: number,
  signal: ResultAsyncAbortSignal,
  shouldReject = false,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (shouldReject) {
        reject(new Error("remote failure"));
        return;
      }

      resolve(value);
    }, delayMs);

    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });

const fetchRemoteUser = (
  id: string,
  delayMs: number,
  signal: ResultAsyncAbortSignal,
): ResultAsync<RemoteUser, RemoteUserError> =>
  fromPromise(
    delay({ id, name: "Ada Lovelace" }, delayMs, signal),
    (cause) => new RemoteUserError({ cause, id }),
  );

/**
 * `ResultAsync.timeout(task, { timeoutMs, onTimeout })` passes a cancellation
 * `signal` to `task` and aborts it if `timeoutMs` elapses first.
 */
export const loadUserWithTimeout = (id: string, delayMs: number) =>
  ResultAsync.timeout((signal) => fetchRemoteUser(id, delayMs, signal), {
    onTimeout: () => new UserTimeoutError({ id }),
    timeoutMs: 5,
  });

/**
 * `ResultAsync.retryOrElse(task, { times, delayMs, orElse })` retries `task` up to
 * `times` additional attempts and falls back to `orElse(lastError)` when all attempts fail.
 */
export const loadCatalogWithFallback = (sku: string) => {
  let attempts = 0;
  const task = (): ResultAsync<CatalogItem, CatalogUnavailableError> => {
    attempts += 1;

    return attempts < 3
      ? errAsync(new CatalogUnavailableError({ sku }))
      : okAsync({ sku, source: "primary" });
  };

  return ResultAsync.retryOrElse(task, {
    delayMs: 0,
    orElse: () => okAsync({ sku, source: "cache" as const }),
    times: 1,
  });
};

/**
 * `ResultAsync.retry(task, options)` retries `task` while the `while` predicate
 * returns `true` for the error and `times` retries remain.
 */
export const loadCatalogAfterRetry = (sku: string) => {
  let attempts = 0;
  const task = (): ResultAsync<CatalogItem, CatalogUnavailableError> => {
    attempts += 1;

    return attempts < 2
      ? errAsync(new CatalogUnavailableError({ sku }))
      : okAsync({ sku, source: "primary" });
  };

  return ResultAsync.retry(task, {
    delayMs: 0,
    times: 2,
    while: (error) => error._tag === "CatalogUnavailableError",
  });
};

/**
 * `Retry.policy` defines a portable retry schedule (shared between `ResultAsync`
 * and `ResultTask`) with exponential backoff, jitter, and an `onRetry` hook.
 */
export const loadCatalogWithRetryPolicy = async (sku: string) => {
  const retryLog: string[] = [];
  let attempts = 0;

  const catalogRetryPolicy = Retry.policy<CatalogUnavailableError>({
    backoff: 2,
    delayMs: 0,
    times: 2,
    while: (error) => CatalogUnavailableError.is(error),
  });

  const result = await ResultAsync.retry(
    () => {
      attempts += 1;
      return attempts < 3
        ? errAsync(new CatalogUnavailableError({ sku }))
        : okAsync({ sku, source: "primary" as const });
    },
    {
      ...catalogRetryPolicy,
      onRetry: (error, { attempt }) => {
        retryLog.push(`retry:${attempt}:${error._tag}`);
      },
    },
  );

  return {
    attempts,
    result,
    retryLog,
  };
};

const priceFrom =
  (
    region: string,
    cents: number,
    delayMs: number,
    shouldReject = false,
  ): ResultAsyncRaceTask<PriceQuote, PriceProviderError> =>
  (signal) =>
    fromPromise(
      delay({ cents, region }, delayMs, signal, shouldReject),
      (cause) => new PriceProviderError({ cause, region }),
    );

/**
 * `ResultAsync.raceAll(tasks)` runs all tasks concurrently, resolves with the
 * first `Ok` winner (ignoring faster `Err` completions while peers are still running),
 * and aborts the remaining losers.
 */
export const fastestPrice = (sku: string) => {
  void sku;

  return ResultAsync.raceAll([
    priceFrom("us-east", 1_900, 10, true),
    priceFrom("eu-west", 2_100, 3),
    priceFrom("sa-east", 2_000, 8),
  ] as const);
};

/**
 * `ResultAsync.race(left, right)` races two tasks for the first `Ok` result
 * and cancels the loser.
 */
export const fastestRegionalPrice = (sku: string) => {
  void sku;

  return ResultAsync.race(priceFrom("primary", 2_400, 8), priceFrom("replica", 2_300, 2));
};

/**
 * `ResultAsync.raceFirst(left, right)` settles as soon as either task completes,
 * even if that first completion is an `Err`.
 */
export const firstCompletedPrice = (sku: string) => {
  void sku;

  return ResultAsync.raceFirst(
    priceFrom("failed-fast", 0, 1, true),
    priceFrom("slow-success", 2_300, 8),
  );
};

/**
 * `ResultAsync.raceWith(left, right, { onLeftDone, onRightDone })` gives custom
 * control over whether to abort or await the peer handle when the first branch finishes.
 */
export const fallbackPriceWithCustomRace = (sku: string) => {
  void sku;

  return ResultAsync.raceWith(
    priceFrom("primary", 1_900, 1, true),
    priceFrom("fallback", 2_200, 5),
    {
      onLeftDone: (leftResult, fallbackHandle) => {
        if (leftResult.isOk()) {
          fallbackHandle.abort();
          return leftResult;
        }

        return fallbackHandle.wait();
      },
      onRightDone: (rightResult, primaryHandle) => {
        primaryHandle.abort();
        return rightResult;
      },
    },
  );
};

/**
 * `isAbortError(value)` detects `AbortError` instances as well as standard DOM/Node
 * abort errors (`name === "AbortError"` or `code === "ABORT_ERR"`).
 */
export const abortDetectionExamples = () => ({
  code: isAbortError({ code: "ABORT_ERR" }),
  instance: isAbortError(new AbortError("cancelled")),
  name: isAbortError({ name: "AbortError" }),
});
