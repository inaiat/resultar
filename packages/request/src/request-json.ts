import {
  AbortError,
  err,
  errAsync,
  fromPromise,
  fromThrowable,
  isAbortError,
  ok,
  okAsync,
  ResultAsync,
  ResultTask,
  Retry,
  type Result,
  type ResultAsyncAbortSignal,
  type ResultAsyncRetryContext,
} from "resultar";

import type {
  RequestHeaders,
  RequestJsonDecoder,
  RequestJsonErrorContext,
  RequestJsonFactory,
  RequestJsonInput,
  RequestJsonMapError,
  RequestJsonMapErrorResult,
  RequestJsonMappedInput,
  RequestJsonResponseData,
  RequestJsonRetry,
  RequestJsonRetryContext,
  RequestJsonSource,
  RequestJsonTaskInput,
  RequestJsonTaskMappedInput,
  RequestJsonTaskRetry,
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

const safeJsonStringify = fromThrowable((value: unknown) => JSON.stringify(value));
const safeToString = fromThrowable(String);

const safeSerialize = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return safeToString(value).unwrapOr("Unknown error");
  }

  return safeJsonStringify(value)
    .andThen((serialized) => (serialized === undefined ? err() : ok(serialized)))
    .orElse(() => safeToString(value))
    .unwrapOr("Unknown error");
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
    super(safeSerialize({ body, headers, statusCode }));
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

const invalidJsonErrors = new WeakSet<RequestError>();
const neverAbortedSignal = new AbortController().signal;

