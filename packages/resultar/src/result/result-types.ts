import type { ErrorConfig } from '../core/error.js'
import type { PipeFn } from '../core/pipe.js'
import type { ExtractErrTypes, ExtractOkTypes, InferErrTypes, InferOkTypes } from '../core/utils.js'
import type {
  CatchReasonHandlerResult,
  CatchTagHandlerResult,
  CoveredHandlerKeys,
  ErrorForTag,
  ExcludeReasonTag,
  ExcludeTag,
  MatchTagHandlerResult,
  MatchTagHandlers,
  PartialMatchTagHandlers,
  ReasonForTag,
  ReasonTagsOf,
  ReasonsOf,
  RemainingMatchTagErrors,
  ResultCatchReasonHandlers as CatchReasonHandlers,
  ResultCatchTagHandlers as CatchTagHandlers,
  TagsOf,
  TagsWithReasonOf,
} from '../tagged/tagged-types.js'
import type { ResultAsyncOperations } from '../result-async/async-types.js'
import type { AsyncResultFnGuard, AsyncResultFnOutput } from '../result-async/generator-types.js'
import type { ResultTask } from '../task/result-task.js'
import type { Result } from './result.js'
import type { DisposableResult } from './result-helpers.js'

export type ResultFinalizer<T, E> = (value: T | undefined, error: E | undefined) => void
export type MatchOkHandler<T, A> = (value: T) => A
export type MatchErrorHandler<E, B> = (error: E) => B
export type ResultCandidate = () => Result<unknown, unknown>
export type ResultRecord = Readonly<Record<string, Result<unknown, unknown>>>
export type CombineResultsRecord<T extends ResultRecord> = Result<
  { readonly [Key in keyof T]: InferOkTypes<T[Key]> },
  InferErrTypes<T[keyof T]>
>
export type CombineResultsRecordWithAllErrors<T extends ResultRecord> = Result<
  { readonly [Key in keyof T]: InferOkTypes<T[Key]> },
  InferErrTypes<T[keyof T]>[]
>
export type CombineResultsIterable<R extends Result<unknown, unknown>> = Result<
  readonly InferOkTypes<R>[],
  InferErrTypes<R>
>
export type CombineResultsIterableWithAllErrors<R extends Result<unknown, unknown>> = Result<
  readonly InferOkTypes<R>[],
  InferErrTypes<R>[]
>
export type ResultLoopCollected<R extends Result<unknown, unknown>> = Result<
  readonly InferOkTypes<R>[],
  InferErrTypes<R>
>
export type ResultLoopDiscarded<R extends Result<unknown, unknown>> = Result<void, InferErrTypes<R>>
export type ResultIterated<State, R extends Result<State, unknown>> = Result<
  State,
  InferErrTypes<R>
>
export type ResultForEachCollected<R extends Result<unknown, unknown>> = Result<
  readonly InferOkTypes<R>[],
  InferErrTypes<R>
>
export type ResultForEachDiscarded<R extends Result<unknown, unknown>> = Result<
  void,
  InferErrTypes<R>
>
export type ResultValidatedAll<R extends Result<unknown, unknown>> = Result<
  readonly InferOkTypes<R>[],
  InferErrTypes<R>[]
>
export type ResultZipped<
  Left extends Result<unknown, unknown>,
  Right extends Result<unknown, unknown>,
> = Result<[InferOkTypes<Left>, InferOkTypes<Right>], InferErrTypes<Left> | InferErrTypes<Right>>
export type ResultBooleanCondition = boolean | (() => boolean)
export type ResultCondition<E = unknown> =
  | ResultBooleanCondition
  | Result<boolean, E>
  | (() => Result<boolean, E>)
export type ResultConditionError<Condition> = Condition extends () => infer Value
  ? InferErrTypes<Value>
  : InferErrTypes<Condition>
export type ResultIf<
  ConditionErr,
  OnTrue extends Result<unknown, unknown>,
  OnFalse extends Result<unknown, unknown>,
> = Result<
  InferOkTypes<OnTrue> | InferOkTypes<OnFalse>,
  ConditionErr | InferErrTypes<OnTrue> | InferErrTypes<OnFalse>
>
export type ResultWhen<R extends Result<unknown, unknown>, ConditionErr = never> = Result<
  InferOkTypes<R> | undefined,
  ConditionErr | InferErrTypes<R>
>
export type ResultWhenWithCondition<
  Condition extends Result<boolean, unknown>,
  R extends Result<unknown, unknown>,
> = ResultWhen<R, InferErrTypes<Condition>>
export type WidenLiteral<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends bigint
        ? bigint
        : T

export type MatchHandlers<T, E, A, B = A> =
  | { readonly err: MatchErrorHandler<E, B>; readonly ok: MatchOkHandler<T, A> }
  | { readonly error: MatchErrorHandler<E, B>; readonly ok: MatchOkHandler<T, A> }

export type FirstSuccessOf<Candidates extends Iterable<ResultCandidate>> = Result<
  InferOkTypes<ReturnType<IterableElement<Candidates>>>,
  InferErrTypes<ReturnType<IterableElement<Candidates>>>
>

type IterableElement<T> = T extends Iterable<infer Element> ? Element : never

export interface ResultLoopOptions<
  State,
  BodyState extends State,
  R extends Result<unknown, unknown>,
> {
  readonly body: (state: BodyState) => R
  readonly discard?: false
  readonly step: (state: BodyState) => State
  readonly while: (state: State) => state is BodyState
}

