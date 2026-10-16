/**
 * Edge Wrapping & Boundary Unwrapping (`tryResult`, `fromThrowable`, `fromCallback`, `runSync`, `runPromise`)
 *
 * This module demonstrates how to convert exception-throwing synchronous/async
 * functions and callback-based APIs into typed `Result` / `ResultAsync` values
 * at system boundaries, and how to unwrap or match them when crossing back out.
 */
import {
  type AbortError,
  createTaggedError,
  fromCallback,
  fromSafePromise,
  fromThrowable,
  fromThrowableAsync,
  isError,
  matchError,
  matchErrorPartial,
  ok,
  runPromise,
  runSync,
  tryResult,
  tryResultAsync,
  type ResultAsyncAbortSignal,
  type StrictResult,
  type StrictResultAsync,
} from "resultar";

export interface AppConfig {
  readonly mode: "dev" | "prod";
  readonly port: number;
}

export class ParseConfigError extends createTaggedError({
  name: "ParseConfigError",
  message: "Could not parse config JSON",
}) {}

export class ConfigShapeError extends createTaggedError({
  name: "ConfigShapeError",
  message: "Config JSON has the wrong shape",
}) {}

export class ReadConfigError extends createTaggedError({
  name: "ReadConfigError",
  message: "Could not read config from $source",
}) {}

export class ConfigEventError extends createTaggedError({
  name: "ConfigEventError",
  message: "Config event stream failed: $reason",
}) {}

export type ConfigError = ConfigShapeError | ParseConfigError | ReadConfigError;

const isAppConfig = (input: unknown): input is AppConfig => {
  if (typeof input !== "object" || input === null) {
    return false;
  }

  const value = input as { readonly mode?: unknown; readonly port?: unknown };

  return (
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    (value.mode === "dev" || value.mode === "prod")
  );
};

const decodeConfig = (input: unknown): StrictResult<AppConfig, ConfigShapeError> =>
  isAppConfig(input) ? ok(input) : ConfigShapeError.err();

/**
 * Wraps a single throwing call (`JSON.parse`) with `tryResult` and maps any
 * thrown value into a typed `ParseConfigError` (preserving `cause`).
 */
export const parseConfig = (
  raw: string,
): StrictResult<AppConfig, ConfigShapeError | ParseConfigError> =>
  tryResult(
    () => JSON.parse(raw) as unknown,
    (cause) => new ParseConfigError({ cause }),
  ).andThen(decodeConfig);

/**
 * `fromThrowable` wraps an existing synchronous throwing function into a
 * reusable function that returns `StrictResult` instead of throwing.
 */
const parseJson = fromThrowable(
  (raw: string) => JSON.parse(raw) as unknown,
  (cause) => new ParseConfigError({ cause }),
);

export const parseConfigWithReusableWrapper = (
  raw: string,
): StrictResult<AppConfig, ConfigShapeError | ParseConfigError> =>
  parseJson(raw).andThen(decodeConfig);

const readConfigText = async (source: string): Promise<string> => {
  if (source === "missing") {
    // resultar-check-disable-next-line no-throw
    throw new ReadConfigError({ source });
  }

  if (source === "bad-json") {
    return "{";
  }

  return '{"port":8080,"mode":"prod"}';
};

/**
 * `tryResultAsync` wraps a Promise-returning operation (with optional `AbortSignal`
 * support) and maps rejections or synchronous throws into a typed error.
 */
export const loadConfig = (source: string): StrictResultAsync<AppConfig, ConfigError> =>
  tryResultAsync({
    try: () => readConfigText(source),
    catch: (cause) => new ReadConfigError({ cause, source }),
  }).andThen(parseConfig);

/**
 * `fromThrowableAsync` lifts an async function into a reusable `ResultAsync`-returning
 * function with a typed `catch` mapper.
 */
const readBundledConfig = fromThrowableAsync(
  async (source: string) => readConfigText(source),
  (cause) => new ReadConfigError({ cause, source: "bundle" }),
);

export const loadBundledConfig = (source: string): StrictResultAsync<AppConfig, ConfigError> =>
  readBundledConfig(source).andThen(parseConfig);

/**
 * `fromSafePromise` wraps a Promise that is guaranteed never to reject (`E = never`).
 */
export const loadDefaultConfig = (): StrictResultAsync<AppConfig, never> =>
  fromSafePromise(Promise.resolve({ mode: "dev", port: 3000 } as const));

/**
 * `fromCallback` adapts callback- or event-emitter-style APIs into `ResultAsync`.
 * Returning a cleanup function from `subscribe` ensures listeners/timers are
 * cleaned up when the callback resolves, rejects, or is aborted via `signal`.
 */
export const waitForConfigEvent = (
  source: "ready" | "broken",
  events: string[] = [],
  signal?: ResultAsyncAbortSignal,
): StrictResultAsync<AppConfig, ConfigEventError | AbortError> =>
  fromCallback({
    ...(signal !== undefined ? { signal } : {}),
    catch: (cause) =>
      new ConfigEventError({
        cause,
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
    subscribe: ({ resolve, reject }) => {
      events.push(`subscribe:${source}`);
      const timer = setTimeout(() => {
        if (source === "broken") {
          reject(new Error("stream disconnected"));
          return;
        }
        resolve({ mode: "prod", port: 9090 });
      }, 1);

      return () => {
        clearTimeout(timer);
        events.push(`cleanup:${source}`);
      };
    },
  });

/**
 * `matchError` exhaustively dispatches on a tagged error union by `_tag`.
 */
export const configErrorLabel = (error: ConfigError): string =>
  matchError(error, {
    ConfigShapeError: () => "shape",
    ParseConfigError: () => "parse",
    ReadConfigError: (readError) => `read:${readError.source}`,
  });

/**
 * `matchErrorPartial` handles specific `_tag` cases and delegates remaining
 * variants to a fallback handler.
 */
export const configErrorStatus = (error: ConfigError): number =>
  matchErrorPartial(
    error,
    {
      ReadConfigError: () => 503,
    },
    () => 400,
  );

/**
 * `.unwrapOr(defaultValue)` extracts the `Ok` value or returns a fallback at the edge.
 */
export const configPortOrDefault = (raw: string): number =>
  parseConfig(raw)
    .map((config) => config.port)
    .unwrapOr(3000);

/**
 * `.unwrapOrThrow()` extracts the `Ok` value or throws/rejects the `Err` at an
 * outer boundary (e.g., CLI entrypoint or test harness).
 */
export const loadConfigOrThrow = async (source: string): Promise<AppConfig> =>
  loadConfig(source).unwrapOrThrow();

/**
 * `runSync(result)` is the functional helper equivalent of `result.unwrapOrThrow()`
 * for synchronous `Result` values at the edge of a program.
 */
export const parseConfigPortSync = (raw: string): number =>
  runSync(parseConfig(raw).map((config) => config.port));

/**
 * `runPromise(resultAsync)` executes a `ResultAsync` and resolves with the `Ok`
 * value or rejects the Promise with the `Err` value.
 */
export const loadConfigPortPromise = (source: string): Promise<number> =>
  runPromise(loadConfig(source).map((config) => config.port));

/**
 * `isError(value)` narrows an `unknown` value to a standard `Error` instance.
 */
export const normalizeUnknownError = (value: unknown): string =>
  isError(value) ? value.message : "not-an-error";
