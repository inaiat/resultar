import {
  err,
  errAsync,
  fromPromise,
  ok,
  ResultAsync,
  type ResultAsyncRetryContext,
} from "resultar";

import type {
  RequestHeaders,
  RequestJsonDecoder,
  RequestJsonErrorContext,
  RequestJsonInput,
  RequestJsonMapError,
  RequestJsonMapErrorResult,
  RequestJsonMappedInput,
  RequestJsonResponseData,
  RequestJsonRetry,
  RequestJsonRetryContext,
  RequestJsonSource,
  RequestJsonValidationError,
  RequestJsonValidationReason,
  RequestJsonValidator,
  UndiciJsonResponseData,
} from "./types.js";

const defaultValidationErrorMessage = "Invalid JSON response payload";
const timeoutErrorNames = new Set([
  "BodyTimeoutError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "TimeoutError",
]);

type NormalizedJsonResponseData = {
  readonly headers: RequestHeaders;
  readonly json: () => Promise<unknown>;
  readonly statusCode: number;
  readonly text: () => Promise<string>;
};

type ErrorWithName = Error & { readonly name: string };

const safeSerialize = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }

  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Fallback for circular structures, BigInt in object properties, etc.
  }

  try {
    return String(value);
  } catch {
    return "Unknown error";
  }
};

/** Error cause containing the body, headers, and status of an unsuccessful HTTP response. */
export class HttpResponseErrorCauseError extends Error {
  readonly body: string;
  readonly headers: RequestHeaders;
  readonly statusCode: number;

  constructor({
    body,
    headers,
    statusCode,
  }: {
    readonly body: string;
    readonly headers: RequestHeaders;
    readonly statusCode: number;
  }) {
    super(JSON.stringify({ body, headers, statusCode }));
    this.name = "HttpResponseErrorCauseError";
    this.body = body;
    this.headers = headers;
    this.statusCode = statusCode;
  }
}

class RequestJsonValidationErrorCauseError extends Error {
  constructor(
    message: string,
    readonly reason: RequestJsonValidationReason,
  ) {
    super(message);
    this.name = "RequestJsonValidationErrorCauseError";
  }
}

/** Default request failure used when no domain-specific `mapError` configuration is supplied. */
export class RequestError extends Error {
  constructor(
    message?: string,
    readonly statusCode = 400,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RequestError";
  }

  static exception(exception: unknown, statusCode: number): RequestError {
    if (typeof exception === "string") {
      return new RequestError(exception, statusCode);
    }

    if (exception instanceof Error) {
      return new RequestError(exception.message, statusCode, exception);
    }

    return new RequestError(safeSerialize(exception), statusCode, exception);
  }

  static integrationError(exception: unknown): RequestError {
    return RequestError.exception(exception, 500);
  }
}

/** Request error whose cause contains an unsuccessful HTTP response. */
export type HttpResponseError = RequestError & { readonly cause: HttpResponseErrorCauseError };

/** Narrows a request error to an HTTP-response error with structured response metadata. */
export const isHttpResponseError = (error: RequestError): error is HttpResponseError =>
  error.cause instanceof HttpResponseErrorCauseError;

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

const isErrorWithName = (exception: unknown): exception is ErrorWithName =>
  exception instanceof Error && typeof exception.name === "string";

/** Maps an unknown integration failure to a 500 `RequestError`. */
export const integrationErrorHandler = (exception: unknown): RequestError =>
  RequestError.integrationError(exception);

/** Maps timeout failures to 408 and other unknown request failures to 500. */
export const baseRequestErrorHandler = (exception: unknown): RequestError => {
  if (isErrorWithName(exception) && timeoutErrorNames.has(exception.name)) {
    return new RequestError(exception.message, 408, exception);
  }

  return RequestError.exception(exception, 500);
};

const isUndiciJsonResponseData = (
  response: RequestJsonResponseData,
): response is UndiciJsonResponseData => isRecord(response) && isUndiciJsonResponseRecord(response);