export interface ResultLoopBooleanOptions<State, R extends Result<unknown, unknown>> {
  readonly body: (state: State) => R
  readonly discard?: false
  readonly step: (state: State) => State
  readonly while: (state: State) => boolean
}

export interface ResultLoopDiscardOptions<
  State,
  BodyState extends State,
  R extends Result<unknown, unknown>,
> {
  readonly body: (state: BodyState) => R
  readonly discard: true
  readonly step: (state: BodyState) => State
  readonly while: (state: State) => state is BodyState
}

export interface ResultLoopBooleanDiscardOptions<State, R extends Result<unknown, unknown>> {
  readonly body: (state: State) => R
  readonly discard: true
  readonly step: (state: State) => State
  readonly while: (state: State) => boolean
}

export interface ResultLoopRuntimeOptions<State, R extends Result<unknown, unknown>> {
  readonly body: (state: State) => R
  readonly discard?: boolean
  readonly step: (state: State) => State
  readonly while: (state: State) => boolean
}

export interface ResultIterateOptions<
  State,
  BodyState extends State,
  R extends Result<State, unknown>,
> {
  readonly body: (state: BodyState) => R
  readonly while: (state: State) => state is BodyState
}

export interface ResultIterateBooleanOptions<State, R extends Result<State, unknown>> {
  readonly body: (state: State) => R
  readonly while: (state: State) => boolean
}

export interface ResultIterateRuntimeOptions<State, R extends Result<State, unknown>> {
  readonly body: (state: State) => R
  readonly while: (state: State) => boolean
}

export interface ResultForEachOptions {
  readonly discard?: false
}

export interface ResultForEachDiscardOptions {
  readonly discard: true
}

export interface ResultForEachRuntimeOptions {
  readonly discard?: boolean
}

export interface ResultIfOptions<
  OnTrue extends Result<unknown, unknown>,
  OnFalse extends Result<unknown, unknown>,
> {
  readonly onFalse: () => OnFalse
  readonly onTrue: () => OnTrue
}

/**
 * A Result interface that is used to define the methods that are available on a
 * `Result` object.
 *
 * The immutability of the `Result` object is maintained by the interface.
 */
export interface Resultable<T, E> {
  get value(): T
  get error(): E

  /**
   * Used to check if a `Result` is an `OK`
   *
   * @returns `true` if the result is an `OK` variant of Result
   */
  isOk: () => boolean

  /**
   * Used to check if a `Result` is an `Err`
   *
   * @returns `true` if the result is an `Err` variant of Result
   */
  isErr: () => boolean
  /**
   * Unwrap the `Ok` value, or return the default if there is an `Err`
   *
   * @param v the default value to return if there is an `Err`
   */

  unwrapOr: <A>(defaultValue: A) => T | A

  /**
   * **This method is unsafe, and should only be used in a test environments**
   *
   * Takes a `Result<T, E>` and returns a `T` when the result is an `Ok`, otherwise it throws a custom object.
   *
   * @param config
   */
  _unsafeUnwrap: (config?: ErrorConfig) => T

  /**
   * **This method is unsafe, and should only be used in a test environments**
   *
   * takes a `Result<T, E>` and returns a `E` when the result is an `Err`,
   * otherwise it throws a custom object.
   *
   * @param config
   */
  _unsafeUnwrapErr: (config?: ErrorConfig) => E
}

