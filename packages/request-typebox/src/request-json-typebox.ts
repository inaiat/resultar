import type { ResultAsync, ResultTask } from "resultar";
import type { Static, TSchema } from "typebox";
import Value from "typebox/value";

import {
  requestJson as requestJsonCore,
  requestJsonTask as requestJsonTaskCore,
  type RequestJsonBaseInput,
  type RequestJsonDecodeResult,
  type RequestJsonMapError,
  type RequestJsonMapErrorResult,
  type RequestJsonResponseData,
  type RequestJsonTaskBaseInput,
  type RequestError,
} from "resultar-request";

/** Request input validated by a TypeBox schema. */
export type RequestJsonTypeBoxInput<
  S extends TSchema,
  R extends RequestJsonResponseData = RequestJsonResponseData,
> = RequestJsonBaseInput<R> & { readonly schema: S };

/** TypeBox request input with an explicit domain-error mapping. */
export type RequestJsonTypeBoxMappedInput<
  S extends TSchema,
  M extends RequestJsonMapError,
  R extends RequestJsonResponseData = RequestJsonResponseData,
> = RequestJsonTypeBoxInput<S, R> & { readonly mapError: M };

/** Lazy `ResultTask` request input validated by a TypeBox schema. */
export type RequestJsonTypeBoxTaskInput<
  S extends TSchema,
  R extends RequestJsonResponseData = RequestJsonResponseData,
> = RequestJsonTaskBaseInput<R> & { readonly schema: S };

/** Lazy `ResultTask` TypeBox request input with an explicit domain-error mapping. */
export type RequestJsonTypeBoxTaskMappedInput<
  S extends TSchema,
  M extends RequestJsonMapError,
  R extends RequestJsonResponseData = RequestJsonResponseData,
> = RequestJsonTypeBoxTaskInput<S, R> & { readonly mapError: M };

const getTypeBoxErrors = (schema: TSchema, value: unknown) =>
  [...Value.Errors(schema, value)].map((error) => ({
    code: error.keyword,
    message: error.message,
    path: error.instancePath,
  }));

const decodeWithTypeBoxSchema =
  <S extends TSchema>(schema: S) =>
  (value: unknown): RequestJsonDecodeResult<Static<S>> =>
    Value.Check(schema, value)
      ? { success: true, value }
      : { errors: getTypeBoxErrors(schema, value), success: false };

/**
 * Executes a JSON request and validates the decoded value with TypeBox.
 *
 * The Ok type is inferred from `Static<S>`. Transport, HTTP, JSON, and validation failures use the
 * core `resultar-request` error channel or the supplied `mapError` handlers.
 */
export function requestJsonTypeBox<
  S extends TSchema,
  M extends RequestJsonMapError,
  R extends RequestJsonResponseData = RequestJsonResponseData,
>(
  input: RequestJsonTypeBoxMappedInput<S, M, R>,
): ResultAsync<Static<S>, RequestJsonMapErrorResult<M>>;
export function requestJsonTypeBox<
  S extends TSchema,
  R extends RequestJsonResponseData = RequestJsonResponseData,
>(input: RequestJsonTypeBoxInput<S, R>): ResultAsync<Static<S>, RequestError>;
export function requestJsonTypeBox<
  S extends TSchema,
  R extends RequestJsonResponseData = RequestJsonResponseData,
>(input: RequestJsonTypeBoxInput<S, R>): ResultAsync<Static<S>, Error> {
  return requestJsonCore({ ...input, decode: decodeWithTypeBoxSchema(input.schema) });
}

/**
 * Builds a lazy, repeatable `ResultTask` for a JSON request factory validated with TypeBox.
 *
 * The Ok type is inferred from `Static<S>`. Transport, HTTP, JSON, and validation failures use the
 * core `resultar-request` error channel or the supplied `mapError` handlers, while cancellation
 * and retry delays use the Task runtime signal and clock.
 */
export function requestJsonTypeBoxTask<
  S extends TSchema,
  M extends RequestJsonMapError,
  R extends RequestJsonResponseData = RequestJsonResponseData,
>(
  input: RequestJsonTypeBoxTaskMappedInput<S, M, R>,
): ResultTask<Static<S>, RequestJsonMapErrorResult<M>>;
export function requestJsonTypeBoxTask<
  S extends TSchema,
  R extends RequestJsonResponseData = RequestJsonResponseData,
>(input: RequestJsonTypeBoxTaskInput<S, R>): ResultTask<Static<S>, RequestError>;
export function requestJsonTypeBoxTask<
  S extends TSchema,
  R extends RequestJsonResponseData = RequestJsonResponseData,
>(input: RequestJsonTypeBoxTaskInput<S, R>): ResultTask<Static<S>, Error> {
  return requestJsonTaskCore({ ...input, decode: decodeWithTypeBoxSchema(input.schema) });
}