const isUndiciJsonResponseRecord = (response: Record<PropertyKey, unknown>) => {
  const body = response.body;

  return (
    typeof response.statusCode === "number" &&
    isRecord(body) &&
    typeof body.text === "function" &&
    typeof body.json === "function"
  );
};

const normalizeResponse = (response: RequestJsonResponseData): NormalizedJsonResponseData => {
  if (isUndiciJsonResponseData(response)) {
    return {
      headers: response.headers,
      json: () => response.body.json(),
      statusCode: response.statusCode,
      text: () => response.body.text(),
    };
  }

  return {
    headers: response.headers,
    json: () => response.json(),
    statusCode: response.status,
    text: () => response.text(),
  };
};

const handleHttpErrors = <T extends RequestJsonResponseData>(response: T) => {
  const normalized = normalizeResponse(response);

  if (normalized.statusCode >= 400 && normalized.statusCode < 600) {
    return fromPromise(
      Promise.resolve().then(() => normalized.text()),
      baseRequestErrorHandler,
    ).andThen((body) =>
      err(
        new RequestError(
          body,
          normalized.statusCode,
          new HttpResponseErrorCauseError({
            body,
            headers: normalized.headers,
            statusCode: normalized.statusCode,
          }),
        ),
      ),
    );
  }

  return ok(response);
};

const isRequestJsonInput = <T, R extends RequestJsonResponseData = RequestJsonResponseData>(
  input: unknown,
): input is RequestJsonInput<T, R> =>
  isRecord(input) && "request" in input && ("decode" in input || "validator" in input);

const getValidationErrorMessage = (
  reason: RequestJsonValidationReason,
  error: RequestJsonValidationError | undefined,
  fallbackMessage: string | undefined,
) => {
  if (typeof error === "function") {
    return error(reason);
  }

  return error ?? fallbackMessage ?? defaultValidationErrorMessage;
};

const createValidationRequestError = (message: string, reason: RequestJsonValidationReason) =>
  new RequestError(message, 500, new RequestJsonValidationErrorCauseError(message, reason));

const decodeWithValidator =
  <T>(validator: RequestJsonValidator<T>): RequestJsonDecoder<T> =>
  (value) =>
    validator(value) ? { success: true, value } : { errors: [], success: false };

const decodeSafely = <T>(
  decode: RequestJsonDecoder<T>,
  value: unknown,
):
  | {
      readonly message?: string;
      readonly reason: RequestJsonValidationReason;
      readonly success: false;
    }
  | { readonly success: true; readonly value: T } => {
  try {
    const decoded = decode(value);

    if (decoded.success) {
      return decoded;
    }

    return {
      message: decoded.message,
      reason: { cause: decoded.cause, errors: decoded.errors ?? [], value },
      success: false,
    };
  } catch (cause) {
    return { reason: { cause, errors: [], value }, success: false };
  }
};

const getErrorCause = (error: RequestError) => (error.cause instanceof Error ? error.cause : error);

const asErrorCause = (error: RequestError): Error => {
  const cause = getErrorCause(error);

  return cause instanceof Error ? cause : error;
};

const classifyRequestJsonError = (error: RequestError): RequestJsonErrorContext => {
  if (isHttpResponseError(error)) {
    return {
      body: error.cause.body,
      error,
      headers: error.cause.headers,
      reason: "http",
      statusCode: error.cause.statusCode,
    };
  }

  if (error.cause instanceof RequestJsonValidationErrorCauseError) {
    return { ...error.cause.reason, error, message: error.message, reason: "validation" };
  }

  if (error.cause instanceof SyntaxError) {
    return { cause: error.cause, error, reason: "invalidJson" };
  }

  return { cause: asErrorCause(error), error, reason: "request" };
};

const toRetryContext = (
  error: RequestError,
  retryContext: ResultAsyncRetryContext,
): RequestJsonRetryContext => ({ ...classifyRequestJsonError(error), ...retryContext });