/** Operations shared by the Ok and Err variants of `Result<T, E>`. */
export interface ResultOperations<T, E> extends ResultAsyncOperations<T, E> {
  /**
   * Narrows this result to the Ok variant.
   */
  isOk: () => this is OkResult<T, E>
  /**
   * Narrows this result to the Err variant.
   */
  isErr: () => this is ErrResult<T, E>
  /**
   * Returns the Ok value, or `defaultValue` when this result is Err.
   */
  unwrapOr: <A>(defaultValue: A) => T | A
  /**
   * Returns the Ok value or throws a Resultar diagnostic error when this result is Err.
   *
   * Prefer `match`, `unwrapOr`, or explicit error handling in application code. This helper is
   * intended for tests and trusted final boundaries.
   */
  _unsafeUnwrap: (config?: ErrorConfig) => T
  /**
   * Returns the Err value or throws a Resultar diagnostic error when this result is Ok.
   *
   * Prefer `match`, `isErr`, or explicit error handling in application code. This helper is intended
   * for tests.
   */
  _unsafeUnwrapErr: (config?: ErrorConfig) => E
  /**
   * Maps the Ok value while preserving the error channel.
   */
  map: <X>(f: (t: T) => X) => Result<X, E>
  /**
   * Replaces the Ok value with a constant while preserving the error channel.
   */
  as: <X>(value: X) => Result<X, E>
  /**
   * Replaces the Ok value with `undefined` (`void`) while preserving the error channel.
   */
  asVoid: () => Result<void, E>
  /**
   * Keeps the Ok value only when the predicate passes; otherwise returns an Err from `onFalse`.
   */
  filterOrElse: {
    <U extends T, F>(
      predicate: (value: T) => value is U,
      onFalse: (value: T) => F,
    ): Result<U, E | F>
    <F>(predicate: (value: T) => boolean, onFalse: (value: T) => F): Result<T, E | F>
  }
  /**
   * Maps the Err value while preserving the Ok value.
   */
  mapErr: <X>(fn: (t: E) => X) => Result<T, X>
  /**
   * Chains another fallible operation from the Ok value.
   *
   * Use this instead of `map` when the callback returns another `Result`.
   */
  andThen: <X, Y>(f: (t: T) => Result<X, Y>) => Result<X, E | Y>
  /**
   * Branches from the Ok value into one of two fallible Result branches.
   */
  if: (fCondition: (t: T) => boolean) => {
    true: <X1, Y1>(
      fTrue: (t: T) => Result<X1, Y1>,
    ) => { false: <X2, Y2>(fFalse: (t: T) => Result<X2, Y2>) => Result<X1 | X2, Y1 | Y2 | E> }
  }
  /**
   * Keeps this Result only when `condition` resolves to `true`; otherwise returns `Ok(undefined)`.
   */
  when: <Condition extends ResultCondition>(
    condition: Condition,
  ) => Result<T | undefined, E | ResultConditionError<Condition>>
  /**
   * Keeps this Result only when `condition` resolves to `false`; otherwise returns `Ok(undefined)`.
   */
  unless: <Condition extends ResultCondition>(
    condition: Condition,
  ) => Result<T | undefined, E | ResultConditionError<Condition>>
  /**
   * Recovers from Err with another Result.
   */
  orElse: <R extends Result<unknown, unknown>>(
    f: (e: E) => R,
  ) => Result<InferOkTypes<R> | T, InferErrTypes<R>>
  /**
   * Recovers from Err with a plain success value.
   */
  orElseSucceed: <A>(f: (e: E) => A) => Result<T | A, never>
  /**
   * Recovers from a specific tagged error by `_tag`.
   */
  catchTag: <const Tag extends TagsOf<E>, R extends Result<unknown, unknown>>(
    tag: Tag,
    f: (error: ErrorForTag<E, Tag>) => R,
  ) => Result<T | InferOkTypes<R>, ExcludeTag<E, Tag> | InferErrTypes<R>>
  /**
   * Recovers from multiple tagged errors by `_tag`.
   */
  catchTags: <const Handlers extends object>(
    handlers: Handlers & CatchTagHandlers<E, Handlers>,
  ) => Result<
    T | InferOkTypes<CatchTagHandlerResult<Handlers>>,
    | ExcludeTag<E, CoveredHandlerKeys<Handlers> & string>
    | InferErrTypes<CatchTagHandlerResult<Handlers>>
  >
  /**
   * Recovers from a nested tagged `reason` on a specific tagged error.
   */
  catchReason: <
    const ErrorTag extends TagsWithReasonOf<E>,
    const ReasonTag extends ReasonTagsOf<E, ErrorTag>,
    R extends Result<unknown, unknown>,
  >(
    errorTag: ErrorTag,
    reasonTag: ReasonTag,
    f: (reason: ReasonForTag<E, ErrorTag, ReasonTag>, error: ErrorForTag<E, ErrorTag>) => R,
  ) => Result<T | InferOkTypes<R>, ExcludeReasonTag<E, ErrorTag, ReasonTag> | InferErrTypes<R>>
  /**
   * Recovers from multiple nested tagged `reason` variants on a specific tagged error.
   */
  catchReasons: <const ErrorTag extends TagsWithReasonOf<E>, const Handlers extends object>(
    errorTag: ErrorTag,
    handlers: Handlers & CatchReasonHandlers<E, ErrorTag, Handlers>,
  ) => Result<
    T | InferOkTypes<CatchReasonHandlerResult<Handlers>>,
    | ExcludeReasonTag<E, ErrorTag, CoveredHandlerKeys<Handlers> & string>
    | InferErrTypes<CatchReasonHandlerResult<Handlers>>
  >
  /**
   * Moves the nested `reason` of a tagged error into the Result error channel.
   */
  unwrapReason: <const ErrorTag extends TagsWithReasonOf<E>>(
    errorTag: ErrorTag,
  ) => Result<T, ExcludeTag<E, ErrorTag> | ReasonsOf<E, ErrorTag>>
  /**
   * Converts this Result into a plain value by handling both Ok and Err.
   */
  match: {
    <A, B = A>(handlers: MatchHandlers<T, E, A, B>): A | B
    <A, B = A>(fnOk: MatchOkHandler<T, A>, fnErr: MatchErrorHandler<E, B>): A | B
  }
  /**
   * Converts this Result into a plain value with exhaustive tagged-error handlers.
   */
  matchTags: <A, const Handlers extends object>(
    fnOk: (t: T) => A,
    handlers: Handlers & MatchTagHandlers<E, Handlers>,
  ) => A | MatchTagHandlerResult<Handlers>
  /**
   * Converts this Result into a plain value with partial tagged-error handlers and a fallback.
   */
  matchTagsPartial: <A, B, const Handlers extends object>(
    fnOk: (t: T) => A,
    handlers: Handlers & PartialMatchTagHandlers<E, Handlers>,
    fallback: (error: E) => B,
  ) => A | MatchTagHandlerResult<Handlers> | B
  /**
   * Pipes this Result through reusable transformation functions.
   */
  pipe: {
    <Self>(this: Self): Self
    <P1>(f0: PipeFn<Result<T, E>, P1>): P1
    <P1, P2>(f0: PipeFn<Result<T, E>, P1>, f1: PipeFn<P1, P2>): P2
    <P1, P2, P3>(f0: PipeFn<Result<T, E>, P1>, f1: PipeFn<P1, P2>, f2: PipeFn<P2, P3>): P3
    <P1, P2, P3, P4>(
      f0: PipeFn<Result<T, E>, P1>,
      f1: PipeFn<P1, P2>,
      f2: PipeFn<P2, P3>,
      f3: PipeFn<P3, P4>,
    ): P4
    <P1, P2, P3, P4, P5>(
      f0: PipeFn<Result<T, E>, P1>,
      f1: PipeFn<P1, P2>,
      f2: PipeFn<P2, P3>,
      f3: PipeFn<P3, P4>,
      f4: PipeFn<P4, P5>,
    ): P5
    <P1, P2, P3, P4, P5, P6>(
      f0: PipeFn<Result<T, E>, P1>,
      f1: PipeFn<P1, P2>,
      f2: PipeFn<P2, P3>,
      f3: PipeFn<P3, P4>,
      f4: PipeFn<P4, P5>,
      f5: PipeFn<P5, P6>,
    ): P6
    <P1, P2, P3, P4, P5, P6, P7>(
      f0: PipeFn<Result<T, E>, P1>,
      f1: PipeFn<P1, P2>,
      f2: PipeFn<P2, P3>,
      f3: PipeFn<P3, P4>,
      f4: PipeFn<P4, P5>,
      f5: PipeFn<P5, P6>,
      f6: PipeFn<P6, P7>,
    ): P7
    <P1, P2, P3, P4, P5, P6, P7, P8>(
      f0: PipeFn<Result<T, E>, P1>,
      f1: PipeFn<P1, P2>,
      f2: PipeFn<P2, P3>,
      f3: PipeFn<P3, P4>,
      f4: PipeFn<P4, P5>,
      f5: PipeFn<P5, P6>,
      f6: PipeFn<P6, P7>,
      f7: PipeFn<P7, P8>,
    ): P8
  }
  /**
   * Runs a side effect with the Ok or Err value and returns this same Result.
   *
   * Exceptions thrown by the side effect are swallowed.
   */
  log: (fn: (t?: T, e?: E) => void) => this
  /**
   * Runs a side effect only when this result is Ok and returns this same Result.
   *
   * Exceptions thrown by the side effect are swallowed.
   */
  inspect: (fn: (t: T) => void) => this
  /** @deprecated Use inspect; callback failures remain best-effort. */
  tap: (fn: (t: T) => void) => this
  /**
   * Runs a side effect only when this result is Err and returns this same Result.
   *
   * Exceptions thrown by the side effect are swallowed.
   */
  inspectError: (fn: (e: E) => void) => this
  /** @deprecated Use inspectError; callback failures remain best-effort. */
  tapError: (fn: (e: E) => void) => this
  /**
   * Runs a side effect for either variant and returns this same Result.
   *
   * Exceptions thrown by the side effect are swallowed.
   */
  inspectBoth: {
    <Self>(this: Self, handlers: MatchHandlers<T, E, void, void>): Self
    <Self>(this: Self, fnOk: (t: T) => void, fnErr: (e: E) => void): Self
  }
  /**
   * Attaches a synchronous disposal finalizer to this Result.
   */
  toDisposable: (f: ResultFinalizer<T, E>) => DisposableResult<T, E>
  /**
   * Returns the Ok value or throws the Err value.
   *
   * Use this at final application boundaries after the error channel has been modeled.
   */
  unwrapOrThrow: () => T
  /**
   * Enables `yield* result` inside `safeTry` generators.
   */
  [Symbol.iterator]: () => Generator<Result<never, E>, T>
  /**
   * Compatibility generator for `safeTry`. Prefer `yield* result` in new code.
   * @deprecated Use `yield* result` inside Result.gen.
   */
  safeUnwrap: () => Generator<Result<never, E>, T>
}

