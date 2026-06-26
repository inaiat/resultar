import {
  createTaggedError,
  fromSafePromise,
  fromThrowable,
  fromThrowableAsync,
  isError,
  matchError,
  matchErrorPartial,
  ok,
  tryResult,
  tryResultAsync,
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

export const parseConfig = (
  raw: string,
): StrictResult<AppConfig, ConfigShapeError | ParseConfigError> =>
  tryResult(
    () => JSON.parse(raw) as unknown,
    (cause) => new ParseConfigError({ cause }),
  ).andThen(decodeConfig);

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
    throw new Error("missing config");
  }

  if (source === "bad-json") {
    return "{";
  }

  return '{"port":8080,"mode":"prod"}';
};

export const loadConfig = (source: string): StrictResultAsync<AppConfig, ConfigError> =>
  tryResultAsync({
    try: () => readConfigText(source),
    catch: (cause) => new ReadConfigError({ cause, source }),
  }).andThen(parseConfig);

const readBundledConfig = fromThrowableAsync(
  async (source: string) => readConfigText(source),
  (cause) => new ReadConfigError({ cause, source: "bundle" }),
);

export const loadBundledConfig = (source: string): StrictResultAsync<AppConfig, ConfigError> =>
  readBundledConfig(source).andThen(parseConfig);

export const loadDefaultConfig = (): StrictResultAsync<AppConfig, never> =>
  fromSafePromise(Promise.resolve({ mode: "dev", port: 3000 } as const));

export const configErrorLabel = (error: ConfigError): string =>
  matchError(error, {
    ConfigShapeError: () => "shape",
    ParseConfigError: () => "parse",
    ReadConfigError: (readError) => `read:${readError.source}`,
  });

export const configErrorStatus = (error: ConfigError): number =>
  matchErrorPartial(
    error,
    {
      ReadConfigError: () => 503,
    },
    () => 400,
  );

export const configPortOrDefault = (raw: string): number =>
  parseConfig(raw)
    .map((config) => config.port)
    .unwrapOr(3000);

export const loadConfigOrThrow = async (source: string): Promise<AppConfig> =>
  loadConfig(source).unwrapOrThrow();

export const normalizeUnknownError = (value: unknown): string =>
  isError(value) ? value.message : "not-an-error";
