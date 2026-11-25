import type { Result } from '../result/result.js'
import type { MatchErrorHandler, MatchOkHandler } from '../result/result-types.js'
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

/** Match handlers accepted by compatibility `ResultAsync` (`{ ok, err }` or legacy `{ ok, error }`). */
export type ResultAsyncMatchHandlers<T, E, A, B = A> =
  | { readonly err: MatchErrorHandler<E, B>; readonly ok: MatchOkHandler<T, A> }
  | { readonly error: MatchErrorHandler<E, B>; readonly ok: MatchOkHandler<T, A> }

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