/** Successful `Result` variant carrying a value of type `T`. */
export interface OkResult<T, E> extends ResultOperations<T, E> {
  /**
   * Ok value carried by this result.
   */
  readonly value: T
}

/** Failed `Result` variant carrying an error of type `E`. */
export interface ErrResult<T, E> extends ResultOperations<T, E> {
  /**
   * Err value carried by this result.
   */
  readonly error: E
}

/** `Result` convention that restricts the error channel to real `Error` instances. */
export type StrictResult<T, E extends Error = Error> = Result<T, E>

/**
 * Object form accepted by `tryResult`.
 *
 * Use this form when named `try` and `catch` fields make a synchronous boundary easier to read.
 */
export interface TryResultOptions<T, E = unknown> {
  /**
   * Runs the synchronous work whose thrown value should become `Err<E>`.
   */
  readonly try: () => Exclude<T, Promise<unknown>>
  /**
   * Converts a thrown `unknown` cause into the typed Resultar error channel.
   *
   * If omitted, the error channel is `unknown`.
   */
  readonly catch?: (e: unknown) => E
}

/** Object-form synchronous Result.gen workflow, returning a plain success value. */
export interface ResultGenOptions<
  YieldErr extends Result<never, unknown>,
  ReturnValue,
  CatchErr = never,
> {
  readonly try: () => Generator<YieldErr, ReturnValue>
  readonly catch?: (e: unknown) => CatchErr
}

/** Generator return type annotation helper for synchronous `Result.gen`, `Result.fn`, and composable sub-generators. */
export type ResultGenerator<T, E = never> = Generator<Result<never, E>, T>

