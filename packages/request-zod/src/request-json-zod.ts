import type { ResultAsync } from "resultar";
import type { z } from "zod";

import {
  requestJson as requestJsonCore,
  type RequestJsonBaseInput,
  type RequestJsonMapError,
  type RequestJsonMapErrorResult,
  type RequestJsonResponseData,
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

const toPath = (path: readonly PropertyKey[]) => path.map((part) => part);

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
  return requestJsonCore({
    ...input,
    decode: (value) => {
      const parsed = input.schema.safeParse(value);

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
    },
  });
}
