import type { ResultAsync, ResultTask } from "resultar";
import type { z } from "zod";

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

/** Request input validated by a Zod schema. */
export type RequestJsonZodInput<
  S extends z.ZodType,
  R extends RequestJsonResponseData = RequestJsonResponseData,
> = RequestJsonBaseInput<R> & { readonly schema: S };

/** Zod request input with an explicit domain-error mapping. */
export type RequestJsonZodMappedInput<
  S extends z.ZodType,
  M extends RequestJsonMapError,
  R extends RequestJsonResponseData = RequestJsonResponseData,
> = RequestJsonZodInput<S, R> & { readonly mapError: M };

/** Lazy `ResultTask` request input validated by a Zod schema. */
export type RequestJsonZodTaskInput<
  S extends z.ZodType,
  R extends RequestJsonResponseData = RequestJsonResponseData,
> = RequestJsonTaskBaseInput<R> & { readonly schema: S };

/** Lazy `ResultTask` Zod request input with an explicit domain-error mapping. */
export type RequestJsonZodTaskMappedInput<
  S extends z.ZodType,
  M extends RequestJsonMapError,
  R extends RequestJsonResponseData = RequestJsonResponseData,
> = RequestJsonZodTaskInput<S, R> & { readonly mapError: M };

const toPath = (path: readonly PropertyKey[]) => path.map((part) => part);

const decodeWithZodSchema =
  <S extends z.ZodType>(schema: S) =>
  (value: unknown): RequestJsonDecodeResult<z.output<S>> => {
    const parsed = schema.safeParse(value);

    return parsed.success
      ? { success: true, value: parsed.data }
      : {
          cause: parsed.error,
          errors: parsed.error.issues.map((issue) => ({
            code: issue.code,
            message: issue.message,
            path: toPath(issue.path),
          })),
          success: false,
        };
  };

/**
 * Executes a JSON request and validates the decoded value with Zod.
 *
 * The Ok type preserves `z.output<S>`. Transport, HTTP, JSON, and validation failures use the core
 * `resultar-request` error channel or the supplied `mapError` handlers.
 */
export function requestJsonZod<
  S extends z.ZodType,
  M extends RequestJsonMapError,
  R extends RequestJsonResponseData = RequestJsonResponseData,
>(
  input: RequestJsonZodMappedInput<S, M, R>,
): ResultAsync<z.output<S>, RequestJsonMapErrorResult<M>>;
export function requestJsonZod<
  S extends z.ZodType,
  R extends RequestJsonResponseData = RequestJsonResponseData,
>(input: RequestJsonZodInput<S, R>): ResultAsync<z.output<S>, RequestError>;
export function requestJsonZod<
  S extends z.ZodType,
  R extends RequestJsonResponseData = RequestJsonResponseData,
>(input: RequestJsonZodInput<S, R>): ResultAsync<z.output<S>, Error> {
  return requestJsonCore({ ...input, decode: decodeWithZodSchema(input.schema) });
}

/**
 * Builds a lazy, repeatable `ResultTask` for a JSON request factory validated with Zod.
 *
 * The Ok type preserves `z.output<S>`. Transport, HTTP, JSON, and validation failures use the core
 * `resultar-request` error channel or the supplied `mapError` handlers, while cancellation and
 * retry delays use the Task runtime signal and clock.
 */
export function requestJsonZodTask<
  S extends z.ZodType,
  M extends RequestJsonMapError,
  R extends RequestJsonResponseData = RequestJsonResponseData,
>(
  input: RequestJsonZodTaskMappedInput<S, M, R>,
): ResultTask<z.output<S>, RequestJsonMapErrorResult<M>>;
export function requestJsonZodTask<
  S extends z.ZodType,
  R extends RequestJsonResponseData = RequestJsonResponseData,
>(input: RequestJsonZodTaskInput<S, R>): ResultTask<z.output<S>, RequestError>;
export function requestJsonZodTask<
  S extends z.ZodType,
  R extends RequestJsonResponseData = RequestJsonResponseData,
>(input: RequestJsonZodTaskInput<S, R>): ResultTask<z.output<S>, Error> {
  return requestJsonTaskCore({ ...input, decode: decodeWithZodSchema(input.schema) });
}
