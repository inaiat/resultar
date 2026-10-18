import type { Result } from '../result/result.js'
import type { ResultTask } from '../task/result-task.js'
import type { InferErrTypes, InferOkTypes } from '../core/utils.js'
import type { ResultAsync } from './result-async.js'

export type { ResultGenerator, ResultGenOptions } from '../result/result-types.js'
export type { ResultAsyncAndThen, ResultAsyncMap } from './async-types.js'

/** Object-form synchronous generator workflow accepted by `safeTry`. */
export interface SafeTryOptions<
  YieldErr extends Result<never, unknown>,
  GeneratorReturnResult extends Result<unknown, unknown>,
  CatchErr = never,
> {
  /**
   * Generator body evaluated by `safeTry`.
   *
   * Use `yield* result` to unwrap Resultar values and short-circuit on Err.
   */
  readonly try: () => Generator<YieldErr, GeneratorReturnResult>
  /**
   * Converts synchronous throws from the generator setup into the Result error channel.
   */
  readonly catch?: (e: unknown) => CatchErr
}

/** Object-form asynchronous generator workflow accepted by `safeTry`. */
export interface SafeTryAsyncOptions<
  YieldErr extends Result<never, unknown>,
  GeneratorReturnResult extends Result<unknown, unknown>,
  CatchErr = never,
> {
  /**
   * Async generator body evaluated by `safeTry`.
   *
   * Use `yield* result` or `yield* resultAsync` to unwrap Resultar values and short-circuit on Err.
   */
  readonly try: () => AsyncGenerator<YieldErr, GeneratorReturnResult>
  /**
   * Converts synchronous throws or async rejections from the generator setup into the ResultAsync
   * error channel.
   */
  readonly catch?: (e: unknown) => CatchErr
}

/** Object-form asynchronous gen workflow, returning a plain success value. */
export interface AsyncResultGenOptions<
  YieldErr extends Result<never, unknown>,
  ReturnValue,
  CatchErr = never,
> {
  readonly try: () => AsyncGenerator<YieldErr, ReturnValue>
  readonly catch?: (e: unknown) => CatchErr
}

/** Generator return type annotation helper for asynchronous `gen`, `fn`, and composable sub-generators. */
export type ResultAsyncGenerator<T, E = never> = AsyncGenerator<Result<never, E>, T>

export type AsyncResultGenGuard<Returned> = [
  Extract<
    Returned,
    Result<unknown, unknown> | ResultAsync<unknown, unknown> | ResultTask<unknown, unknown, unknown>
  >,
] extends [never]
  ? unknown
  : never
export type AsyncResultFnOutput<Body extends (...args: never[]) => unknown> =
  ReturnType<Body> extends AsyncGenerator<infer Yielded, infer Returned>
    ? ResultAsync<Returned, InferErrTypes<Yielded>>
    : never

export type AsyncResultFnGuard<Body extends (...args: never[]) => unknown> =
  ReturnType<Body> extends AsyncGenerator<unknown, infer Returned>
    ? AsyncResultGenGuard<Returned>
    : never

export interface LegacySafeTry {
  <T, E, CatchErr = E>(
    input: SafeTryOptions<Result<never, E>, Result<T, E>, CatchErr> & {
      readonly catch: (e: unknown) => CatchErr
    },
  ): Result<T, E | CatchErr>
  <T, E>(
    input:
      | (() => Generator<Result<never, E>, Result<T, E>>)
      | SafeTryOptions<Result<never, E>, Result<T, E>>,
  ): Result<T, E>
  <
    YieldErr extends Result<never, unknown>,
    GeneratorReturnResult extends Result<unknown, unknown>,
    CatchErr,
  >(
    input: SafeTryOptions<YieldErr, GeneratorReturnResult, CatchErr> & {
      readonly catch: (e: unknown) => CatchErr
    },
  ): Result<
    InferOkTypes<GeneratorReturnResult>,
    InferErrTypes<YieldErr> | InferErrTypes<GeneratorReturnResult> | CatchErr
  >
  <YieldErr extends Result<never, unknown>, GeneratorReturnResult extends Result<unknown, unknown>>(
    input:
      | (() => Generator<YieldErr, GeneratorReturnResult>)
      | SafeTryOptions<YieldErr, GeneratorReturnResult>,
  ): Result<
    InferOkTypes<GeneratorReturnResult>,
    InferErrTypes<YieldErr> | InferErrTypes<GeneratorReturnResult>
  >
  <T, E, CatchErr = E>(
    input: SafeTryAsyncOptions<Result<never, E>, Result<T, E>, CatchErr> & {
      readonly catch: (e: unknown) => CatchErr
    },
  ): ResultAsync<T, E | CatchErr>
  <T, E>(
    input:
      | (() => AsyncGenerator<Result<never, E>, Result<T, E>>)
      | SafeTryAsyncOptions<Result<never, E>, Result<T, E>>,
  ): ResultAsync<T, E>
  <
    YieldErr extends Result<never, unknown>,
    GeneratorReturnResult extends Result<unknown, unknown>,
    CatchErr,
  >(
    input: SafeTryAsyncOptions<YieldErr, GeneratorReturnResult, CatchErr> & {
      readonly catch: (e: unknown) => CatchErr
    },
  ): ResultAsync<
    InferOkTypes<GeneratorReturnResult>,
    InferErrTypes<YieldErr> | InferErrTypes<GeneratorReturnResult> | CatchErr
  >
  <YieldErr extends Result<never, unknown>, GeneratorReturnResult extends Result<unknown, unknown>>(
    input:
      | (() => AsyncGenerator<YieldErr, GeneratorReturnResult>)
      | SafeTryAsyncOptions<YieldErr, GeneratorReturnResult>,
  ): ResultAsync<
    InferOkTypes<GeneratorReturnResult>,
    InferErrTypes<YieldErr> | InferErrTypes<GeneratorReturnResult>
  >
}