const shouldRetryRequestJson = (context: RequestJsonRetryContext) =>
  context.reason === "request" || (context.reason === "http" && context.statusCode >= 500);

const mapRequestJsonError =
  (mapError: RequestJsonMapError) =>
  (error: RequestError): Error => {
    const context = classifyRequestJsonError(error);

    switch (context.reason) {
      case "http":
        return mapError[context.statusCode]?.(context) ?? mapError.http(context);
      case "invalidJson":
        return mapError.invalidJson(context);
      case "request":
        return mapError.request(context);
      case "validation":
        return mapError.validation(context);
      default:
        return mapError.request({ cause: asErrorCause(error), error });
    }
  };

const createRequestJsonRetryResult = <T>(
  task: () => ResultAsync<T, RequestError>,
  retry: RequestJsonRetry,
) =>
  ResultAsync.retry(task, {
    delayMs: retry.delayMs,
    jittered: retry.jittered,
    onRetry: (error, context) => retry.onRetry?.(toRetryContext(error, context)),
    times: retry.times,
    while: (error, context) => {
      const retryContext = toRetryContext(error, context);

      return retry.when?.(retryContext) ?? shouldRetryRequestJson(retryContext);
    },
  }) as ResultAsync<T, RequestError>;

const executeRequestJson = <T, R extends RequestJsonResponseData = RequestJsonResponseData>(
  request: RequestJsonSource<R>,
  decode: RequestJsonDecoder<T>,
  validationError: RequestJsonValidationError | undefined,
  mapError: RequestJsonMapError | undefined,
  retry: RequestJsonRetry | undefined,
) => {
  const createResult = () =>
    fromPromise(
      Promise.resolve().then(() => (typeof request === "function" ? request() : request)),
      baseRequestErrorHandler,
    )
      .andThen(handleHttpErrors)
      .andThen((response) =>
        fromPromise(
          Promise.resolve().then(() => normalizeResponse(response).json()),
          baseRequestErrorHandler,
        ),
      )
      .andThen((value) => {
        const decoded = decodeSafely(decode, value);

        if (decoded.success) {
          return ok(decoded.value);
        }

        return err(
          createValidationRequestError(
            getValidationErrorMessage(decoded.reason, validationError, decoded.message),
            decoded.reason,
          ),
        );
      });

  const createResultWithRetry = (retryOptions: RequestJsonRetry) =>
    typeof request === "function"
      ? createRequestJsonRetryResult(createResult, retryOptions)
      : errAsync(RequestError.integrationError("JSON request retry requires a request factory"));

  const result = retry === undefined ? createResult() : createResultWithRetry(retry);

  return mapError === undefined ? result : result.mapErr(mapRequestJsonError(mapError));
};

/**
 * Executes a Fetch-compatible JSON request and returns decoded data through `ResultAsync`.
 *
 * Supply `decode` or `validator` for the response contract, `retry` for retryable request factories,
 * and `mapError` when the service boundary needs domain-specific error types.
 */
export function requestJson<
  T,
  M extends RequestJsonMapError,
  R extends RequestJsonResponseData = RequestJsonResponseData,
>(input: RequestJsonMappedInput<T, M, R>): ResultAsync<T, RequestJsonMapErrorResult<M>>;
export function requestJson<T, R extends RequestJsonResponseData = RequestJsonResponseData>(
  input: RequestJsonInput<T, R>,
): ResultAsync<T, RequestError>;
export function requestJson<T, R extends RequestJsonResponseData = RequestJsonResponseData>(
  input: RequestJsonInput<T, R>,
): ResultAsync<T, Error> {
  if (!isRequestJsonInput<T, R>(input)) {
    return errAsync(RequestError.integrationError("Missing JSON response decoder"));
  }

  const decode: RequestJsonDecoder<T> =
    "decode" in input && input.decode !== undefined
      ? input.decode
      : decodeWithValidator(input.validator);
  const mapError = "mapError" in input ? input.mapError : undefined;

  return executeRequestJson(input.request, decode, input.validationError, mapError, input.retry);
}