export type SyncResultGenGuard<Returned> = [
  Extract<
    Returned,
    | Result<unknown, unknown>
    | { readonly then: (...args: never[]) => unknown }
    | ResultTask<unknown, unknown, unknown>
  >,
] extends [never]
  ? unknown
  : never
export type ResultGeneratorReturn<GeneratorValue> = GeneratorValue extends
  | Generator<unknown, infer Returned>
  | AsyncGenerator<unknown, infer Returned>
  ? Returned
  : never
export type ResultGeneratorError<GeneratorValue> = GeneratorValue extends
  | Generator<infer Yielded, unknown>
  | AsyncGenerator<infer Yielded, unknown>
  ? InferErrTypes<Yielded>
  : never
export type ResultGeneratorCatch<Input> = Input extends unknown
  ? 'catch' extends keyof Input
    ? Input extends { readonly catch?: (e: unknown) => infer CatchErr }
      ? CatchErr
      : never
    : never
  : never
export type ResultFnBody =
  | ((...args: never[]) => Generator<Result<never, unknown>, unknown>)
  | ((...args: never[]) => AsyncGenerator<Result<never, unknown>, unknown>)
export type ResultFnOutput<Body extends (...args: never[]) => unknown> =
  ReturnType<Body> extends Generator<infer Yielded, infer Returned>
    ? Result<Returned, InferErrTypes<Yielded>>
    : AsyncResultFnOutput<Body>
export type ResultFnGuard<Body extends (...args: never[]) => unknown> =
  ReturnType<Body> extends Generator<unknown, infer Returned>
    ? SyncResultGenGuard<Returned>
    : AsyncResultFnGuard<Body>

export interface ResultFromNullishOr {
  <T, E>(this: void, value: T, onNullish: (value: T) => E): Result<NonNullable<T>, E>
  <T, E>(
    this: void,
    onNullish: (value: T) => E,
  ): <A extends T>(value: A) => Result<NonNullable<A>, E>
}

export interface ResultLiftPredicate {
  <T, U extends T, E>(
    this: void,
    value: T,
    refinement: (value: T) => value is U,
    onFalse: (value: T) => E,
  ): Result<U, E>
  <T, E>(
    this: void,
    value: T,
    predicate: (value: T) => boolean,
    onFalse: (value: T) => E,
  ): Result<T, E>
  <T, U extends T, E>(
    this: void,
    refinement: (value: T) => value is U,
    onFalse: (value: T) => E,
  ): <A extends T>(value: A) => Result<A & U, E>
  <T, E>(
    this: void,
    predicate: (value: T) => boolean,
    onFalse: (value: T) => E,
  ): <A extends T>(value: A) => Result<A, E>
}

export interface ResultMap {
  <T, E, U>(this: void, self: Result<T, E>, f: (value: T) => U): Result<U, E>
  <T, U>(this: void, f: (value: T) => U): <E>(self: Result<T, E>) => Result<U, E>
}

export interface ResultMapErr {
  <T, E, F>(this: void, self: Result<T, E>, f: (error: E) => F): Result<T, F>
  <E, F>(this: void, f: (error: E) => F): <T>(self: Result<T, E>) => Result<T, F>
}

export interface ResultAndThen {
  <T, E, U, F>(this: void, self: Result<T, E>, f: (value: T) => Result<U, F>): Result<U, E | F>
  <T, U, F>(this: void, f: (value: T) => Result<U, F>): <E>(self: Result<T, E>) => Result<U, E | F>
}

export interface ResultOrElse {
  <T, E, R extends Result<unknown, unknown>>(
    this: void,
    self: Result<T, E>,
    f: (error: E) => R,
  ): Result<T | InferOkTypes<R>, InferErrTypes<R>>
  <E, R extends Result<unknown, unknown>>(
    this: void,
    f: (error: E) => R,
  ): <T>(self: Result<T, E>) => Result<T | InferOkTypes<R>, InferErrTypes<R>>
}

export interface ResultOrElseSucceed {
  <T, E, A>(this: void, self: Result<T, E>, f: (error: E) => A): Result<T | A, never>
  <E, A>(this: void, f: (error: E) => A): <T>(self: Result<T, E>) => Result<T | A, never>
}

export interface ResultUnwrapOr {
  <T, E, A>(this: void, self: Result<T, E>, defaultValue: A): T | A
  <A>(this: void, defaultValue: A): <T, E>(self: Result<T, E>) => T | A
}

export interface ResultInspect {
  <T, E>(this: void, self: Result<T, E>, f: (value: T) => void): Result<T, E>
  <T>(this: void, f: (value: T) => void): <E>(self: Result<T, E>) => Result<T, E>
}

export interface ResultInspectError {
  <T, E>(this: void, self: Result<T, E>, f: (error: E) => void): Result<T, E>
  <E>(this: void, f: (error: E) => void): <T>(self: Result<T, E>) => Result<T, E>
}

export interface ResultInspectBoth {
  <T, E>(this: void, self: Result<T, E>, handlers: MatchHandlers<T, E, void, void>): Result<T, E>
  <T, E>(
    this: void,
    self: Result<T, E>,
    fnOk: (value: T) => void,
    fnErr: (error: E) => void,
  ): Result<T, E>
  <T, E>(
    this: void,
    handlers: MatchHandlers<T, E, void, void>,
  ): (self: Result<T, E>) => Result<T, E>
  <T, E>(
    this: void,
    fnOk: (value: T) => void,
    fnErr: (error: E) => void,
  ): (self: Result<T, E>) => Result<T, E>
}

