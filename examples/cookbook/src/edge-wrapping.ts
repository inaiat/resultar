/**
 * Edge Wrapping & Boundary Unwrapping (`tryResult`, `fromThrowable`, `ResultTask.tryPromise`, `runSync`)
 *
 * This module demonstrates how to convert exception-throwing synchronous/async
 * functions and callback-based APIs into typed `Result` / `ResultTask` values
 * at system boundaries, and how to unwrap or match them when crossing back out.
 */
import {
  ResultTask,
  createTaggedError,
  fromThrowable,
  isError,
  matchError,
  matchErrorPartial,
  ok,
  runSync,
  tryResult,
  type StrictResult,
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
 * `ResultTask.tryPromise` creates a fresh Promise-returning operation on each run
 * and maps rejections or synchronous throws into a typed error.
 */
export const loadConfig = (source: string): ResultTask<AppConfig, ConfigError> =>
  ResultTask.tryPromise({
    try: () => readConfigText(source),
    catch: (cause) => new ReadConfigError({ cause, source }),
  }).andThen(parseConfig);

/**
 * A reusable task factory keeps the external Promise inside `tryPromise`, so reading
 * bundled config starts only when the returned task is run.
 */
const readBundledConfig = (source: string): ResultTask<string, ReadConfigError> =>
  ResultTask.tryPromise({
    try: () => readConfigText(source),
    catch: (cause) => new ReadConfigError({ cause, source: "bundle" }),
  });

export const loadBundledConfig = (source: string): ResultTask<AppConfig, ConfigError> =>
  readBundledConfig(source).andThen(parseConfig);

/**
 * A known success needs only `ResultTask.ok`; no external Promise is necessary.
 */
export const loadDefaultConfig = (): ResultTask<AppConfig, never> =>
  ResultTask.ok({ mode: "dev", port: 3000 });

/**
 * Adapt callback/event APIs with a signal-aware Promise factory and `ensuring`.
 * Each run subscribes independently and removes its timer and abort listener on
 * success, failure, or interruption. Pass cancellation to the task runner.
 */
export const waitForConfigEvent = (
  source: "ready" | "broken",
  events: string[] = [],
): ResultTask<AppConfig, ConfigEventError> =>
  ResultTask.gen(function* () {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: () => void = () => undefined;
    let subscribed = false;

    return yield* ResultTask.tryPromise({
      try: (signal) =>
        new Promise<AppConfig>((resolve, reject) => {
          subscribed = true;
          events.push(`subscribe:${source}`);
          const onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", onAbort);
          if (signal.aborted) {
            onAbort();
            return;
          }

          timer = setTimeout(() => {
            if (source === "broken") {
              reject(new Error("stream disconnected"));
              return;
            }
            resolve({ mode: "prod", port: 9090 });
          }, 1);
        }),
      catch: (cause) =>
        new ConfigEventError({
          cause,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    }).ensuring(() =>
      ResultTask.sync(() => {
        if (timer !== undefined) clearTimeout(timer);
        removeAbortListener();
        if (subscribed) events.push(`cleanup:${source}`);
      }),
    );
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
 * `task.runPromise()` extracts a task's success value or rejects its failure
 * at an outer boundary (e.g., CLI entrypoint or test harness).
 */
export const loadConfigOrThrow = (source: string): Promise<AppConfig> =>
  loadConfig(source).runPromise();

/**
 * `runSync(result)` is the functional helper equivalent of `result.unwrapOrThrow()`
 * for synchronous `Result` values at the edge of a program.
 */
export const parseConfigPortSync = (raw: string): number =>
  runSync(parseConfig(raw).map((config) => config.port));

/**
 * `task.runPromise()` executes the lazy task at an outer boundary and
 * resolves with its success value or rejects with its typed failure or Cause.
 */
export const loadConfigPortPromise = (source: string): Promise<number> =>
  loadConfig(source)
    .map((config) => config.port)
    .runPromise();

/**
 * `isError(value)` narrows an `unknown` value to a standard `Error` instance.
 */
export const normalizeUnknownError = (value: unknown): string =>
  isError(value) ? value.message : "not-an-error";
