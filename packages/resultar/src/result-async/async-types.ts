import type { Result } from '../result/result.js'
import type { ResultAsync } from './result-async.js'
export type { ResultAsyncCatchReasonHandlers, ResultAsyncCatchTagHandlers } from './tagged-types.js'

// Given a list of ResultAsyncs, this extracts all the different `T` types from that list
export type ExtractOkAsyncTypes<T extends readonly ResultAsync<unknown, unknown>[]> = {
  [idx in keyof T]: T[idx] extends ResultAsync<infer U, unknown> ? U : never
}

// Given a list of ResultAsyncs, this extracts all the different `E` types from that list
export type ExtractErrAsyncTypes<T extends readonly ResultAsync<unknown, unknown>[]> = {
  [idx in keyof T]: T[idx] extends ResultAsync<unknown, infer E> ? E : never
}

export type InferAsyncOkTypes<R> = R extends ResultAsync<infer T, unknown> ? T : never
export type InferAsyncErrTypes<R> = R extends ResultAsync<unknown, infer E> ? E : never

/** Eager compatibility operations exposed on synchronous Results. */
export interface ResultAsyncOperations<T, E> {
  /**
   * Chains an async fallible operation from the Ok value.
   */
  asyncAndThen: <X, Y>(f: (t: T) => ResultAsync<X, Y>) => ResultAsync<X, E | Y>
  /**
   * Maps the Ok value with an async function and returns a `ResultAsync`.
   */
  asyncMap: <X>(f: (t: T) => Promise<X>) => ResultAsync<X, E>
}

export interface ResultAsyncAndThen {
  <T, E, U, F>(
    this: void,
    self: Result<T, E>,
    f: (value: T) => ResultAsync<U, F>,
  ): ResultAsync<U, E | F>
  <T, U, F>(
    this: void,
    f: (value: T) => ResultAsync<U, F>,
  ): <E>(self: Result<T, E>) => ResultAsync<U, E | F>
}

export interface ResultAsyncMap {
  <T, E, U>(this: void, self: Result<T, E>, f: (value: T) => Promise<U>): ResultAsync<U, E>
  <T, U>(this: void, f: (value: T) => Promise<U>): <E>(self: Result<T, E>) => ResultAsync<U, E>
}