export interface ResultMatch {
  <T, E, A, B = A>(this: void, self: Result<T, E>, handlers: MatchHandlers<T, E, A, B>): A | B
  <T, E, A, B = A>(
    this: void,
    self: Result<T, E>,
    fnOk: MatchOkHandler<T, A>,
    fnErr: MatchErrorHandler<E, B>,
  ): A | B
  <T, E, A, B = A>(this: void, handlers: MatchHandlers<T, E, A, B>): (self: Result<T, E>) => A | B
  <T, E, A, B = A>(
    this: void,
    fnOk: MatchOkHandler<T, A>,
    fnErr: MatchErrorHandler<E, B>,
  ): (self: Result<T, E>) => A | B
}

export interface ResultAs {
  <T, E, U>(this: void, self: Result<T, E>, value: U): Result<U, E>
  <U>(this: void, value: U): <T, E>(self: Result<T, E>) => Result<U, E>
}

export type ResultAsVoid = <
  Args extends readonly [self: Result<unknown, unknown>] | readonly [] = readonly [],
>(
  this: void,
  ...args: Args
) => Args extends readonly [Result<unknown, infer E>]
  ? Result<void, E>
  : <T, E>(self: Result<T, E>) => Result<void, E>

export interface ResultFilterOrElse {
  <T, E, U extends T, F>(
    this: void,
    self: Result<T, E>,
    refinement: (value: T) => value is U,
    onFalse: (value: T) => F,
  ): Result<U, E | F>
  <T, E, F>(
    this: void,
    self: Result<T, E>,
    predicate: (value: T) => boolean,
    onFalse: (value: T) => F,
  ): Result<T, E | F>
  <T, U extends T, F>(
    this: void,
    refinement: (value: T) => value is U,
    onFalse: (value: T) => F,
  ): <E>(self: Result<T, E>) => Result<U, E | F>
  <T, F>(
    this: void,
    predicate: (value: T) => boolean,
    onFalse: (value: T) => F,
  ): <E>(self: Result<T, E>) => Result<T, E | F>
}

export interface ResultCatchTag {
  <T, E, const Tag extends TagsOf<E>, R extends Result<unknown, unknown>>(
    this: void,
    self: Result<T, E>,
    tag: Tag,
    f: (error: NoInfer<ErrorForTag<E, Tag>>) => R,
  ): Result<T | InferOkTypes<R>, ExcludeTag<E, Tag> | InferErrTypes<R>>
  <T, E, const Tag extends TagsOf<E>, R extends Result<unknown, unknown>>(
    this: void,
    tag: Tag,
    f: (error: NoInfer<ErrorForTag<E, Tag>>) => R,
  ): (self: Result<T, E>) => Result<T | InferOkTypes<R>, ExcludeTag<E, Tag> | InferErrTypes<R>>
  <
    const Tag extends string,
    Handled extends { readonly _tag: Tag },
    R extends Result<unknown, unknown>,
  >(
    this: void,
    tag: Tag,
    f: (error: Handled) => R,
  ): <T, E>(
    self: Result<T, E> &
      (Tag extends TagsOf<E> ? (ErrorForTag<E, Tag> extends Handled ? unknown : never) : never),
  ) => Result<T | InferOkTypes<R>, ExcludeTag<E, Tag> | InferErrTypes<R>>
}

export interface ResultCatchTags {
  <T, E, const Handlers extends object>(
    this: void,
    self: Result<T, E>,
    handlers: Handlers & CatchTagHandlers<E, Handlers>,
  ): Result<
    T | InferOkTypes<CatchTagHandlerResult<Handlers>>,
    | ExcludeTag<E, CoveredHandlerKeys<Handlers> & string>
    | InferErrTypes<CatchTagHandlerResult<Handlers>>
  >
  <T, E, const Handlers extends object>(
    this: void,
    handlers: Handlers & CatchTagHandlers<E, Handlers>,
  ): (
    self: Result<T, E>,
  ) => Result<
    T | InferOkTypes<CatchTagHandlerResult<Handlers>>,
    | ExcludeTag<E, CoveredHandlerKeys<Handlers> & string>
    | InferErrTypes<CatchTagHandlerResult<Handlers>>
  >
  <const Handlers extends object>(
    this: void,
    handlers: Handlers,
  ): <T, E>(
    self: Result<T, E> & (Handlers extends CatchTagHandlers<E, Handlers> ? unknown : never),
  ) => Result<
    T | InferOkTypes<CatchTagHandlerResult<Handlers>>,
    | ExcludeTag<E, CoveredHandlerKeys<Handlers> & string>
    | InferErrTypes<CatchTagHandlerResult<Handlers>>
  >
}

