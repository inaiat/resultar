import type { ResultAsyncRetryContext } from "resultar";

import type { RequestError } from "./request-json.js";

export type RequestHeaders = unknown;

export type FetchJsonResponseData = {
  readonly headers?: RequestHeaders;
  readonly json: () => Promise<unknown>;
  readonly status: number;
  readonly text: () => Promise<string>;
};

export type UndiciJsonResponseData = {
  readonly body: { readonly json: () => Promise<unknown>; readonly text: () => Promise<string> };
  readonly headers?: RequestHeaders;
  readonly statusCode: number;
};

export type RequestJsonResponseData = FetchJsonResponseData | UndiciJsonResponseData;

export type RequestJsonSource<R extends RequestJsonResponseData = RequestJsonResponseData> =
  | Promise<R>
  | (() => Promise<R>);

export type RequestJsonValidator<T> = (value: unknown) => value is T;

export type RequestJsonValidationIssue = {
  readonly code?: string;
  readonly message: string;
  readonly path?: readonly PropertyKey[] | string;
};

export type RequestJsonDecodeSuccess<T> = { readonly success: true; readonly value: T };

export type RequestJsonDecodeFailure = {
  readonly cause?: unknown;
  readonly errors?: readonly RequestJsonValidationIssue[];
  readonly message?: string;
  readonly success: false;
};

export type RequestJsonDecodeResult<T> = RequestJsonDecodeFailure | RequestJsonDecodeSuccess<T>;

export type RequestJsonDecoder<T> = (value: unknown) => RequestJsonDecodeResult<T>;

export type RequestJsonValidationReason = {
  readonly cause?: unknown;
  readonly errors: readonly RequestJsonValidationIssue[];
  readonly value: unknown;
};

export type RequestJsonHttpErrorContext = {
  readonly body: string;
  readonly error: RequestError;
  readonly headers: RequestHeaders;
  readonly statusCode: number;
};

export type RequestJsonInvalidJsonErrorContext = {
  readonly cause: Error;
  readonly error: RequestError;
};

export type RequestJsonRequestFailureContext = {
  readonly cause: Error;
  readonly error: RequestError;
};

export type RequestJsonValidationErrorContext = RequestJsonValidationReason & {
  readonly error: RequestError;
  readonly message: string;
};

export type RequestJsonErrorContext =
  | ({ readonly reason: "http" } & RequestJsonHttpErrorContext)
  | ({ readonly reason: "invalidJson" } & RequestJsonInvalidJsonErrorContext)
  | ({ readonly reason: "request" } & RequestJsonRequestFailureContext)
  | ({ readonly reason: "validation" } & RequestJsonValidationErrorContext);

export type RequestJsonRetryContext =
  | (Extract<RequestJsonErrorContext, { readonly reason: "http" }> & ResultAsyncRetryContext)
  | (Extract<RequestJsonErrorContext, { readonly reason: "invalidJson" }> & ResultAsyncRetryContext)
  | (Extract<RequestJsonErrorContext, { readonly reason: "request" }> & ResultAsyncRetryContext)
  | (Extract<RequestJsonErrorContext, { readonly reason: "validation" }> & ResultAsyncRetryContext);

export type RequestJsonRetry = {
  readonly delayMs?: number | ((context: ResultAsyncRetryContext) => number);
  readonly jittered?: number;
  readonly onRetry?: (context: RequestJsonRetryContext) => Promise<void> | void;
  readonly times: number;
  readonly when?: (context: RequestJsonRetryContext) => boolean | Promise<boolean>;
};

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

export type RequestJsonMapErrorResult<M extends RequestJsonMapError> =
  | ReturnType<M["http"]>
  | ReturnType<M["invalidJson"]>
  | ReturnType<M["request"]>
  | ReturnType<M["validation"]>
  | RequestJsonStatusMapErrorResult<M>;

export type RequestJsonValidationError = string | ((reason: RequestJsonValidationReason) => string);

export type RequestJsonBaseInput<R extends RequestJsonResponseData = RequestJsonResponseData> = {
  readonly mapError?: RequestJsonMapError;
  readonly request: RequestJsonSource<R>;
  readonly retry?: RequestJsonRetry;
  readonly validationError?: RequestJsonValidationError;
};

export type RequestJsonDecodeInput<
  T,
  R extends RequestJsonResponseData = RequestJsonResponseData,
> = RequestJsonBaseInput<R> & {
  readonly decode: RequestJsonDecoder<T>;
  readonly validator?: never;
};

export type RequestJsonValidatorInput<
  T,
  R extends RequestJsonResponseData = RequestJsonResponseData,
> = RequestJsonBaseInput<R> & {
  readonly decode?: never;
  readonly validator: RequestJsonValidator<T>;
};

export type RequestJsonInput<T, R extends RequestJsonResponseData = RequestJsonResponseData> =
  | RequestJsonDecodeInput<T, R>
  | RequestJsonValidatorInput<T, R>;

export type RequestJsonMappedDecodeInput<
  T,
  M extends RequestJsonMapError,
  R extends RequestJsonResponseData = RequestJsonResponseData,
> = RequestJsonDecodeInput<T, R> & { readonly mapError: M };

export type RequestJsonMappedValidatorInput<
  T,
  M extends RequestJsonMapError,
  R extends RequestJsonResponseData = RequestJsonResponseData,
> = RequestJsonValidatorInput<T, R> & { readonly mapError: M };

export type RequestJsonMappedInput<
  T,
  M extends RequestJsonMapError,
  R extends RequestJsonResponseData = RequestJsonResponseData,
> = RequestJsonMappedDecodeInput<T, M, R> | RequestJsonMappedValidatorInput<T, M, R>;
