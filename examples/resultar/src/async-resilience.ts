import {
  AbortError,
  ResultAsync,
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

export const loadUserWithTimeout = (id: string, delayMs: number) =>
  ResultAsync.timeout((signal) => fetchRemoteUser(id, delayMs, signal), {
    onTimeout: () => new UserTimeoutError({ id }),
    timeoutMs: 5,
  });

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

export const fastestPrice = (sku: string) => {
  void sku;

  return ResultAsync.raceAll([
    priceFrom("us-east", 1_900, 10, true),
    priceFrom("eu-west", 2_100, 3),
    priceFrom("sa-east", 2_000, 8),
  ] as const);
};

export const fastestRegionalPrice = (sku: string) => {
  void sku;

  return ResultAsync.race(priceFrom("primary", 2_400, 8), priceFrom("replica", 2_300, 2));
};

export const firstCompletedPrice = (sku: string) => {
  void sku;

  return ResultAsync.raceFirst(
    priceFrom("failed-fast", 0, 1, true),
    priceFrom("slow-success", 2_300, 8),
  );
};

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

export const abortDetectionExamples = () => ({
  code: isAbortError({ code: "ABORT_ERR" }),
  instance: isAbortError(new AbortError("cancelled")),
  name: isAbortError({ name: "AbortError" }),
});
