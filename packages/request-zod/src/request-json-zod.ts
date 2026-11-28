import type { ResultTask } from "resultar";
import type { z } from "zod";

import {
  requestJson as requestJsonCore,
  type RequestError,
  type RequestJsonBaseInput,
  type RequestJsonDecodeResult,
  type RequestJsonMapErrorInput,
  type RequestJsonMapErrorResult,
  type RequestJsonResponseData,
} from "resultar-request";

/** Request input validated by a Zod schema. */
export type RequestJsonZodInput<
  S extends z.ZodType,
  R extends RequestJsonResponseData = RequestJsonResponseData,
> = RequestJsonBaseInput<R> & { readonly schema: S };

/** Zod request input with an explicit domain-error mapping. */
export type RequestJsonZodMappedInput<
  S extends z.ZodType,
  M extends RequestJsonMapErrorInput,
  R extends RequestJsonResponseData = RequestJsonResponseData,
> = RequestJsonZodInput<S, R> & { readonly mapError: M };

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
 * Builds a lazy, repeatable `ResultTask` for a JSON request factory validated with Zod.
 *
 * The Ok type preserves `z.output<S>`. Transport, HTTP, JSON, and validation failures use the core
 * `resultar-request` error channel or the supplied `mapError` handlers, while cancellation and
 * retry delays use the Task runtime signal and clock.
 */
export function requestJsonZod<
  S extends z.ZodType,
  M extends RequestJsonMapErrorInput,
  R extends RequestJsonResponseData = RequestJsonResponseData,
>(input: RequestJsonZodMappedInput<S, M, R>): ResultTask<z.output<S>, RequestJsonMapErrorResult<M>>;
export function requestJsonZod<
  S extends z.ZodType,
  R extends RequestJsonResponseData = RequestJsonResponseData,
>(input: RequestJsonZodInput<S, R>): ResultTask<z.output<S>, RequestError>;
export function requestJsonZod<
  S extends z.ZodType,
  R extends RequestJsonResponseData = RequestJsonResponseData,
>(input: RequestJsonZodInput<S, R>): ResultTask<z.output<S>, Error> {
  return requestJsonCore({ ...input, decode: decodeWithZodSchema(input.schema) });
}
