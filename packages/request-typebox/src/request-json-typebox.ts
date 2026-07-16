import type { ResultAsync } from "resultar";
import type { Static, TSchema } from "typebox";
import Value from "typebox/value";

import {
  requestJson as requestJsonCore,
  type RequestJsonBaseInput,
  type RequestJsonMapError,
  type RequestJsonMapErrorResult,
  type RequestJsonResponseData,
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

const getTypeBoxErrors = (schema: TSchema, value: unknown) =>
  [...Value.Errors(schema, value)].map((error) => ({ message: error.message }));

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
  return requestJsonCore({
    ...input,
    decode: (value) =>
      Value.Check(input.schema, value)
        ? { success: true, value }
        : { errors: getTypeBoxErrors(input.schema, value), success: false },
  });
}
