import {
  err,
  fromThrowable,
  isAbortError,
  ok,
  ResultTask,
  Retry,
  type Result,
  type RetryContext,
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
  readonly json: (signal: AbortSignal) => Promise<unknown>;
  readonly statusCode: number;
  readonly text: (signal: AbortSignal) => Promise<string>;
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

const serializeHeadersForMessage = (headers: RequestHeaders): unknown =>
  headers instanceof Headers ? Object.fromEntries(headers.entries()) : headers;

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
    super(safeSerialize({ body, headers: serializeHeadersForMessage(headers), statusCode }));
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

const invalidJsonErrors = new WeakSet<RequestError>();

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

const getAbortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("The operation was aborted.", "AbortError");

const cancelResponseBody = (response: RequestJsonResponseData, reason: unknown): unknown => {
  const body: unknown = "body" in response ? response.body : undefined;
  if (!isRecord(body)) return undefined;
  if (typeof body.cancel === "function" && body.locked !== true) {
    return Reflect.apply(body.cancel, body, [reason]);
  }
  if (typeof body.destroy === "function") {
    return Reflect.apply(body.destroy, body, [reason instanceof Error ? reason : undefined]);
  }
  return undefined;
};

const readWithSignal = async <T>(
  read: () => Promise<T>,
  cancel: (reason: unknown) => unknown,
  signal: AbortSignal,
): Promise<T> => {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const onAbort = () => {
    const reason = getAbortReason(signal);
    reject(reason);
    const canceled = fromThrowable(() => cancel(reason))();
    if (canceled.isOk()) disarmPromiseLike(canceled.value).unwrapOr(false);
  };
  if (signal.aborted) {
    onAbort();
    return promise;
  }

  signal.addEventListener("abort", onAbort, { once: true });
  try {
    try {
      read().then(resolve, reject);
    } catch (error) {
      reject(error);
    }
    return await promise;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

const readFetchBody = async (
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<string> => {
  const reader = body.getReader();
  try {
    return await readWithSignal(
      async () => {
        const decoder = new TextDecoder();
        let text = "";
        for (;;) {
          // eslint-disable-next-line no-await-in-loop -- Read and decode body chunks in stream order.
          const { done, value } = await reader.read();
          if (done) return text + decoder.decode();
          text += decoder.decode(value, { stream: true });
        }
      },
      (reason) => reader.cancel(reason),
      signal,
    );
  } finally {
    reader.releaseLock();
  }
};

const normalizeResponse = (response: RequestJsonResponseData): NormalizedJsonResponseData => {
  const cancel = (reason: unknown) => cancelResponseBody(response, reason);
  if (isUndiciJsonResponseData(response)) {
    return {
      headers: response.headers,
      json: (signal) => readWithSignal(() => response.body.json(), cancel, signal),
      statusCode: response.statusCode,
      text: (signal) => readWithSignal(() => response.body.text(), cancel, signal),
    };
  }

  const getFetchBody = (method: "json" | "text") => {
    const body =
      response instanceof Response &&
      response[method] === Response.prototype[method] &&
      !response.bodyUsed
        ? response.body
        : undefined;
    return body?.locked === false ? body : undefined;
  };
  return {
    headers: response.headers,
    json: (signal) => {
      const body = getFetchBody("json");
      return body === undefined
        ? readWithSignal(() => response.json(), cancel, signal)
        : readFetchBody(body, signal).then((text): unknown => JSON.parse(text));
    },
    statusCode: response.status,
    text: (signal) => {
      const body = getFetchBody("text");
      return body === undefined
        ? readWithSignal(() => response.text(), cancel, signal)
        : readFetchBody(body, signal);
    },
  };
};

const handleHttpErrors = <T extends RequestJsonResponseData>(
  response: T,
): ResultTask<T, RequestError> => {
  const normalized = normalizeResponse(response);

  if (normalized.statusCode >= 400 && normalized.statusCode < 600) {
    return ResultTask.tryPromise({ catch: baseRequestErrorHandler, try: normalized.text }).andThen(
      (body) => err(createHttpResponseRequestError(body, normalized)),
    );
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
  retryContext: RetryContext,
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

const executeRequestJson = <T, R extends RequestJsonResponseData = RequestJsonResponseData>(
  request: RequestJsonFactory<R>,
  decode: RequestJsonDecoder<T>,
  validationError: RequestJsonValidationError | undefined,
  mapError: RequestJsonMapError | undefined,
  retry: RequestJsonRetry | undefined,
): ResultTask<T, Error> => {
  if (typeof request !== "function") {
    const invalidSourceTask = ResultTask.err(
      RequestError.integrationError("JSON request requires a request factory"),
    );

    return mapError === undefined
      ? invalidSourceTask
      : invalidSourceTask.mapErr(mapRequestJsonError(mapError));
  }

  const attemptTask = ResultTask.tryPromise({
    catch: baseRequestErrorHandler,
    try: (signal) => request(signal),
  })
    .andThen(handleHttpErrors)
    .andThen((response) =>
      ResultTask.tryPromise({
        catch: jsonParseErrorHandler,
        try: (signal) => normalizeResponse(response).json(signal),
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
                : (error, context) => retry.onRetry?.(toRetryContext(error, context)),
            times: retry.times,
            while: (error, context) => {
              const retryContext = toRetryContext(error, context);

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
 * Builds a lazy, repeatable `ResultTask` for a Fetch-compatible JSON request factory.
 *
 * The returned Task starts no network work at construction, forwards the execution `AbortSignal` to
 * `request`, uses the Task runtime clock and interruption semantics for retries, validates or
 * decodes the payload with `validator` or `decode`, and maps failures through `RequestError` or
 * `mapError`.
 */
export function requestJson<
  T,
  M extends RequestJsonMapError,
  R extends RequestJsonResponseData = RequestJsonResponseData,
>(input: RequestJsonMappedInput<T, M, R>): ResultTask<T, RequestJsonMapErrorResult<M>>;
export function requestJson<T, R extends RequestJsonResponseData = RequestJsonResponseData>(
  input: RequestJsonInput<T, R>,
): ResultTask<T, RequestError>;
export function requestJson<T, R extends RequestJsonResponseData = RequestJsonResponseData>(
  input: RequestJsonInput<T, R>,
): ResultTask<T, Error> {
  disarmInputRequest(input);

  if (!isRequestJsonInput<T, R>(input)) {
    return ResultTask.err(RequestError.integrationError("Missing JSON response decoder"));
  }

  const decode = resolveDecoder(input);
  const mapError = "mapError" in input ? input.mapError : undefined;

  return executeRequestJson(input.request, decode, input.validationError, mapError, input.retry);
}