/* eslint-disable max-params */
export interface ResultCatchReason {
  <
    T,
    E,
    const ErrorTag extends TagsWithReasonOf<E>,
    const ReasonTag extends ReasonTagsOf<E, ErrorTag>,
    R extends Result<unknown, unknown>,
  >(
    this: void,
    self: Result<T, E>,
    errorTag: ErrorTag,
    reasonTag: ReasonTag,
    f: (
      reason: NoInfer<ReasonForTag<E, ErrorTag, ReasonTag>>,
      error: NoInfer<ErrorForTag<E, ErrorTag>>,
    ) => R,
  ): Result<T | InferOkTypes<R>, ExcludeReasonTag<E, ErrorTag, ReasonTag> | InferErrTypes<R>>
  <
    T,
    E,
    const ErrorTag extends TagsWithReasonOf<E>,
    const ReasonTag extends ReasonTagsOf<E, ErrorTag>,
    R extends Result<unknown, unknown>,
  >(
    this: void,
    errorTag: ErrorTag,
    reasonTag: ReasonTag,
    f: (
      reason: NoInfer<ReasonForTag<E, ErrorTag, ReasonTag>>,
      error: NoInfer<ErrorForTag<E, ErrorTag>>,
    ) => R,
  ): (
    self: Result<T, E>,
  ) => Result<T | InferOkTypes<R>, ExcludeReasonTag<E, ErrorTag, ReasonTag> | InferErrTypes<R>>
  <
    const ErrorTag extends string,
    const ReasonTag extends string,
    HandledReason extends { readonly _tag: ReasonTag },
    HandledError extends { readonly _tag: ErrorTag; readonly reason: unknown } = {
      readonly _tag: ErrorTag
      readonly reason: HandledReason
    },
    R extends Result<unknown, unknown> = Result<unknown, unknown>,
  >(
    this: void,
    errorTag: ErrorTag,
    reasonTag: ReasonTag,
    f: (reason: HandledReason, error: HandledError) => R,
  ): <T, E>(
    self: Result<T, E> &
      (ErrorTag extends TagsWithReasonOf<E>
        ? ReasonTag extends ReasonTagsOf<E, ErrorTag>
          ? ReasonForTag<E, ErrorTag, ReasonTag> extends HandledReason
            ? ErrorForTag<E, ErrorTag> extends HandledError
              ? unknown
              : never
            : never
          : never
        : never),
  ) => Result<T | InferOkTypes<R>, ExcludeReasonTag<E, ErrorTag, ReasonTag> | InferErrTypes<R>>
}
/* eslint-enable max-params */

export interface ResultCatchReasons {
  <T, E, const ErrorTag extends TagsWithReasonOf<E>, const Handlers extends object>(
    this: void,
    self: Result<T, E>,
    errorTag: ErrorTag,
    handlers: Handlers & CatchReasonHandlers<E, ErrorTag, Handlers>,
  ): Result<
    T | InferOkTypes<CatchReasonHandlerResult<Handlers>>,
    | ExcludeReasonTag<E, ErrorTag, CoveredHandlerKeys<Handlers> & string>
    | InferErrTypes<CatchReasonHandlerResult<Handlers>>
  >
  <T, E, const ErrorTag extends TagsWithReasonOf<E>, const Handlers extends object>(
    this: void,
    errorTag: ErrorTag,
    handlers: Handlers & CatchReasonHandlers<E, ErrorTag, Handlers>,
  ): (
    self: Result<T, E>,
  ) => Result<
    T | InferOkTypes<CatchReasonHandlerResult<Handlers>>,
    | ExcludeReasonTag<E, ErrorTag, CoveredHandlerKeys<Handlers> & string>
    | InferErrTypes<CatchReasonHandlerResult<Handlers>>
  >
  <const ErrorTag extends string, const Handlers extends object>(
    this: void,
    errorTag: ErrorTag,
    handlers: Handlers,
  ): <T, E>(
    self: Result<T, E> &
      (ErrorTag extends TagsWithReasonOf<E>
        ? Handlers extends CatchReasonHandlers<E, ErrorTag, Handlers>
          ? unknown
          : never
        : never),
  ) => Result<
    T | InferOkTypes<CatchReasonHandlerResult<Handlers>>,
    | ExcludeReasonTag<E, ErrorTag, CoveredHandlerKeys<Handlers> & string>
    | InferErrTypes<CatchReasonHandlerResult<Handlers>>
  >
}

export interface ResultUnwrapReason {
  <T, E, const ErrorTag extends TagsWithReasonOf<E>>(
    this: void,
    self: Result<T, E>,
    errorTag: ErrorTag,
  ): Result<T, ExcludeTag<E, ErrorTag> | ReasonsOf<E, ErrorTag>>
  <const ErrorTag extends string>(
    this: void,
    errorTag: ErrorTag,
  ): <T, E>(
    self: Result<T, E> & (ErrorTag extends TagsWithReasonOf<E> ? unknown : never),
  ) => Result<T, ExcludeTag<E, ErrorTag> | ReasonsOf<E, ErrorTag>>
}

export interface ResultMatchTags {
  <T, E, A, const Handlers extends object>(
    this: void,
    self: Result<T, E>,
    fnOk: (value: T) => A,
    handlers: Handlers & MatchTagHandlers<E, Handlers>,
  ): A | MatchTagHandlerResult<Handlers>
  <T, E, A, const Handlers extends object>(
    this: void,
    fnOk: (value: T) => A,
    handlers: Handlers & MatchTagHandlers<E, Handlers>,
  ): (self: Result<T, E>) => A | MatchTagHandlerResult<Handlers>
}

/* eslint-disable max-params */
export interface ResultMatchTagsPartial {
  <T, E, A, B, const Handlers extends object>(
    this: void,
    self: Result<T, E>,
    fnOk: (value: T) => A,
    handlers: Handlers & PartialMatchTagHandlers<E, Handlers>,
    fallback: (error: RemainingMatchTagErrors<E, Handlers>) => B,
  ): A | MatchTagHandlerResult<Handlers> | B
  <T, E, A, B, const Handlers extends object>(
    this: void,
    fnOk: (value: T) => A,
    handlers: Handlers & PartialMatchTagHandlers<E, Handlers>,
    fallback: (error: RemainingMatchTagErrors<E, Handlers>) => B,
  ): (self: Result<T, E>) => A | MatchTagHandlerResult<Handlers> | B
}
/* eslint-enable max-params */

