import type { ResultAsync, ResultTask } from "resultar";
import type { Static, TSchema } from "typebox";
import { Compile, type Validator } from "typebox/compile";
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

const compiledValidators = new WeakMap<TSchema, Validator>();
const uncompilableSchemas = new WeakSet<TSchema>();

const isJitDisabled = (): boolean => {
  try {
    const env = (
      globalThis as { readonly process?: { readonly env?: { readonly RESULTAR_JIT?: string } } }
    ).process?.env;
    const flag = env?.RESULTAR_JIT;
    return flag === "0" || flag === "false";
  } catch {
    return false;
  }
};

const getCompiledValidator = (schema: TSchema): Validator | undefined => {
  if (isJitDisabled() || uncompilableSchemas.has(schema)) {
    return undefined;
  }
  const cached = compiledValidators.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const validator = Compile(schema);
    compiledValidators.set(schema, validator);
    return validator;
  } catch {
    uncompilableSchemas.add(schema);
    return undefined;
  }
};

const getTypeBoxErrors = (schema: TSchema, value: unknown) =>
  [...Value.Errors(schema, value)].map((error) => ({
    code: error.keyword,
    message: error.message,
    path: error.instancePath,
  }));

const decodeWithTypeBoxSchema = <S extends TSchema>(schema: S) => {
  const validator = getCompiledValidator(schema);
  return (value: unknown): RequestJsonDecodeResult<Static<S>> => {
    const valid = validator === undefined ? Value.Check(schema, value) : validator.Check(value);
    return valid
      ? { success: true, value: value as Static<S> }
      : { errors: getTypeBoxErrors(schema, value), success: false };
  };
};

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
