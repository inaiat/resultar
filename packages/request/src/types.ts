import type { ResultAsyncRetryContext } from "resultar";

import type { RequestError } from "./request-json.js";

/** Header collection carried by a Fetch-compatible or Undici-compatible response. */
export type RequestHeaders = unknown;

/** Structural response contract accepted from the Fetch API. */
export type FetchJsonResponseData = {
  readonly headers?: RequestHeaders;
  readonly json: () => Promise<unknown>;
  readonly status: number;
  readonly text: () => Promise<string>;
};

/** Structural response contract accepted from Undici request helpers. */
export type UndiciJsonResponseData = {
  readonly body: { readonly json: () => Promise<unknown>; readonly text: () => Promise<string> };
  readonly headers?: RequestHeaders;
  readonly statusCode: number;
};

/** Fetch-compatible or Undici-compatible response accepted by `requestJson`. */
export type RequestJsonResponseData = FetchJsonResponseData | UndiciJsonResponseData;

/** Promise or retryable promise factory that produces a JSON response. */
export type RequestJsonSource<R extends RequestJsonResponseData = RequestJsonResponseData> =
  | Promise<R>
  | (() => Promise<R>);

/** Type guard used to validate a decoded JSON value. */
export type RequestJsonValidator<T> = (value: unknown) => value is T;

/** Structured issue returned by a JSON decoder or schema adapter. */
export type RequestJsonValidationIssue = {
  readonly code?: string;
  readonly message: string;
  readonly path?: readonly PropertyKey[] | string;
};

/** Successful result returned by a JSON decoder. */
export type RequestJsonDecodeSuccess<T> = { readonly success: true; readonly value: T };

/** Failed result returned by a JSON decoder. */
export type RequestJsonDecodeFailure = {
  readonly cause?: unknown;
  readonly errors?: readonly RequestJsonValidationIssue[];
  readonly message?: string;
  readonly success: false;
};

/** Success or failure returned by a JSON decoder. */
export type RequestJsonDecodeResult<T> = RequestJsonDecodeFailure | RequestJsonDecodeSuccess<T>;

/** Converts an unknown JSON value into a typed decode result. */
export type RequestJsonDecoder<T> = (value: unknown) => RequestJsonDecodeResult<T>;

/** Validation details used by validation messages and error mappers. */
export type RequestJsonValidationReason = {
  readonly cause?: unknown;
  readonly errors: readonly RequestJsonValidationIssue[];
  readonly value: unknown;
};

/** Context supplied when an HTTP response has a 4xx or 5xx status. */
export type RequestJsonHttpErrorContext = {
  readonly body: string;
  readonly error: RequestError;
  readonly headers: RequestHeaders;
  readonly statusCode: number;
};

/** Context supplied when a successful response body is not valid JSON. */
export type RequestJsonInvalidJsonErrorContext = {
  readonly cause: Error;
  readonly error: RequestError;
};

/** Context supplied when the request promise rejects. */
export type RequestJsonRequestFailureContext = {
  readonly cause: Error;
  readonly error: RequestError;
};

/** Context supplied when decoded JSON does not satisfy the response contract. */
export type RequestJsonValidationErrorContext = RequestJsonValidationReason & {
  readonly error: RequestError;
  readonly message: string;
};

/** Discriminated context passed to request error handlers. */
export type RequestJsonErrorContext =
  | ({ readonly reason: "http" } & RequestJsonHttpErrorContext)
  | ({ readonly reason: "invalidJson" } & RequestJsonInvalidJsonErrorContext)
  | ({ readonly reason: "request" } & RequestJsonRequestFailureContext)
  | ({ readonly reason: "validation" } & RequestJsonValidationErrorContext);

/** Error context plus retry-attempt metadata. */
export type RequestJsonRetryContext =
  | (Extract<RequestJsonErrorContext, { readonly reason: "http" }> & ResultAsyncRetryContext)
  | (Extract<RequestJsonErrorContext, { readonly reason: "invalidJson" }> & ResultAsyncRetryContext)
  | (Extract<RequestJsonErrorContext, { readonly reason: "request" }> & ResultAsyncRetryContext)
  | (Extract<RequestJsonErrorContext, { readonly reason: "validation" }> & ResultAsyncRetryContext);