// #region Combine - Types

// This is a helper type to prevent infinite recursion in typing rules.
//
// Use this with your `depth` variable in your types.
type Prev = [
  never,
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  17,
  18,
  19,
  20,
  21,
  22,
  23,
  24,
  25,
  26,
  27,
  28,
  29,
  30,
  31,
  32,
  33,
  34,
  35,
  36,
  37,
  38,
  39,
  40,
  41,
  42,
  43,
  44,
  45,
  46,
  47,
  48,
  49,
  ...0[],
]

// Collects the results array into separate tuple array.
//
// T         - The array of the results
// Collected - The collected tuples.
// Depth     - The maximum depth.
type CollectResults<T, Collected extends unknown[] = [], Depth extends number = 50> = [
  Depth,
] extends [never]
  ? []
  : T extends [infer H, ...infer Rest]
    ? // And test whether the head of the list is a result
      H extends Result<infer L, infer R>
      ? // Continue collecting...
        CollectResults<
          // the rest of the elements
          Rest,
          // The collected
          [...Collected, [L, R]],
          // and one less of the current depth
          Prev[Depth]
        >
      : never // Impossible
    : Collected

// Transposes an array
//
// A          - The array source
// Transposed - The collected transposed array
// Depth      - The maximum depth.
type Transpose<A, Transposed extends unknown[][] = [], Depth extends number = 10> = A extends [
  infer T,
  ...infer Rest,
]
  ? T extends [infer L, infer R]
    ? Transposed extends [infer PL, infer PR]
      ? PL extends unknown[]
        ? PR extends unknown[]
          ? Transpose<Rest, [[...PL, L], [...PR, R]], Prev[Depth]>
          : never
        : never
      : Transpose<Rest, [[L], [R]], Prev[Depth]>
    : Transposed
  : Transposed

// Combines the both sides of the array of the results into a tuple of the
// union of the ok types and the union of the err types.
//
// T     - The array of the results
// Depth - The maximum depth.
export type Combine<T, Depth extends number = 5> =
  Transpose<CollectResults<T>, [], Depth> extends [infer L, infer R]
    ? [UnknownMembersToNever<L>, UnknownMembersToNever<R>]
    : Transpose<CollectResults<T>, [], Depth> extends []
      ? [[], []]
      : never

// Deduplicates the result, as the result type is a union of Err and Ok types.
export type Dedup<T> = T extends Result<infer RL, infer RR> ? Result<RL, RR> : T

// Given a union, this gives the array of the union members.
export type MemberListOf<T> = (
  (T extends unknown ? (t: T) => T : never) extends infer U
    ? (U extends unknown ? (u: U) => unknown : never) extends (v: infer V) => unknown
      ? V
      : never
    : never
) extends (_: unknown) => infer W
  ? [...MemberListOf<Exclude<T, W>>, W]
  : []

// Converts an empty array to never.
//
// The second type parameter here will affect how to behave to `never[]`s.
// If a precise type is required, pass `1` here so that it will resolve
// a literal array such as `[ never, never ]`. Otherwise, set `0` or the default
// type value will cause this to resolve the arrays containing only `never`
// items as `never` only.
export type EmptyArrayToNever<T, NeverArrayToNever extends number = 0> = T extends []
  ? never
  : NeverArrayToNever extends 1
    ? T extends [never, ...infer Rest]
      ? [EmptyArrayToNever<Rest>] extends [never]
        ? never
        : T
      : T
    : T

// Converts the `unknown` items of an array to `never`s.
type UnknownMembersToNever<T> = T extends [infer H, ...infer R]
  ? [[unknown] extends [H] ? never : H, ...UnknownMembersToNever<R>]
  : T

// Gets the member type of the array or never.
export type MembersToUnion<T> = T extends unknown[] ? T[number] : never

// Checks if the given type is a literal array.
export type IsLiteralArray<T> = T extends { length: infer L }
  ? L extends number
    ? number extends L
      ? 0
      : 1
    : 0
  : 0

// Traverses an array of results and returns a single result containing
// the oks and errs union-ed/combined.
type Traverse<T, Depth extends number = 5> =
  Combine<T, Depth> extends [infer Oks, infer Errs]
    ? Result<EmptyArrayToNever<Oks, 1>, MembersToUnion<Errs>>
    : never

// Traverses an array of results and returns a single result containing
// the oks combined and the array of errors combined.
type TraverseWithAllErrors<T, Depth extends number = 5> =
  Traverse<T, Depth> extends Result<infer Oks, infer Errs> ? Result<Oks, Errs[]> : never

// Combines the array of results into one result.
export type CombineResults<T extends readonly Result<unknown, unknown>[]> =
  IsLiteralArray<T> extends 1 ? Traverse<T> : Result<ExtractOkTypes<T>, ExtractErrTypes<T>[number]>

// Combines the array of results into one result with all errors.
export type CombineResultsWithAllErrorsArray<T extends readonly Result<unknown, unknown>[]> =
  IsLiteralArray<T> extends 1
    ? TraverseWithAllErrors<T>
    : Result<ExtractOkTypes<T>, ExtractErrTypes<T>[number][]>

// #endregion