const combineSignals = (
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined => {
  if (first === undefined) {
    return second;
  }

  if (second === undefined || first === second) {
    return first;
  }

  return AbortSignal.any([first, second]);
};

const isSignalAborted = (signal: AbortSignal | undefined): signal is AbortSignal =>
  signal !== undefined && signal.aborted;

const getAbortReason = (signal: AbortSignal): unknown => signal.reason as unknown;

const toAbortSignal = (
  signal: ResultAsyncAbortSignal,
  fallback: AbortSignal | undefined,
): AbortSignal => (signal instanceof AbortSignal ? signal : (fallback ?? neverAbortedSignal));

const isRequestAbortError = (error: RequestError): boolean =>
  isAbortError(error.cause) || isAbortError(error);

const ignoreUnhandledRejection = (): undefined => undefined;

const disarmPromiseLike = fromThrowable((source: unknown): unknown => {
  if (source instanceof Promise) {
    return source.then(undefined, ignoreUnhandledRejection);
  }

  if (isRecord(source) && typeof source.then === "function") {
    return Reflect.apply(source.then, source, [undefined, ignoreUnhandledRejection]);
  }

  return undefined;
});

const disarmInputRequest = (input: unknown): void => {
  if (isRecord(input) && "request" in input && typeof input.request !== "function") {
    disarmPromiseLike(input.request).unwrapOr(false);
  }
};

const resolveRawAbortReason = (signal: AbortSignal | undefined, fallback?: unknown): unknown => {
  if (isSignalAborted(signal)) {
    const signalReason = getAbortReason(signal);

    if (signalReason !== undefined) {
      return signalReason;
    }
  }

  if (fallback instanceof AbortError && Object.hasOwn(fallback, "cause")) {
    return fallback.cause;
  }

  return fallback;
};

const createAbortRequestError = (
  signal: AbortSignal | undefined,
  fallback?: unknown,
): RequestError => {
  const rawReason = resolveRawAbortReason(signal, fallback);

  if (rawReason instanceof RequestError) {
    return rawReason;
  }

  if (rawReason instanceof Error) {
    return baseRequestErrorHandler(rawReason);
  }

  if (rawReason === undefined) {
    const abortError = new AbortError("Request aborted");

    return new RequestError(abortError.message, 500, abortError);
  }

  if (typeof rawReason === "string") {
    return new RequestError(rawReason, 500, rawReason);
  }

  return new RequestError(safeSerialize(rawReason), 500, rawReason);
};

const requestErrorHandlerForSignal =
  (signal: AbortSignal | undefined) =>
  (exception: unknown): RequestError => {
    if (isSignalAborted(signal)) {
      if (isAbortError(exception)) {
        return createAbortRequestError(signal, exception);
      }

      const reason = getAbortReason(signal);

      if (reason !== undefined && Object.is(exception, reason)) {
        return createAbortRequestError(signal, exception);
      }

      if (typeof exception === "string") {
        return new RequestError(exception, 500, exception);
      }
    }

    return baseRequestErrorHandler(exception);
  };

const runCancelableStage = <Value>(
  activeSignal: AbortSignal | undefined,
  run: () => Promise<Value> | Value,
  onError: (exception: unknown) => RequestError,
): ResultAsync<Value, RequestError> => {
  if (isSignalAborted(activeSignal)) {
    return errAsync(createAbortRequestError(activeSignal));
  }

  return okAsync().andThen(() => {
    if (isSignalAborted(activeSignal)) {
      return err(createAbortRequestError(activeSignal));
    }

    return fromPromise(Promise.try(run), onError);
  });
};

const jsonParseErrorHandler = (exception: unknown): RequestError => {
  const requestError = baseRequestErrorHandler(exception);

  if (requestError.cause instanceof SyntaxError) {
    invalidJsonErrors.add(requestError);
  }

  return requestError;
};

const createHttpResponseRequestError = (
  body: string,
  normalized: NormalizedJsonResponseData,
): RequestError =>
  new RequestError(
    body,
    normalized.statusCode,
    new HttpResponseErrorCauseError({
      body,
      headers: normalized.headers,
      statusCode: normalized.statusCode,
    }),
  );

const handleHttpErrors = <T extends RequestJsonResponseData>(
  response: T,
  activeSignal: AbortSignal | undefined,
  errorHandler: (exception: unknown) => RequestError = baseRequestErrorHandler,
) => {
  const normalized = normalizeResponse(response);

  if (normalized.statusCode >= 400 && normalized.statusCode < 600) {
    return runCancelableStage(activeSignal, () => normalized.text(), errorHandler).andThen((body) =>
      isSignalAborted(activeSignal)
        ? err(createAbortRequestError(activeSignal))
        : err(createHttpResponseRequestError(body, normalized)),
    );
  }

  return ok(response);
};

const handleHttpErrorsTask = <T extends RequestJsonResponseData>(
  response: T,
): ResultTask<T, RequestError> => {
  const normalized = normalizeResponse(response);

  if (normalized.statusCode >= 400 && normalized.statusCode < 600) {
    return ResultTask.tryPromise({
      catch: baseRequestErrorHandler,
      try: () => normalized.text(),
    }).andThen((body) => err(createHttpResponseRequestError(body, normalized)));
  }

  return ResultTask.ok(response);
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
  | { readonly success: true; readonly value: T } =>
  fromThrowable(decode)(value).match(
    (decoded) =>
      decoded.success
        ? decoded
        : {
            message: decoded.message,
            reason: { cause: decoded.cause, errors: decoded.errors ?? [], value },
            success: false,
          },
    (cause) => ({ reason: { cause, errors: [], value }, success: false }),
  );

const decodeJsonResponseValue = <T>(
  decode: RequestJsonDecoder<T>,
  value: unknown,
  validationError: RequestJsonValidationError | undefined,
): Result<T, RequestError> => {
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

  if (invalidJsonErrors.has(error) && error.cause instanceof SyntaxError) {
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
  task: (attemptSignal: AbortSignal) => ResultAsync<T, RequestError>,
  retry: RequestJsonRetry,
  externalSignal: AbortSignal | undefined,
): ResultAsync<T, RequestError> => {
  const retrySignal = combineSignals(externalSignal, retry.signal);
  let latestAttemptAborted = false;
  let abortedDuringRetryControl = false;

  const shouldRetry = async (
    error: RequestError,
    context: ResultAsyncRetryContext,
  ): Promise<boolean> => {
    if (isSignalAborted(retrySignal)) {
      if (!latestAttemptAborted) {
        abortedDuringRetryControl = true;
      }

      return false;
    }

    const retryContext = toRetryContext(error, context);

    if (retry.when !== undefined) {
      const allowed = await retry.when(retryContext);

      if (isSignalAborted(retrySignal)) {
        abortedDuringRetryControl = true;

        return false;
      }

      return allowed;
    }

    if (isRequestAbortError(error)) {
      return false;
    }

    return shouldRetryRequestJson(retryContext);
  };
  const onRetry =
    retry.onRetry === undefined
      ? undefined
      : (error: RequestError, context: ResultAsyncRetryContext) => {
          if (isSignalAborted(retrySignal)) {
            abortedDuringRetryControl = true;

            return;
          }

          return retry.onRetry?.(toRetryContext(error, context));
        };
  const runAttempt = (_attempt: number, attemptSignal: ResultAsyncAbortSignal) => {
    const combinedAttemptSignal = toAbortSignal(attemptSignal, retrySignal);
    latestAttemptAborted = isSignalAborted(combinedAttemptSignal);

    return task(combinedAttemptSignal).mapErr((attemptError) => {
      latestAttemptAborted = isSignalAborted(combinedAttemptSignal);

      return attemptError;
    });
  };
  const retried =
    retry.backoff === undefined
      ? ResultAsync.retry(runAttempt, {
          delayMs: retry.delayMs,
          jittered: retry.jittered,
          onRetry,
          signal: retrySignal,
          times: retry.times,
          while: shouldRetry,
        })
      : ResultAsync.retry(runAttempt, {
          ...Retry.policy<RequestError>({
            backoff: retry.backoff,
            delayMs: retry.delayMs,
            jittered: retry.jittered,
            onRetry,
            times: retry.times,
            while: shouldRetry,
          }),
          signal: retrySignal,
        });

  return retried.mapErr((error) =>
    !(error instanceof RequestError) ||
    (isSignalAborted(retrySignal) && (!latestAttemptAborted || abortedDuringRetryControl))
      ? createAbortRequestError(retrySignal, error)
      : error,
  );
};

const executeRequestJson = <T, R extends RequestJsonResponseData = RequestJsonResponseData>(
  request: RequestJsonSource<R>,
  decode: RequestJsonDecoder<T>,
  validationError: RequestJsonValidationError | undefined,
  mapError: RequestJsonMapError | undefined,
  retry: RequestJsonRetry | undefined,
  signal: AbortSignal | undefined,
) => {
  const createResult = (attemptSignal?: AbortSignal) => {
    const activeSignal = combineSignals(signal, attemptSignal);

    if (isSignalAborted(activeSignal)) {
      return errAsync(createAbortRequestError(activeSignal));
    }

    const errorHandler = requestErrorHandlerForSignal(activeSignal);

    return runCancelableStage(
      activeSignal,
      () => (typeof request === "function" ? request(activeSignal ?? neverAbortedSignal) : request),
      errorHandler,
    )
      .andThen((response) =>
        isSignalAborted(activeSignal)
          ? err(createAbortRequestError(activeSignal))
          : handleHttpErrors(response, activeSignal, errorHandler),
      )
      .andThen((response) =>
        runCancelableStage(
          activeSignal,
          () => normalizeResponse(response).json(),
          (exception) =>
            isSignalAborted(activeSignal)
              ? errorHandler(exception)
              : jsonParseErrorHandler(exception),
        ),
      )
      .andThen((value) => {
        if (isSignalAborted(activeSignal)) {
          return err(createAbortRequestError(activeSignal));
        }

        const decoded = decodeJsonResponseValue(decode, value, validationError);

        return isSignalAborted(activeSignal) ? err(createAbortRequestError(activeSignal)) : decoded;
      });
  };

  const createResultWithRetry = (retryOptions: RequestJsonRetry) =>
    typeof request === "function"
      ? createRequestJsonRetryResult(createResult, retryOptions, signal)
      : errAsync(RequestError.integrationError("JSON request retry requires a request factory"));

  const result = retry === undefined ? createResult(signal) : createResultWithRetry(retry);

  return mapError === undefined ? result : result.mapErr(mapRequestJsonError(mapError));
};

const executeRequestJsonTask = <T, R extends RequestJsonResponseData = RequestJsonResponseData>(
  request: RequestJsonFactory<R>,
  decode: RequestJsonDecoder<T>,
  validationError: RequestJsonValidationError | undefined,
  mapError: RequestJsonMapError | undefined,
  retry: RequestJsonTaskRetry | undefined,
): ResultTask<T, Error> => {
  if (typeof request !== "function") {
    const invalidSourceError = RequestError.integrationError(
      "Task JSON request requires a request factory",
    );

    return ResultTask.err(
      mapError === undefined
        ? invalidSourceError
        : mapRequestJsonError(mapError)(invalidSourceError),
    );
  }

  const attemptTask = ResultTask.tryPromise({
    catch: baseRequestErrorHandler,
    try: (signal) => request(signal),
  })
    .andThen(handleHttpErrorsTask)
    .andThen((response) =>
      ResultTask.tryPromise({
        catch: jsonParseErrorHandler,
        try: () => normalizeResponse(response).json(),
      }),
    )
    .andThen((value) => decodeJsonResponseValue(decode, value, validationError));

  const retriedTask =
    retry === undefined
      ? attemptTask
      : ResultTask.retry(
          attemptTask,
          Retry.policy<RequestError>({
            backoff: retry.backoff,
            delayMs: retry.delayMs,
            jittered: retry.jittered,
            onRetry:
              retry.onRetry === undefined
                ? undefined
                : (error, context) => retry.onRetry?.(toRetryContext(error, { ...context })),
            times: retry.times,
            while: (error, context) => {
              const retryContext = toRetryContext(error, { ...context });

              if (retry.when !== undefined) {
                return retry.when(retryContext);
              }

              if (isRequestAbortError(error)) {
                return false;
              }

              return shouldRetryRequestJson(retryContext);
            },
          }),
        );

  return mapError === undefined ? retriedTask : retriedTask.mapErr(mapRequestJsonError(mapError));
};

const resolveDecoder = <T>(
  input:
    | { readonly decode: RequestJsonDecoder<T>; readonly validator?: never }
    | { readonly decode?: never; readonly validator: RequestJsonValidator<T> },
): RequestJsonDecoder<T> => input.decode ?? decodeWithValidator(input.validator);

/**
 * Executes a Fetch-compatible JSON request and returns decoded data through `ResultAsync`.
 *
 * Supply `decode` or `validator` for the response contract, `retry` for retryable request factories,
 * `signal` for cooperative cancellation, and `mapError` when the service boundary needs
 * domain-specific error types.
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
  disarmInputRequest(input);

  if (!isRequestJsonInput<T, R>(input)) {
    return errAsync(RequestError.integrationError("Missing JSON response decoder"));
  }

  const decode = resolveDecoder(input);
  const mapError = "mapError" in input ? input.mapError : undefined;

  return executeRequestJson(
    input.request,
    decode,
    input.validationError,
    mapError,
    input.retry,
    input.signal,
  );
}

/**
 * Builds a lazy, repeatable `ResultTask` for a Fetch-compatible JSON request factory.
 *
 * The returned Task starts no network work at construction, forwards the execution `AbortSignal` to
 * `request`, uses the Task runtime clock and interruption semantics for retries, and maps failures
 * through `RequestError` or `mapError`.
 */
export function requestJsonTask<
  T,
  M extends RequestJsonMapError,
  R extends RequestJsonResponseData = RequestJsonResponseData,
>(input: RequestJsonTaskMappedInput<T, M, R>): ResultTask<T, RequestJsonMapErrorResult<M>>;
export function requestJsonTask<T, R extends RequestJsonResponseData = RequestJsonResponseData>(
  input: RequestJsonTaskInput<T, R>,
): ResultTask<T, RequestError>;
export function requestJsonTask<T, R extends RequestJsonResponseData = RequestJsonResponseData>(
  input: RequestJsonTaskInput<T, R>,
): ResultTask<T, Error> {
  disarmInputRequest(input);

  if (!isRequestJsonInput<T, R>(input)) {
    return ResultTask.err(RequestError.integrationError("Missing JSON response decoder"));
  }

  const decode = resolveDecoder(input);
  const mapError = "mapError" in input ? input.mapError : undefined;

  return executeRequestJsonTask(
    input.request,
    decode,
    input.validationError,
    mapError,
    input.retry,
  );
}