/** Retry policy for a request factory. */
export type RequestJsonRetry = {
  readonly delayMs?: number | ((context: ResultAsyncRetryContext) => number);
  readonly jittered?: number;
  readonly onRetry?: (context: RequestJsonRetryContext) => Promise<void> | void;
  readonly times: number;
  readonly when?: (context: RequestJsonRetryContext) => boolean | Promise<boolean>;
};

/** Maps each request failure category, and optionally HTTP statuses, to domain errors. */
export type RequestJsonMapError = Partial<
  Record<number, (context: RequestJsonHttpErrorContext) => Error>
> & {
  readonly http: (context: RequestJsonHttpErrorContext) => Error;
  readonly invalidJson: (context: RequestJsonInvalidJsonErrorContext) => Error;
  readonly request: (context: RequestJsonRequestFailureContext) => Error;
  readonly validation: (context: RequestJsonValidationErrorContext) => Error;
};

type RequestJsonStatusMapErrorResult<M extends RequestJsonMapError> = M[number] extends
  | ((context: RequestJsonHttpErrorContext) => infer E)
  | undefined
  ? E
  : never;

/** Union of every error returned by a `RequestJsonMapError` configuration. */
export type RequestJsonMapErrorResult<M extends RequestJsonMapError> =
  | ReturnType<M["http"]>
  | ReturnType<M["invalidJson"]>
  | ReturnType<M["request"]>
  | ReturnType<M["validation"]>
  | RequestJsonStatusMapErrorResult<M>;

/** Static or computed message used when response validation fails. */
export type RequestJsonValidationError = string | ((reason: RequestJsonValidationReason) => string);

/** Options shared by validator, decoder, and schema-adapter requests. */
export type RequestJsonBaseInput<R extends RequestJsonResponseData = RequestJsonResponseData> = {
  readonly mapError?: RequestJsonMapError;
  readonly request: RequestJsonSource<R>;
  readonly retry?: RequestJsonRetry;
  readonly validationError?: RequestJsonValidationError;
};

/** Request input that validates JSON with a decoder. */
export type RequestJsonDecodeInput<
  T,
  R extends RequestJsonResponseData = RequestJsonResponseData,
> = RequestJsonBaseInput<R> & {
  readonly decode: RequestJsonDecoder<T>;
  readonly validator?: never;
};

/** Request input that validates JSON with a type guard. */
export type RequestJsonValidatorInput<
  T,
  R extends RequestJsonResponseData = RequestJsonResponseData,
> = RequestJsonBaseInput<R> & {
  readonly decode?: never;
  readonly validator: RequestJsonValidator<T>;
};

/** Validator-based or decoder-based input accepted by `requestJson`. */
export type RequestJsonInput<T, R extends RequestJsonResponseData = RequestJsonResponseData> =
  | RequestJsonDecodeInput<T, R>
  | RequestJsonValidatorInput<T, R>;

/** Decoder input with an explicit domain-error mapping. */
export type RequestJsonMappedDecodeInput<
  T,
  M extends RequestJsonMapError,
  R extends RequestJsonResponseData = RequestJsonResponseData,
> = RequestJsonDecodeInput<T, R> & { readonly mapError: M };

/** Validator input with an explicit domain-error mapping. */
export type RequestJsonMappedValidatorInput<
  T,
  M extends RequestJsonMapError,
  R extends RequestJsonResponseData = RequestJsonResponseData,
> = RequestJsonValidatorInput<T, R> & { readonly mapError: M };

/** Mapped decoder or validator input accepted by `requestJson`. */
export type RequestJsonMappedInput<
  T,
  M extends RequestJsonMapError,
  R extends RequestJsonResponseData = RequestJsonResponseData,
> = RequestJsonMappedDecodeInput<T, M, R> | RequestJsonMappedValidatorInput<T, M, R>;
