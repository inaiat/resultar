/**
 * Task Resilience (`ResultTask.timeout`, `retry`, `orElse`, `race`, `raceFirst`, fibers)
 *
 * This module demonstrates cooperative cancellation via `AbortSignal`, timeouts,
 * retry loops with portable `Retry.policy` schedules, and
 * racing concurrent, lazy `ResultTask` programs. Execute them with an explicit runner.
 */
import {
  AbortError,
  Fiber,
  ResultTask,
  Retry,
  createTaggedError,
  err,
  isAbortError,
  ok,
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
 * Simulates a Promise API honoring `AbortSignal`. Timeout and race interruption
 * clear its timer; every completion also removes the abort listener.
 */
const delay = <T>(
  value: T,
  delayMs: number,
  signal: AbortSignal,
  shouldReject = false,
): Promise<T> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortError("cancelled"));
      return;
    }

    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(new AbortError("cancelled"));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      if (shouldReject) {
        reject(new Error("remote failure"));
        return;
      }

      resolve(value);
    }, delayMs);

    signal.addEventListener("abort", onAbort, { once: true });
  });

const fetchRemoteUser = (id: string, delayMs: number): ResultTask<RemoteUser, RemoteUserError> =>
  ResultTask.tryPromise({
    try: (signal) => delay({ id, name: "Ada Lovelace" }, delayMs, signal),
    catch: (cause) => new RemoteUserError({ cause, id }),
  });

/**
 * `.timeout(milliseconds, onTimeout)` interrupts the Promise through its
 * supplied signal and waits for cancellation before returning the typed timeout.
 */
export const loadUserWithTimeout = (id: string, delayMs: number) =>
  fetchRemoteUser(id, delayMs).timeout(5, () => new UserTimeoutError({ id }));

/**
 * `.retry(policy).orElseSucceed(recover)` retries before using a cached fallback.
 * The generator creates a fresh counter for every execution of this program.
 */
export const loadCatalogWithFallback = (sku: string): ResultTask<CatalogItem> =>
  ResultTask.gen(function* () {
    let attempts = 0;
    const task = ResultTask.sync(() => ++attempts).andThen((attempt) =>
      attempt < 3
        ? ResultTask.err(new CatalogUnavailableError({ sku }))
        : ResultTask.ok({ sku, source: "primary" as const }),
    );

    return yield* task
      .retry(Retry.policy({ delayMs: 0, times: 1 }))
      .orElseSucceed(() => ({ sku, source: "cache" as const }));
  });

/**
 * `.retry(Retry.policy(...))` retries while the predicate accepts the error
 * and additional attempts remain. The counter belongs to this execution.
 */
export const loadCatalogAfterRetry = (
  sku: string,
): ResultTask<CatalogItem, CatalogUnavailableError> =>
  ResultTask.gen(function* () {
    let attempts = 0;
    const task = ResultTask.sync(() => ++attempts).andThen((attempt) =>
      attempt < 2
        ? ResultTask.err(new CatalogUnavailableError({ sku }))
        : ResultTask.ok({ sku, source: "primary" as const }),
    );

    return yield* task.retry(
      Retry.policy<CatalogUnavailableError>({
        delayMs: 0,
        times: 2,
        while: (error) => CatalogUnavailableError.is(error),
      }),
    );
  });

/**
 * `Retry.policy` defines a retry schedule with backoff and an `onRetry` hook.
 * `.match` captures the final Result for a report; run this task with `runPromise`.
 */
export const loadCatalogWithRetryPolicy = (sku: string) =>
  ResultTask.gen(function* () {
    const retryLog: string[] = [];
    let attempts = 0;

    const catalogRetryPolicy = Retry.policy<CatalogUnavailableError>({
      backoff: 2,
      delayMs: 0,
      times: 2,
      while: (error) => CatalogUnavailableError.is(error),
      onRetry: (error, { attempt }) => {
        retryLog.push(`retry:${attempt}:${error._tag}`);
      },
    });

    const task = ResultTask.sync(() => ++attempts).andThen((attempt) =>
      attempt < 3
        ? ResultTask.err(new CatalogUnavailableError({ sku }))
        : ResultTask.ok({ sku, source: "primary" as const }),
    );
    const result = yield* task.retry(catalogRetryPolicy).match({
      ok: (value) => ok(value),
      err: (error) => err(error),
    });

    return { attempts, result, retryLog };
  });

const priceFrom = (
  region: string,
  cents: number,
  delayMs: number,
  shouldReject = false,
): ResultTask<PriceQuote, PriceProviderError> =>
  ResultTask.tryPromise({
    try: (signal) => delay({ cents, region }, delayMs, signal, shouldReject),
    catch: (cause) => new PriceProviderError({ cause, region }),
  });

/**
 * Compose `ResultTask.race` to race several providers for their first success.
 * Faster typed failures do not win; interruption waits for loser cleanup.
 * If every provider fails, `runExit` preserves the combined failure causes.
 */
export const fastestPrice = (sku: string) => {
  void sku;

  return ResultTask.race(
    priceFrom("us-east", 1_900, 10, true),
    ResultTask.race(priceFrom("eu-west", 2_100, 3), priceFrom("sa-east", 2_000, 8)),
  );
};

/**
 * `ResultTask.race(left, right)` races for the first success and interrupts the loser.
 */
export const fastestRegionalPrice = (sku: string) => {
  void sku;

  return ResultTask.race(priceFrom("primary", 2_400, 8), priceFrom("replica", 2_300, 2));
};

/**
 * `ResultTask.raceFirst(left, right)` returns the first outcome after loser cleanup,
 * even if the first outcome is a typed failure.
 */
export const firstCompletedPrice = (sku: string) => {
  void sku;

  return ResultTask.raceFirst(
    priceFrom("failed-fast", 0, 1, true),
    priceFrom("slow-success", 2_300, 8),
  );
};

/**
 * Child fibers implement a custom policy: a primary failure waits for fallback,
 * while a primary success or any fallback outcome interrupts the other provider.
 * Detaching the losing race waiter keeps the provider alive until this policy decides.
 */
export const fallbackPriceWithCustomRace = (sku: string) => {
  void sku;

  return ResultTask.scoped(
    ResultTask.gen(function* () {
      const primary = yield* ResultTask.forkChild(priceFrom("primary", 1_900, 1, true));
      const fallback = yield* ResultTask.forkChild(priceFrom("fallback", 2_200, 5));
      const primaryOutcome = Fiber.join(primary, { interruption: "detach" })
        .match({ ok: (value) => ok(value), err: (error) => err(error) })
        .map((result) => ({ branch: "primary" as const, result }));
      const fallbackOutcome = Fiber.join(fallback, { interruption: "detach" })
        .match({ ok: (value) => ok(value), err: (error) => err(error) })
        .map((result) => ({ branch: "fallback" as const, result }));
      const completed = yield* ResultTask.raceFirst(primaryOutcome, fallbackOutcome);

      if (completed.branch === "primary" && completed.result.isErr()) {
        return yield* Fiber.join(fallback);
      }

      yield* Fiber.interrupt(completed.branch === "primary" ? fallback : primary);
      return yield* completed.result;
    }),
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
