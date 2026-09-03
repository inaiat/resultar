import { type ErrorConfig, createResultarError } from './error.js'
import { Pipeable, type PipeFn } from './pipe.js'
import { createResultAsync } from './result-async-adapter.js'
import type { ResultAsync } from './result-async.js'
import type { ExtractErrTypes, ExtractOkTypes, InferErrTypes, InferOkTypes } from './utils.js'
import { callTaggedHandler, hasTag, isTaggedHandlerMatch, matchTaggedOr } from './tagged-match.js'
import type {
  CatchTagHandlerResult,
  CatchReasonHandlerResult,
  ErrorForTag,
  ExcludeReasonTag,
  ExcludeTag,
  MatchTagHandlerResult,
  MatchTagHandlers,
  PartialMatchTagHandlers,
  ReasonForTag,
  ReasonTagsOf,
  ReasonsOf,
  ResultCatchReasonHandlers as CatchReasonHandlers,
  ResultCatchTagHandlers as CatchTagHandlers,
  TagsOf,
  TagsWithReasonOf,
} from './tagged-types.js'

type ResultFinalizer<T, E> = (value: T | undefined, error: E | undefined) => void
type MatchOkHandler<T, A> = (value: T) => A
type MatchErrorHandler<E, B> = (error: E) => B
type ResultCandidate = () => Result<unknown, unknown>
type ResultRecord = Readonly<Record<string, Result<unknown, unknown>>>
type CombineResultsRecord<T extends ResultRecord> = Result<
  { readonly [Key in keyof T]: InferOkTypes<T[Key]> },
  InferErrTypes<T[keyof T]>
>
type CombineResultsRecordWithAllErrors<T extends ResultRecord> = Result<
  { readonly [Key in keyof T]: InferOkTypes<T[Key]> },
  InferErrTypes<T[keyof T]>[]
>
type CombineResultsIterable<R extends Result<unknown, unknown>> = Result<
  readonly InferOkTypes<R>[],
  InferErrTypes<R>
>
type CombineResultsIterableWithAllErrors<R extends Result<unknown, unknown>> = Result<
  readonly InferOkTypes<R>[],
  InferErrTypes<R>[]
>
type ResultLoopCollected<R extends Result<unknown, unknown>> = Result<
  readonly InferOkTypes<R>[],
  InferErrTypes<R>
>
type ResultLoopDiscarded<R extends Result<unknown, unknown>> = Result<void, InferErrTypes<R>>
type ResultIterated<State, R extends Result<State, unknown>> = Result<State, InferErrTypes<R>>
type ResultForEachCollected<R extends Result<unknown, unknown>> = Result<
  readonly InferOkTypes<R>[],
  InferErrTypes<R>
>
type ResultForEachDiscarded<R extends Result<unknown, unknown>> = Result<void, InferErrTypes<R>>
type ResultValidatedAll<R extends Result<unknown, unknown>> = Result<
  readonly InferOkTypes<R>[],
  InferErrTypes<R>[]
>
type ResultZipped<
  Left extends Result<unknown, unknown>,
  Right extends Result<unknown, unknown>,
> = Result<[InferOkTypes<Left>, InferOkTypes<Right>], InferErrTypes<Left> | InferErrTypes<Right>>
type ResultBooleanCondition = boolean | (() => boolean)
type ResultIf<
  ConditionErr,
  OnTrue extends Result<unknown, unknown>,
  OnFalse extends Result<unknown, unknown>,
> = Result<
  InferOkTypes<OnTrue> | InferOkTypes<OnFalse>,
  ConditionErr | InferErrTypes<OnTrue> | InferErrTypes<OnFalse>
>
type ResultWhen<R extends Result<unknown, unknown>> = Result<
  InferOkTypes<R> | undefined,
  InferErrTypes<R>
>
type ResultWhenWithCondition<
  Condition extends Result<boolean, unknown>,
  R extends Result<unknown, unknown>,
> = Result<InferOkTypes<R> | undefined, InferErrTypes<Condition> | InferErrTypes<R>>
type WidenLiteral<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends bigint
        ? bigint
        : T

export interface MatchHandlers<T, E, A, B = A> {
  readonly error: MatchErrorHandler<E, B>
  readonly ok: MatchOkHandler<T, A>
}

type FirstSuccessOf<Candidates extends Iterable<ResultCandidate>> = Result<
  InferOkTypes<ReturnType<IterableElement<Candidates>>>,
  InferErrTypes<ReturnType<IterableElement<Candidates>>>
>

type IterableElement<T> = T extends Iterable<infer Element> ? Element : never

interface ResultLoopOptions<State, BodyState extends State, R extends Result<unknown, unknown>> {
  readonly body: (state: BodyState) => R
  readonly discard?: false
  readonly step: (state: BodyState) => State
  readonly while: (state: State) => state is BodyState
}

interface ResultLoopBooleanOptions<State, R extends Result<unknown, unknown>> {
  readonly body: (state: State) => R
  readonly discard?: false
  readonly step: (state: State) => State
  readonly while: (state: State) => boolean
}

interface ResultLoopDiscardOptions<
  State,
  BodyState extends State,
  R extends Result<unknown, unknown>,
> {
  readonly body: (state: BodyState) => R
  readonly discard: true
  readonly step: (state: BodyState) => State
  readonly while: (state: State) => state is BodyState
}

interface ResultLoopBooleanDiscardOptions<State, R extends Result<unknown, unknown>> {
  readonly body: (state: State) => R
  readonly discard: true
  readonly step: (state: State) => State
  readonly while: (state: State) => boolean
}

interface ResultLoopRuntimeOptions<State, R extends Result<unknown, unknown>> {
  readonly body: (state: State) => R
  readonly discard?: boolean
  readonly step: (state: State) => State
  readonly while: (state: State) => boolean
}

interface ResultIterateOptions<State, BodyState extends State, R extends Result<State, unknown>> {
  readonly body: (state: BodyState) => R
  readonly while: (state: State) => state is BodyState
}

interface ResultIterateBooleanOptions<State, R extends Result<State, unknown>> {
  readonly body: (state: State) => R
  readonly while: (state: State) => boolean
}

interface ResultIterateRuntimeOptions<State, R extends Result<State, unknown>> {
  readonly body: (state: State) => R
  readonly while: (state: State) => boolean
}

interface ResultForEachOptions {
  readonly discard?: false
}

interface ResultForEachDiscardOptions {
  readonly discard: true
}

interface ResultForEachRuntimeOptions {
  readonly discard?: boolean
}

interface ResultIfOptions<
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
interface Resultable<T, E> {
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

  // safeUnwrap(): Generator<Result<never, E>, T>

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
export interface ResultOperations<T, E> {
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
   * Recovers from Err with another Result.
   */
  orElse: <R extends Result<unknown, unknown>>(
    f: (e: E) => R,
  ) => Result<InferOkTypes<R> | T, InferErrTypes<R>>
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
    ExcludeTag<E, keyof Handlers & string> | InferErrTypes<CatchTagHandlerResult<Handlers>>
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
    | ExcludeReasonTag<E, ErrorTag, keyof Handlers & string>
    | InferErrTypes<CatchReasonHandlerResult<Handlers>>
  >
  /**
   * Moves the nested `reason` of a tagged error into the Result error channel.
   */
  unwrapReason: <const ErrorTag extends TagsWithReasonOf<E>>(
    errorTag: ErrorTag,
  ) => Result<T, ExcludeTag<E, ErrorTag> | ReasonsOf<E, ErrorTag>>
  /**
   * Chains an async fallible operation from the Ok value.
   */
  asyncAndThen: <X, Y>(f: (t: T) => ResultAsync<X, Y>) => ResultAsync<X, E | Y>
  /**
   * Maps the Ok value with an async function and returns a `ResultAsync`.
   */
  asyncMap: <X>(f: (t: T) => Promise<X>) => ResultAsync<X, E>
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
    <A>(ab: PipeFn<Result<T, E>, A>): A
    <A, B>(ab: PipeFn<Result<T, E>, A>, bc: PipeFn<A, B>): B
    <A, B, C>(ab: PipeFn<Result<T, E>, A>, bc: PipeFn<A, B>, cd: PipeFn<B, C>): C
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
  tap: (fn: (t: T) => void) => this
  /**
   * Runs a side effect only when this result is Err and returns this same Result.
   *
   * Exceptions thrown by the side effect are swallowed.
   */
  tapError: (fn: (e: E) => void) => this
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

/** Success-or-failure value with explicit Ok and Err channels. */
export type Result<T, E> = OkResult<T, E> | ErrResult<T, E>

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

const combineResultList = <T, E>(resultList: readonly Result<T, E>[]): Result<readonly T[], E> => {
  const values: T[] = []

  for (const result of resultList) {
    if (result.isErr()) {
      return err(result.error)
    }

    values.push(result.value)
  }

  return ok(values)
}

const combineResultRecord = <T extends ResultRecord>(resultRecord: T): CombineResultsRecord<T> => {
  const values: Record<string, unknown> = {}

  for (const [key, result] of Object.entries(resultRecord)) {
    if (result.isErr()) {
      return err(result.error) as CombineResultsRecord<T>
    }

    values[key] = result.value
  }

  return ok(values) as CombineResultsRecord<T>
}

const combineResultListWithAllErrors = <T, E>(
  resultList: readonly Result<T, E>[],
): Result<readonly T[], E[]> => {
  let acc = ok([]) as Result<T[], E[]>

  for (const result of resultList) {
    if (result.isErr() && acc.isErr()) {
      acc.error.push(result.error)
    } else if (result.isErr() && acc.isOk()) {
      acc = err([result.error])
    } else if (result.isOk() && acc.isOk()) {
      acc.value.push(result.value)
    }
  }

  return acc
}

const combineResultRecordWithAllErrors = <T extends ResultRecord>(
  resultRecord: T,
): CombineResultsRecordWithAllErrors<T> => {
  const errors: unknown[] = []
  const values: Record<string, unknown> = {}

  for (const [key, result] of Object.entries(resultRecord)) {
    if (result.isErr()) {
      errors.push(result.error)
    } else {
      values[key] = result.value
    }
  }

  if (errors.length > 0) {
    return err(errors) as CombineResultsRecordWithAllErrors<T>
  }

  return ok(values) as CombineResultsRecordWithAllErrors<T>
}

const isIterable = (value: unknown): value is Iterable<unknown> =>
  // Stryker disable next-line all: invalid null input still fails outside the iterable branch; this guard keeps the hot check explicit.
  value !== null &&
  // Stryker disable next-line all: iterable functions are valid iterables, but normal collection tests cover object iterables.
  (typeof value === 'object' || typeof value === 'function') &&
  typeof (value as { readonly [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'

export const createEmptyResultsCollectionError = (): Error => {
  const error = new Error('Received an empty collection of results')
  error.name = 'IllegalArgumentException'

  return error
}

const getReason = (value: unknown): unknown => (value as { readonly reason?: unknown }).reason

const loopResult = <State, R extends Result<unknown, unknown>>(
  initial: State,
  options: ResultLoopRuntimeOptions<State, R>,
): ResultLoopCollected<R> | ResultLoopDiscarded<R> => {
  let state = initial

  if (options.discard === true) {
    while (options.while(state)) {
      const result = options.body(state)

      if (result.isErr()) {
        return err(result.error as InferErrTypes<R>) as
          | ResultLoopCollected<R>
          | ResultLoopDiscarded<R>
      }

      state = options.step(state)
    }

    return ok<void, InferErrTypes<R>>(undefined)
  }

  const values: InferOkTypes<R>[] = []

  while (options.while(state)) {
    const result = options.body(state)

    if (result.isErr()) {
      return err(result.error as InferErrTypes<R>) as
        | ResultLoopCollected<R>
        | ResultLoopDiscarded<R>
    }

    values.push(result.value as InferOkTypes<R>)
    state = options.step(state)
  }

  return ok<readonly InferOkTypes<R>[], InferErrTypes<R>>(values)
}

const iterateResult = <State, R extends Result<State, unknown>>(
  initial: State,
  options: ResultIterateRuntimeOptions<State, R>,
): ResultIterated<State, R> => {
  let state = initial

  while (options.while(state)) {
    const result = options.body(state)

    if (result.isErr()) {
      return err(result.error as InferErrTypes<R>) as ResultIterated<State, R>
    }

    state = result.value
  }

  return ok<State, InferErrTypes<R>>(state)
}

const forEachResult = <Item, R extends Result<unknown, unknown>>(
  items: Iterable<Item>,
  f: (value: Item, index: number) => R,
  options?: ResultForEachRuntimeOptions,
): ResultForEachCollected<R> | ResultForEachDiscarded<R> => {
  if (options?.discard === true) {
    let index = 0

    for (const item of items) {
      const result = f(item, index)

      if (result.isErr()) {
        return err(result.error as InferErrTypes<R>) as
          | ResultForEachCollected<R>
          | ResultForEachDiscarded<R>
      }

      index += 1
    }

    return ok<void, InferErrTypes<R>>(undefined)
  }

  const values: InferOkTypes<R>[] = []
  let index = 0

  for (const item of items) {
    const result = f(item, index)

    if (result.isErr()) {
      return err(result.error as InferErrTypes<R>) as
        | ResultForEachCollected<R>
        | ResultForEachDiscarded<R>
    }

    values.push(result.value as InferOkTypes<R>)
    index += 1
  }

  return ok<readonly InferOkTypes<R>[], InferErrTypes<R>>(values)
}

const callSyncSideEffect = (effect: () => void): void => {
  try {
    effect()
  } catch {
    /* empty */
  }
}

export const getMatchErrorHandler = <T, E, A, B>(
  input: MatchHandlers<T, E, A, B> | MatchOkHandler<T, A>,
  fnErr: MatchErrorHandler<E, B> | undefined,
): MatchErrorHandler<E, B> => {
  if (typeof input !== 'function') {
    return input.error
  }

  if (fnErr === undefined) {
    throw new TypeError('Result.match requires an error handler')
  }

  return fnErr
}

interface ResultStatic {
  /**
   * Runtime `instanceof Result` support for Ok and Err values.
   */
  [Symbol.hasInstance]: (value: unknown) => boolean
  /**
   * Alias for `safeTry`, providing the same generator vocabulary as `ResultTask.gen`.
   */
  gen: typeof safeTry
  /**
   * Runs synchronous work and captures thrown values into a Result.
   *
   * Compatibility alias. Prefer the top-level `tryResult` helper in new code.
   */
  tryCatch: <T, E>(
    this: void,
    fn: () => Exclude<T, Promise<unknown>>,
    errorFn?: (e: unknown) => E,
  ) => Result<T, E>
  /**
   * Wraps a throwing synchronous function so every later call returns a Result.
   */
  fromThrowable: <Fn extends (...args: readonly any[]) => unknown, E>(
    this: void,
    fn: Fn,
    errorFn?: (e: any) => E,
  ) => (...args: Parameters<Fn>) => Result<ReturnType<Fn>, E>
  /**
   * Creates an Ok result.
   */
  ok: {
    <T, E = never>(this: void, value: T): OkResult<T, E>
    <E = never>(this: void, value: void): OkResult<void, E>
  }
  /**
   * Creates an Ok result with `undefined`.
   */
  unit: <E = never>(this: void) => Result<undefined, E>
  /**
   * Creates an Err result.
   */
  err: {
    <T = never, E extends string = string>(this: void, err: E): ErrResult<T, E>
    <T = never, E = unknown>(this: void, err: E): ErrResult<T, E>
    <T = never>(this: void, err: void): ErrResult<T, void>
  }
  /**
   * Combines many Result values and stops at the first Err.
   *
   * Arrays return an Ok array, records return an Ok record with the same keys, and iterables return
   * an Ok readonly array.
   */
  combine: {
    <T extends readonly [Result<unknown, unknown>, ...Result<unknown, unknown>[]]>(
      this: void,
      resultList: T,
    ): CombineResults<T>
    <T extends readonly Result<unknown, unknown>[]>(this: void, resultList: T): CombineResults<T>
    <T extends ResultRecord>(this: void, resultRecord: T): CombineResultsRecord<T>
    <R extends Result<unknown, unknown>>(
      this: void,
      results: Iterable<R>,
    ): CombineResultsIterable<R>
  }
  /**
   * Combines many Result values and collects every Err instead of stopping at the first one.
   */
  combineWithAllErrors: {
    <T extends readonly [Result<unknown, unknown>, ...Result<unknown, unknown>[]]>(
      this: void,
      resultList: T,
    ): CombineResultsWithAllErrorsArray<T>
    <T extends readonly Result<unknown, unknown>[]>(
      this: void,
      resultList: T,
    ): CombineResultsWithAllErrorsArray<T>
    <T extends ResultRecord>(this: void, resultRecord: T): CombineResultsRecordWithAllErrors<T>
    <R extends Result<unknown, unknown>>(
      this: void,
      results: Iterable<R>,
    ): CombineResultsIterableWithAllErrors<R>
  }
  /**
   * Validates many Result values and collects every Err.
   *
   * When passed items plus a mapper, the mapper must return a Result for each item.
   */
  validateAll: {
    <T extends readonly [Result<unknown, unknown>, ...Result<unknown, unknown>[]]>(
      this: void,
      resultList: T,
    ): CombineResultsWithAllErrorsArray<T>
    <T extends readonly Result<unknown, unknown>[]>(
      this: void,
      resultList: T,
    ): CombineResultsWithAllErrorsArray<T>
    <Item, R extends Result<unknown, unknown>>(
      this: void,
      items: Iterable<Item>,
      f: (value: Item, index: number) => R,
    ): ResultValidatedAll<R>
  }
  /**
   * Combines exactly two Result values into an Ok tuple or the first Err.
   */
  zip: <Left extends Result<unknown, unknown>, Right extends Result<unknown, unknown>>(
    this: void,
    left: Left,
    right: Right,
  ) => ResultZipped<Left, Right>
  /**
   * Runs candidates until the first Ok and returns the last Err if every candidate fails.
   */
  firstSuccessOf: <Candidates extends Iterable<ResultCandidate>>(
    this: void,
    candidates: Candidates,
  ) => FirstSuccessOf<Candidates>
  /**
   * Chooses one of two Result branches from a boolean or Result boolean condition.
   */
  if: {
    <OnTrue extends Result<unknown, unknown>, OnFalse extends Result<unknown, unknown>>(
      this: void,
      condition: ResultBooleanCondition,
      options: ResultIfOptions<OnTrue, OnFalse>,
    ): ResultIf<never, OnTrue, OnFalse>
    <
      Condition extends Result<boolean, unknown>,
      OnTrue extends Result<unknown, unknown>,
      OnFalse extends Result<unknown, unknown>,
    >(
      this: void,
      condition: Condition,
      options: ResultIfOptions<OnTrue, OnFalse>,
    ): ResultIf<InferErrTypes<Condition>, OnTrue, OnFalse>
  }
  /**
   * Runs `body` only when the condition is true; otherwise returns Ok(undefined).
   */
  when: <R extends Result<unknown, unknown>>(
    this: void,
    condition: ResultBooleanCondition,
    body: () => R,
  ) => ResultWhen<R>
  /**
   * Runs `body` only when a Result boolean condition is Ok(true).
   */
  whenResult: <Condition extends Result<boolean, unknown>, R extends Result<unknown, unknown>>(
    this: void,
    condition: Condition,
    body: () => R,
  ) => ResultWhenWithCondition<Condition, R>
  /**
   * Runs `body` only when the condition is false; otherwise returns Ok(undefined).
   */
  unless: <R extends Result<unknown, unknown>>(
    this: void,
    condition: ResultBooleanCondition,
    body: () => R,
  ) => ResultWhen<R>
  /**
   * Runs `body` only when a Result boolean condition is Ok(false).
   */
  unlessResult: <Condition extends Result<boolean, unknown>, R extends Result<unknown, unknown>>(
    this: void,
    condition: Condition,
    body: () => R,
  ) => ResultWhenWithCondition<Condition, R>
  /**
   * Repeats a Result-producing body while a condition holds.
   *
   * Use `discard: true` when only failure matters and collected Ok values are not needed.
   */
  loop: {
    <State, BodyState extends State, R extends Result<unknown, unknown>>(
      this: void,
      initial: State,
      options: ResultLoopOptions<State, BodyState, R>,
    ): ResultLoopCollected<R>
    <State, R extends Result<unknown, unknown>>(
      this: void,
      initial: State,
      options: ResultLoopBooleanOptions<State, R>,
    ): ResultLoopCollected<R>
    <State, BodyState extends State, R extends Result<unknown, unknown>>(
      this: void,
      initial: State,
      options: ResultLoopDiscardOptions<State, BodyState, R>,
    ): ResultLoopDiscarded<R>
    <State, R extends Result<unknown, unknown>>(
      this: void,
      initial: State,
      options: ResultLoopBooleanDiscardOptions<State, R>,
    ): ResultLoopDiscarded<R>
  }
  /**
   * Repeatedly transforms state with a Result-producing body until the condition fails.
   */
  iterate: {
    <State, BodyState extends WidenLiteral<State>, R extends Result<WidenLiteral<State>, unknown>>(
      this: void,
      initial: State,
      options: ResultIterateOptions<WidenLiteral<State>, BodyState, R>,
    ): ResultIterated<WidenLiteral<State>, R>
    <State, R extends Result<WidenLiteral<State>, unknown>>(
      this: void,
      initial: State,
      options: ResultIterateBooleanOptions<WidenLiteral<State>, R>,
    ): ResultIterated<WidenLiteral<State>, R>
  }
  /**
   * Runs a Result-producing mapper for each item.
   *
   * Use `discard: true` when only failure matters and collected Ok values are not needed.
   */
  forEach: {
    <Item, R extends Result<unknown, unknown>>(
      this: void,
      items: Iterable<Item>,
      f: (value: Item, index: number) => R,
      options?: ResultForEachOptions,
    ): ResultForEachCollected<R>
    <Item, R extends Result<unknown, unknown>>(
      this: void,
      items: Iterable<Item>,
      f: (value: Item, index: number) => R,
      options: ResultForEachDiscardOptions,
    ): ResultForEachDiscarded<R>
  }
}

/**
 * Runtime namespace for Result constructors and static helpers.
 */
/* eslint-disable @typescript-eslint/no-extraneous-class, unicorn/no-static-only-class */
class ResultNamespace {
  public static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Ok || value instanceof Err
  }

  /**
   * Alias for the top-level `safeTry` generator workflow.
   */
  public static readonly gen: typeof safeTry = safeTry

  /**
   * Creates a `Result` by running a function that might throw.
   * If the function throws, the error will be caught and returned as an `Err`.
   * If the function succeeds, the value will be wrapped in an `Ok`.
   *
   * Compatibility alias. Prefer the top-level `tryResult` helper in new code.
   *
   * @param fn - The function to execute, which might throw an error
   * @param errorFn - Optional function to transform the thrown error before wrapping in `Err`
   * @returns A `Result` containing either the function's return value or the caught error
   */
  public static tryCatch<T, E>(
    this: void,
    fn: () => Exclude<T, Promise<unknown>>,
    errorFn?: (e: unknown) => E,
  ): Result<T, E> {
    try {
      return ok(fn())
    } catch (error) {
      if (errorFn) {
        return err(errorFn(error))
      }
      return err(error as E)
    }
  }

  /**
   * Wraps a function with a try catch, creating a new function with the same
   * arguments but returning `Ok` if successful, `Err` if the function throws
   *
   * @param fn function to wrap with ok on success or err on failure
   * @param errorFn when an error is thrown, this will wrap the error result if provided
   */
  public static fromThrowable<Fn extends (...args: readonly any[]) => unknown, E>(
    this: void,
    fn: Fn,
    errorFn?: (e: any) => E,
  ): (...args: Parameters<Fn>) => Result<ReturnType<Fn>, E> {
    return (...args) => {
      try {
        const result = fn(...args)
        return ok(result as ReturnType<Fn>)
      } catch (error) {
        if (errorFn) {
          return err(errorFn(error))
        }

        return err(error as E)
      }
    }
  }

  /**
   * Creates a new `Result` instance representing a successful operation.
   *
   * @param {T} value - The value to be wrapped in the `Result` instance.
   * @return {Result<T, E>} A new `Result` instance with the provided value.
   */

  public static ok<T, E = never>(this: void, value: T): OkResult<T, E>
  public static ok<E = never>(this: void, value: void): OkResult<void, E>
  public static ok<T, E = never>(this: void, value: T): OkResult<T, E> {
    return ok<T, E>(value)
  }

  /**
   * Creates a new `Result` instance representing a successful operation with an undefined value.
   *
   * @return {Result<undefined, E>} A new `Result` instance with an undefined value.
   */
  public static unit<E = never>(this: void): Result<undefined, E> {
    return unit<E>()
  }

  public static err<T = never, E extends string = string>(this: void, err: E): ErrResult<T, E>
  public static err<T = never, E = unknown>(this: void, err: E): ErrResult<T, E>
  public static err<T = never>(this: void, err: void): ErrResult<T, void>
  public static err<T = never, E = unknown>(this: void, error: E): ErrResult<T, E> {
    return err<T, E>(error)
  }

  public static combine<
    T extends readonly [Result<unknown, unknown>, ...Result<unknown, unknown>[]],
  >(this: void, resultList: T): CombineResults<T>
  public static combine<T extends readonly Result<unknown, unknown>[]>(
    this: void,
    resultList: T,
  ): CombineResults<T>
  public static combine<T extends ResultRecord>(
    this: void,
    resultRecord: T,
  ): CombineResultsRecord<T>
  public static combine<R extends Result<unknown, unknown>>(
    this: void,
    results: Iterable<R>,
  ): CombineResultsIterable<R>
  public static combine<
    T extends
      | readonly Result<unknown, unknown>[]
      | ResultRecord
      | Iterable<Result<unknown, unknown>>,
  >(
    this: void,
    input: T,
  ):
    | CombineResults<T & readonly Result<unknown, unknown>[]>
    | CombineResultsRecord<ResultRecord>
    | CombineResultsIterable<Result<unknown, unknown>> {
    // Stryker disable next-line all: array fast path avoids cloning arrays through the iterable branch.
    if (Array.isArray(input)) {
      return combineResultList(input) as CombineResults<T & readonly Result<unknown, unknown>[]>
    }

    if (isIterable(input)) {
      return combineResultList([...input] as readonly Result<unknown, unknown>[]) as
        | CombineResults<T & readonly Result<unknown, unknown>[]>
        | CombineResultsIterable<Result<unknown, unknown>>
    }

    return combineResultRecord(input)
  }

  public static combineWithAllErrors<
    T extends readonly [Result<unknown, unknown>, ...Result<unknown, unknown>[]],
  >(this: void, resultList: T): CombineResultsWithAllErrorsArray<T>
  public static combineWithAllErrors<T extends readonly Result<unknown, unknown>[]>(
    this: void,
    resultList: T,
  ): CombineResultsWithAllErrorsArray<T>
  public static combineWithAllErrors<T extends ResultRecord>(
    this: void,
    resultRecord: T,
  ): CombineResultsRecordWithAllErrors<T>
  public static combineWithAllErrors<R extends Result<unknown, unknown>>(
    this: void,
    results: Iterable<R>,
  ): CombineResultsIterableWithAllErrors<R>
  public static combineWithAllErrors<
    T extends
      | readonly Result<unknown, unknown>[]
      | ResultRecord
      | Iterable<Result<unknown, unknown>>,
  >(
    this: void,
    input: T,
  ):
    | CombineResultsWithAllErrorsArray<T & readonly Result<unknown, unknown>[]>
    | CombineResultsRecordWithAllErrors<ResultRecord>
    | CombineResultsIterableWithAllErrors<Result<unknown, unknown>> {
    // Stryker disable next-line all: array fast path avoids cloning arrays through the iterable branch.
    if (Array.isArray(input)) {
      return combineResultListWithAllErrors(input) as CombineResultsWithAllErrorsArray<
        T & readonly Result<unknown, unknown>[]
      >
    }

    if (isIterable(input)) {
      return combineResultListWithAllErrors([...input] as readonly Result<unknown, unknown>[]) as
        | CombineResultsWithAllErrorsArray<T & readonly Result<unknown, unknown>[]>
        | CombineResultsIterableWithAllErrors<Result<unknown, unknown>>
    }

    return combineResultRecordWithAllErrors(input)
  }

  public static validateAll<
    T extends readonly [Result<unknown, unknown>, ...Result<unknown, unknown>[]],
  >(this: void, resultList: T): CombineResultsWithAllErrorsArray<T>
  public static validateAll<T extends readonly Result<unknown, unknown>[]>(
    this: void,
    resultList: T,
  ): CombineResultsWithAllErrorsArray<T>
  public static validateAll<Item, R extends Result<unknown, unknown>>(
    this: void,
    items: Iterable<Item>,
    f: (value: Item, index: number) => R,
  ): ResultValidatedAll<R>
  public static validateAll<
    T extends readonly Result<unknown, unknown>[],
    Item,
    R extends Result<unknown, unknown>,
  >(
    this: void,
    resultListOrItems: T | Iterable<Item>,
    f?: (value: Item, index: number) => R,
  ): CombineResultsWithAllErrorsArray<T> | ResultValidatedAll<R> {
    // Stryker disable next-line all: no-mapper fast path avoids Array.from identity mapping.
    if (f === undefined) {
      return combineResultListWithAllErrors(
        resultListOrItems as T,
      ) as CombineResultsWithAllErrorsArray<T>
    }

    const resultList = Array.from(resultListOrItems as Iterable<Item>, f)

    return combineResultListWithAllErrors(resultList) as ResultValidatedAll<R>
  }

  public static zip<Left extends Result<unknown, unknown>, Right extends Result<unknown, unknown>>(
    this: void,
    left: Left,
    right: Right,
  ): ResultZipped<Left, Right> {
    return combineResultList([left, right]) as ResultZipped<Left, Right>
  }

  public static firstSuccessOf<Candidates extends Iterable<ResultCandidate>>(
    this: void,
    candidates: Candidates,
  ): FirstSuccessOf<Candidates> {
    let latestError: Result<unknown, unknown> | undefined = undefined

    for (const candidate of candidates) {
      const result = candidate()

      if (result.isOk()) {
        return result as FirstSuccessOf<Candidates>
      }

      latestError = result
    }

    if (latestError === undefined) {
      throw createEmptyResultsCollectionError()
    }

    return latestError as FirstSuccessOf<Candidates>
  }

  public static if<
    OnTrue extends Result<unknown, unknown>,
    OnFalse extends Result<unknown, unknown>,
  >(
    this: void,
    condition: ResultBooleanCondition,
    options: ResultIfOptions<OnTrue, OnFalse>,
  ): ResultIf<never, OnTrue, OnFalse>
  public static if<
    Condition extends Result<boolean, unknown>,
    OnTrue extends Result<unknown, unknown>,
    OnFalse extends Result<unknown, unknown>,
  >(
    this: void,
    condition: Condition,
    options: ResultIfOptions<OnTrue, OnFalse>,
  ): ResultIf<InferErrTypes<Condition>, OnTrue, OnFalse>
  public static if<
    Condition extends Result<boolean, unknown>,
    OnTrue extends Result<unknown, unknown>,
    OnFalse extends Result<unknown, unknown>,
  >(
    this: void,
    condition: Condition | ResultBooleanCondition,
    options: ResultIfOptions<OnTrue, OnFalse>,
  ): ResultIf<InferErrTypes<Condition>, OnTrue, OnFalse> | ResultIf<never, OnTrue, OnFalse> {
    if (typeof condition === 'boolean' || typeof condition === 'function') {
      return (
        (typeof condition === 'function' ? condition() : condition)
          ? options.onTrue()
          : options.onFalse()
      ) as ResultIf<never, OnTrue, OnFalse>
    }

    if (condition.isErr()) {
      return err(condition.error as InferErrTypes<Condition>) as ResultIf<
        InferErrTypes<Condition>,
        OnTrue,
        OnFalse
      >
    }

    return (condition.value ? options.onTrue() : options.onFalse()) as ResultIf<
      InferErrTypes<Condition>,
      OnTrue,
      OnFalse
    >
  }

  public static when<R extends Result<unknown, unknown>>(
    this: void,
    condition: ResultBooleanCondition,
    body: () => R,
  ): ResultWhen<R> {
    if (typeof condition === 'function' ? condition() : condition) {
      return body() as ResultWhen<R>
    }

    return ok<InferOkTypes<R> | undefined, InferErrTypes<R>>(undefined)
  }

  public static whenResult<
    Condition extends Result<boolean, unknown>,
    R extends Result<unknown, unknown>,
  >(this: void, condition: Condition, body: () => R): ResultWhenWithCondition<Condition, R> {
    if (condition.isErr()) {
      return err(condition.error as InferErrTypes<Condition>) as ResultWhenWithCondition<
        Condition,
        R
      >
    }

    if (condition.value) {
      return body() as ResultWhenWithCondition<Condition, R>
    }

    return ok<InferOkTypes<R> | undefined, InferErrTypes<R>>(undefined) as ResultWhenWithCondition<
      Condition,
      R
    >
  }

  public static unless<R extends Result<unknown, unknown>>(
    this: void,
    condition: ResultBooleanCondition,
    body: () => R,
  ): ResultWhen<R> {
    if (typeof condition === 'function' ? !condition() : !condition) {
      return body() as ResultWhen<R>
    }

    return ok<InferOkTypes<R> | undefined, InferErrTypes<R>>(undefined)
  }

  public static unlessResult<
    Condition extends Result<boolean, unknown>,
    R extends Result<unknown, unknown>,
  >(this: void, condition: Condition, body: () => R): ResultWhenWithCondition<Condition, R> {
    if (condition.isErr()) {
      return err(condition.error as InferErrTypes<Condition>) as ResultWhenWithCondition<
        Condition,
        R
      >
    }

    if (!condition.value) {
      return body() as ResultWhenWithCondition<Condition, R>
    }

    return ok<InferOkTypes<R> | undefined, InferErrTypes<R>>(undefined) as ResultWhenWithCondition<
      Condition,
      R
    >
  }

  public static loop<State, BodyState extends State, R extends Result<unknown, unknown>>(
    this: void,
    initial: State,
    options: ResultLoopOptions<State, BodyState, R>,
  ): ResultLoopCollected<R>
  public static loop<State, R extends Result<unknown, unknown>>(
    this: void,
    initial: State,
    options: ResultLoopBooleanOptions<State, R>,
  ): ResultLoopCollected<R>
  public static loop<State, BodyState extends State, R extends Result<unknown, unknown>>(
    this: void,
    initial: State,
    options: ResultLoopDiscardOptions<State, BodyState, R>,
  ): ResultLoopDiscarded<R>
  public static loop<State, R extends Result<unknown, unknown>>(
    this: void,
    initial: State,
    options: ResultLoopBooleanDiscardOptions<State, R>,
  ): ResultLoopDiscarded<R>
  public static loop<State, R extends Result<unknown, unknown>>(
    this: void,
    initial: State,
    options:
      | ResultLoopBooleanOptions<State, R>
      | ResultLoopBooleanDiscardOptions<State, R>
      | ResultLoopOptions<State, State, R>
      | ResultLoopDiscardOptions<State, State, R>,
  ): ResultLoopCollected<R> | ResultLoopDiscarded<R> {
    return loopResult(initial, options as ResultLoopRuntimeOptions<State, R>)
  }

  public static iterate<
    State,
    BodyState extends WidenLiteral<State>,
    R extends Result<WidenLiteral<State>, unknown>,
  >(
    this: void,
    initial: State,
    options: ResultIterateOptions<WidenLiteral<State>, BodyState, R>,
  ): ResultIterated<WidenLiteral<State>, R>
  public static iterate<State, R extends Result<WidenLiteral<State>, unknown>>(
    this: void,
    initial: State,
    options: ResultIterateBooleanOptions<WidenLiteral<State>, R>,
  ): ResultIterated<WidenLiteral<State>, R>
  public static iterate<State, R extends Result<WidenLiteral<State>, unknown>>(
    this: void,
    initial: State,
    options:
      | ResultIterateBooleanOptions<WidenLiteral<State>, R>
      | ResultIterateOptions<WidenLiteral<State>, WidenLiteral<State>, R>,
  ): ResultIterated<WidenLiteral<State>, R> {
    return iterateResult(
      initial as WidenLiteral<State>,
      options as ResultIterateRuntimeOptions<WidenLiteral<State>, R>,
    )
  }

  public static forEach<Item, R extends Result<unknown, unknown>>(
    this: void,
    items: Iterable<Item>,
    f: (value: Item, index: number) => R,
    options?: ResultForEachOptions,
  ): ResultForEachCollected<R>
  public static forEach<Item, R extends Result<unknown, unknown>>(
    this: void,
    items: Iterable<Item>,
    f: (value: Item, index: number) => R,
    options: ResultForEachDiscardOptions,
  ): ResultForEachDiscarded<R>
  public static forEach<Item, R extends Result<unknown, unknown>>(
    this: void,
    items: Iterable<Item>,
    f: (value: Item, index: number) => R,
    options?: ResultForEachOptions | ResultForEachDiscardOptions,
  ): ResultForEachCollected<R> | ResultForEachDiscarded<R> {
    return forEachResult(items, f, options)
  }
}

/** Static helpers for creating, combining, and iterating over Result values. */
export const Result: ResultStatic = ResultNamespace

abstract class ResultVariant<T, E> extends Pipeable {
  public filterOrElse<U extends T, F>(
    predicate: (value: T) => value is U,
    onFalse: (value: T) => F,
  ): Result<U, E | F>
  public filterOrElse<F>(
    predicate: (value: T) => boolean,
    onFalse: (value: T) => F,
  ): Result<T, E | F>
  public filterOrElse<F>(
    predicate: (value: T) => boolean,
    onFalse: (value: T) => F,
  ): Result<T, E | F> {
    return this.filterOrElseResult(predicate, onFalse)
  }

  public if(fCondition: (t: T) => boolean): {
    true: <X1, Y1>(
      fTrue: (t: T) => Result<X1, Y1>,
    ) => { false: <X2, Y2>(fFalse: (t: T) => Result<X2, Y2>) => Result<X1 | X2, Y1 | Y2 | E> }
  } {
    return {
      true: <X1, Y1>(fTrue: (t: T) => Result<X1, Y1>) => ({
        false: <X2, Y2>(fFalse: (t: T) => Result<X2, Y2>): Result<X1 | X2, Y1 | Y2 | E> =>
          this.branchResult(fCondition, fTrue, fFalse),
      }),
    }
  }

  public orElse<R extends Result<unknown, unknown>>(
    f: (e: E) => R,
  ): Result<InferOkTypes<R> | T, InferErrTypes<R>>
  public orElse<U, A>(f: (e: E) => Result<U, A>): Result<U | T, A>
  public orElse<U, A>(f: (e: E) => Result<U, A>): Result<U | T, A> {
    return this.orElseResult(f)
  }

  protected abstract filterOrElseResult<F>(
    predicate: (value: T) => boolean,
    onFalse: (value: T) => F,
  ): Result<T, E | F>

  protected abstract branchResult<X1, Y1, X2, Y2>(
    fCondition: (t: T) => boolean,
    fTrue: (t: T) => Result<X1, Y1>,
    fFalse: (t: T) => Result<X2, Y2>,
  ): Result<X1 | X2, Y1 | Y2 | E>

  protected abstract orElseResult<U, A>(f: (e: E) => Result<U, A>): Result<U | T, A>
}

class Ok<T, E> extends ResultVariant<T, E> {
  public readonly value: T

  public constructor(value: T) {
    super()
    this.value = value
  }

  public isOk(): this is OkResult<T, E> {
    void this
    return true
  }

  public isErr(): this is ErrResult<T, E> {
    void this
    return false
  }

  public map<X>(f: (t: T) => X): Result<X, E> {
    return ok<X, E>(f(this.value))
  }

  public as<X>(value: X): Result<X, E> {
    void this
    return ok<X, E>(value)
  }

  protected filterOrElseResult<F>(
    predicate: (value: T) => boolean,
    onFalse: (value: T) => F,
  ): Result<T, E | F> {
    if (predicate(this.value)) {
      return ok<T, E | F>(this.value)
    }

    return err<T, E | F>(onFalse(this.value))
  }

  public mapErr<X>(_fn: (t: E) => X): Result<T, X> {
    return ok<T, X>(this.value)
  }

  public andThen<X, Y>(f: (t: T) => Result<X, Y>): Result<X, E | Y> {
    return f(this.value)
  }

  protected orElseResult<U, A>(_f: (e: E) => Result<U, A>): Result<U | T, A> {
    return ok<U | T, A>(this.value as Exclude<T, Promise<any>>)
  }

  public catchTag<const Tag extends TagsOf<E>, R extends Result<unknown, unknown>>(
    _tag: Tag,
    _f: (error: ErrorForTag<E, Tag>) => R,
  ): Result<T | InferOkTypes<R>, ExcludeTag<E, Tag> | InferErrTypes<R>> {
    return ok(this.value)
  }

  public catchTags<const Handlers extends object>(
    _handlers: Handlers & CatchTagHandlers<E, Handlers>,
  ): Result<
    T | InferOkTypes<CatchTagHandlerResult<Handlers>>,
    ExcludeTag<E, keyof Handlers & string> | InferErrTypes<CatchTagHandlerResult<Handlers>>
  > {
    return ok(this.value)
  }

  public catchReason<
    const ErrorTag extends TagsWithReasonOf<E>,
    const ReasonTag extends ReasonTagsOf<E, ErrorTag>,
    R extends Result<unknown, unknown>,
  >(
    _errorTag: ErrorTag,
    _reasonTag: ReasonTag,
    _f: (reason: ReasonForTag<E, ErrorTag, ReasonTag>, error: ErrorForTag<E, ErrorTag>) => R,
  ): Result<T | InferOkTypes<R>, ExcludeReasonTag<E, ErrorTag, ReasonTag> | InferErrTypes<R>> {
    return ok(this.value)
  }

  public catchReasons<const ErrorTag extends TagsWithReasonOf<E>, const Handlers extends object>(
    _errorTag: ErrorTag,
    _handlers: Handlers & CatchReasonHandlers<E, ErrorTag, Handlers>,
  ): Result<
    T | InferOkTypes<CatchReasonHandlerResult<Handlers>>,
    | ExcludeReasonTag<E, ErrorTag, keyof Handlers & string>
    | InferErrTypes<CatchReasonHandlerResult<Handlers>>
  > {
    return ok(this.value)
  }

  public unwrapReason<const ErrorTag extends TagsWithReasonOf<E>>(
    _errorTag: ErrorTag,
  ): Result<T, ExcludeTag<E, ErrorTag> | ReasonsOf<E, ErrorTag>> {
    return ok(this.value)
  }

  protected branchResult<X1, Y1, X2, Y2>(
    fCondition: (t: T) => boolean,
    fTrue: (t: T) => Result<X1, Y1>,
    fFalse: (t: T) => Result<X2, Y2>,
  ): Result<X1 | X2, Y1 | Y2 | E> {
    return fCondition(this.value) ? fTrue(this.value) : fFalse(this.value)
  }

  public asyncAndThen<X, Y>(f: (t: T) => ResultAsync<X, Y>): ResultAsync<X, E | Y>
  public asyncAndThen<X, Y>(f: (t: T) => ResultAsync<X, E>): ResultAsync<X, E | Y> {
    return f(this.value)
  }

  public asyncMap<X>(f: (t: T) => Promise<X>): ResultAsync<X, E> {
    return createResultAsync<ResultAsync<X, E>>(
      Promise.resolve(f(this.value)).then((value) => ok<X, E>(value)),
    )
  }

  public unwrapOr<A>(_defaultValue: A): T | A {
    return this.value
  }

  public match<A, B = A>(handlers: MatchHandlers<T, E, A, B>): A | B
  public match<A, B = A>(fnOk: MatchOkHandler<T, A>, fnErr: MatchErrorHandler<E, B>): A | B
  public match<A, B = A>(
    input: MatchHandlers<T, E, A, B> | MatchOkHandler<T, A>,
    _fnErr?: MatchErrorHandler<E, B>,
  ): A | B {
    const fnOk = typeof input === 'function' ? input : input.ok

    return fnOk(this.value)
  }

  public matchTags<A, const Handlers extends object>(
    fnOk: (t: T) => A,
    _handlers: Handlers & MatchTagHandlers<E, Handlers>,
  ): A | MatchTagHandlerResult<Handlers> {
    return fnOk(this.value)
  }

  public matchTagsPartial<A, B, const Handlers extends object>(
    fnOk: (t: T) => A,
    _handlers: Handlers & PartialMatchTagHandlers<E, Handlers>,
    _fallback: (error: E) => B,
  ): A | MatchTagHandlerResult<Handlers> | B {
    return fnOk(this.value)
  }

  public log(fn: (t?: T, e?: E) => void): this {
    callSyncSideEffect(() => {
      fn(this.value, undefined)
    })
    return this
  }

  public tap(fn: (t: T) => void): this {
    callSyncSideEffect(() => {
      fn(this.value)
    })
    return this
  }

  public tapError(_fn: (e: E) => void): this {
    return this
  }

  public toDisposable(f: ResultFinalizer<T, E>): DisposableResult<T, E> {
    return new DisposableResult(this, f)
  }

  public unwrapOrThrow(): T {
    return this.value
  }

  public _unsafeUnwrap(_config?: ErrorConfig): T {
    return this.value
  }

  public _unsafeUnwrapErr(config?: ErrorConfig): E {
    throw createResultarError('Called `_unsafeUnwrapErr` on an Ok', this, config)
  }

  /* eslint-disable-next-line require-yield */
  public *[Symbol.iterator](): Generator<Result<never, E>, T> {
    return this.value
  }

  public safeUnwrap(): Generator<Result<never, E>, T> {
    const { value } = this
    /* eslint-disable-next-line require-yield */
    return (function* () {
      return value
    })()
  }
}

class Err<T, E> extends ResultVariant<T, E> {
  public readonly error: E

  public constructor(error: E) {
    super()
    this.error = error
  }

  public isOk(): this is OkResult<T, E> {
    void this
    return false
  }

  public isErr(): this is ErrResult<T, E> {
    void this
    return true
  }

  public map<X>(_f: (t: T) => X): Result<X, E> {
    return err<X, E>(this.error)
  }

  public as<X>(_value: X): Result<X, E> {
    return err<X, E>(this.error)
  }

  protected filterOrElseResult<F>(
    _predicate: (value: T) => boolean,
    _onFalse: (value: T) => F,
  ): Result<T, E | F> {
    return err<T, E | F>(this.error)
  }

  public mapErr<X>(fn: (t: E) => X): Result<T, X> {
    return err<T, X>(fn(this.error))
  }

  public andThen<X, Y>(_f: (t: T) => Result<X, Y>): Result<X, E | Y> {
    return err<X, E | Y>(this.error)
  }

  protected orElseResult<U, A>(f: (e: E) => Result<U, A>): Result<U | T, A> {
    return f(this.error)
  }

  protected branchResult<X1, Y1, X2, Y2>(
    _fCondition: (t: T) => boolean,
    _fTrue: (t: T) => Result<X1, Y1>,
    _fFalse: (t: T) => Result<X2, Y2>,
  ): Result<X1 | X2, Y1 | Y2 | E> {
    return err<X1 | X2, Y1 | Y2 | E>(this.error)
  }

  public catchTag<const Tag extends TagsOf<E>, R extends Result<unknown, unknown>>(
    tag: Tag,
    f: (error: ErrorForTag<E, Tag>) => R,
  ): Result<T | InferOkTypes<R>, ExcludeTag<E, Tag> | InferErrTypes<R>> {
    if (hasTag(this.error, tag)) {
      return f(this.error as ErrorForTag<E, Tag>) as Result<
        T | InferOkTypes<R>,
        ExcludeTag<E, Tag> | InferErrTypes<R>
      >
    }

    return err(this.error as ExcludeTag<E, Tag>)
  }

  public catchTags<const Handlers extends object>(
    handlers: Handlers & CatchTagHandlers<E, Handlers>,
  ): Result<
    T | InferOkTypes<CatchTagHandlerResult<Handlers>>,
    ExcludeTag<E, keyof Handlers & string> | InferErrTypes<CatchTagHandlerResult<Handlers>>
  > {
    const error = this.error
    const handled = callTaggedHandler<CatchTagHandlerResult<Handlers>>(error, handlers)

    if (isTaggedHandlerMatch(handled)) {
      return handled.value as Result<
        T | InferOkTypes<CatchTagHandlerResult<Handlers>>,
        ExcludeTag<E, keyof Handlers & string> | InferErrTypes<CatchTagHandlerResult<Handlers>>
      >
    }

    return err(error as ExcludeTag<E, keyof Handlers & string>)
  }

  public catchReason<
    const ErrorTag extends TagsWithReasonOf<E>,
    const ReasonTag extends ReasonTagsOf<E, ErrorTag>,
    R extends Result<unknown, unknown>,
  >(
    errorTag: ErrorTag,
    reasonTag: ReasonTag,
    f: (reason: ReasonForTag<E, ErrorTag, ReasonTag>, error: ErrorForTag<E, ErrorTag>) => R,
  ): Result<T | InferOkTypes<R>, ExcludeReasonTag<E, ErrorTag, ReasonTag> | InferErrTypes<R>> {
    if (hasTag(this.error, errorTag)) {
      const reason = getReason(this.error)

      if (hasTag(reason, reasonTag)) {
        return f(
          reason as ReasonForTag<E, ErrorTag, ReasonTag>,
          this.error as ErrorForTag<E, ErrorTag>,
        ) as Result<
          T | InferOkTypes<R>,
          ExcludeReasonTag<E, ErrorTag, ReasonTag> | InferErrTypes<R>
        >
      }
    }

    return err(this.error as ExcludeReasonTag<E, ErrorTag, ReasonTag>)
  }

  public catchReasons<const ErrorTag extends TagsWithReasonOf<E>, const Handlers extends object>(
    errorTag: ErrorTag,
    handlers: Handlers & CatchReasonHandlers<E, ErrorTag, Handlers>,
  ): Result<
    T | InferOkTypes<CatchReasonHandlerResult<Handlers>>,
    | ExcludeReasonTag<E, ErrorTag, keyof Handlers & string>
    | InferErrTypes<CatchReasonHandlerResult<Handlers>>
  > {
    if (hasTag(this.error, errorTag)) {
      const reason = getReason(this.error)

      if (typeof reason === 'object' && reason !== null && '_tag' in reason) {
        const handler = (handlers as Record<string, unknown>)[
          (reason as { readonly _tag: string })._tag
        ]

        if (handler !== undefined) {
          return (handler as (reason: unknown, error: unknown) => Result<unknown, unknown>)(
            reason,
            this.error,
          ) as Result<
            T | InferOkTypes<CatchReasonHandlerResult<Handlers>>,
            | ExcludeReasonTag<E, ErrorTag, keyof Handlers & string>
            | InferErrTypes<CatchReasonHandlerResult<Handlers>>
          >
        }
      }
    }

    return err(this.error as ExcludeReasonTag<E, ErrorTag, keyof Handlers & string>)
  }

  public unwrapReason<const ErrorTag extends TagsWithReasonOf<E>>(
    errorTag: ErrorTag,
  ): Result<T, ExcludeTag<E, ErrorTag> | ReasonsOf<E, ErrorTag>> {
    if (hasTag(this.error, errorTag)) {
      return err(getReason(this.error) as ReasonsOf<E, ErrorTag>)
    }

    return err(this.error as ExcludeTag<E, ErrorTag>)
  }

  public asyncAndThen<X, Y>(_f: (t: T) => ResultAsync<X, Y>): ResultAsync<X, E | Y>
  public asyncAndThen<X, Y>(_f: (t: T) => ResultAsync<X, E>): ResultAsync<X, E | Y> {
    return createResultAsync<ResultAsync<X, E | Y>>(Promise.resolve(err<X, E | Y>(this.error)))
  }

  public asyncMap<X>(_f: (t: T) => Promise<X>): ResultAsync<X, E> {
    return createResultAsync<ResultAsync<X, E>>(Promise.resolve(err<X, E>(this.error)))
  }

  public unwrapOr<A>(defaultValue: A): T | A {
    void this
    return defaultValue
  }

  public match<A, B = A>(handlers: MatchHandlers<T, E, A, B>): A | B
  public match<A, B = A>(fnOk: MatchOkHandler<T, A>, fnErr: MatchErrorHandler<E, B>): A | B
  public match<A, B = A>(
    input: MatchHandlers<T, E, A, B> | MatchOkHandler<T, A>,
    fnErr?: MatchErrorHandler<E, B>,
  ): A | B {
    const errorHandler = getMatchErrorHandler(input, fnErr)

    return errorHandler(this.error)
  }

  public matchTags<A, const Handlers extends object>(
    _fnOk: (t: T) => A,
    handlers: Handlers & MatchTagHandlers<E, Handlers>,
  ): A | MatchTagHandlerResult<Handlers> {
    return matchTaggedOr<E, MatchTagHandlerResult<Handlers>, never>(
      this.error,
      handlers,
      (error) => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw error
      },
    )
  }

  public matchTagsPartial<A, B, const Handlers extends object>(
    _fnOk: (t: T) => A,
    handlers: Handlers & PartialMatchTagHandlers<E, Handlers>,
    fallback: (error: E) => B,
  ): A | MatchTagHandlerResult<Handlers> | B {
    return matchTaggedOr<E, MatchTagHandlerResult<Handlers>, B>(this.error, handlers, fallback)
  }

  public log(fn: (t?: T, e?: E) => void): this {
    callSyncSideEffect(() => {
      fn(undefined, this.error)
    })
    return this
  }

  public tap(_fn: (t: T) => void): this {
    return this
  }

  public tapError(fn: (e: E) => void): this {
    callSyncSideEffect(() => {
      fn(this.error)
    })
    return this
  }

  public toDisposable(f: ResultFinalizer<T, E>): DisposableResult<T, E> {
    return new DisposableResult(this, f)
  }

  public unwrapOrThrow(): T {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw this.error as Error
  }

  public _unsafeUnwrap(config?: ErrorConfig): T {
    throw createResultarError('Called `_unsafeUnwrap` on an Err', this, config)
  }

  public _unsafeUnwrapErr(_config?: ErrorConfig): E {
    return this.error
  }

  public *[Symbol.iterator](): Generator<Result<never, E>, T> {
    yield this as never
    return this as never
  }

  public safeUnwrap(): Generator<Result<never, E>, T> {
    const { error } = this
    return (function* () {
      yield err(error)

      throw new Error('Do not use this generator out of `safeTry`')
    })()
  }
}

/**
 * A `Disposable` is an object that has a `dispose` method that can be used to
 * clean up resources.
 */
export class DisposableResult<T, E> implements Resultable<T, E>, Disposable {
  private disposed = false
  private readonly finalizer: (value: unknown, error: unknown) => void
  /**
   * Wrapped Result value.
   */
  public readonly result: Result<T, E>

  /**
   * Creates a disposable wrapper around a Result.
   */
  public constructor(result: Result<T, E>, finalizer: ResultFinalizer<T, E>) {
    this.result = result
    this.finalizer = finalizer as (value: unknown, error: unknown) => void
  }

  /**
   * Ok value when present, otherwise undefined cast to `T` for compatibility.
   */
  public get value(): T {
    return this.result.isOk() ? this.result.value : (undefined as T)
  }

  /**
   * Err value when present, otherwise undefined cast to `E` for compatibility.
   */
  public get error(): E {
    return this.result.isErr() ? this.result.error : (undefined as E)
  }

  /**
   * Delegates to the wrapped Result `_unsafeUnwrap`.
   */
  public _unsafeUnwrap(config?: ErrorConfig): T {
    return this.result._unsafeUnwrap(config)
  }

  /**
   * Delegates to the wrapped Result `_unsafeUnwrapErr`.
   */
  public _unsafeUnwrapErr(config?: ErrorConfig): E {
    return this.result._unsafeUnwrapErr(config)
  }

  /**
   * Returns whether the wrapped Result is Ok.
   */
  public isOk(): boolean {
    return this.result.isOk()
  }

  /**
   * Returns whether the wrapped Result is Err.
   */
  public isErr(): boolean {
    return this.result.isErr()
  }

  /**
   * Returns the wrapped Ok value, or `defaultValue` when Err.
   */
  public unwrapOr<A>(defaultValue: A): T | A {
    return this.result.unwrapOr(defaultValue)
  }

  /**
   * Runs the finalizer once.
   *
   * Finalizer exceptions are intentionally swallowed.
   */
  public [Symbol.dispose](): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
    try {
      this.finalizer(
        this.result.isOk() ? this.result.value : undefined,
        this.result.isErr() ? this.result.error : undefined,
      )
    } catch {
      /* empty */
    }
  }
}

/**
 * Evaluates a synchronous generator and returns the first yielded Err or returned Result.
 *
 * Inside the generator, use `yield* result` to unwrap Ok values and short-circuit on Err. The object
 * form can map thrown setup errors into the Result error channel.
 */
export function safeTry<T, E, CatchErr = E>(
  input: SafeTryOptions<Result<never, E>, Result<T, E>, CatchErr> & {
    readonly catch: (e: unknown) => CatchErr
  },
): Result<T, E | CatchErr>
export function safeTry<T, E>(
  input:
    | (() => Generator<Result<never, E>, Result<T, E>>)
    | SafeTryOptions<Result<never, E>, Result<T, E>>,
): Result<T, E>
export function safeTry<
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
export function safeTry<
  YieldErr extends Result<never, unknown>,
  GeneratorReturnResult extends Result<unknown, unknown>,
>(
  input:
    | (() => Generator<YieldErr, GeneratorReturnResult>)
    | SafeTryOptions<YieldErr, GeneratorReturnResult>,
): Result<
  InferOkTypes<GeneratorReturnResult>,
  InferErrTypes<YieldErr> | InferErrTypes<GeneratorReturnResult>
>

/**
 * Evaluates an async generator and returns a ResultAsync for the first yielded Err or returned
 * Result.
 *
 * Inside the generator, use `yield* result` or `yield* resultAsync` to unwrap Ok values and
 * short-circuit on Err. The object form can map thrown or rejected setup errors into the ResultAsync
 * error channel.
 */
export function safeTry<T, E, CatchErr = E>(
  input: SafeTryAsyncOptions<Result<never, E>, Result<T, E>, CatchErr> & {
    readonly catch: (e: unknown) => CatchErr
  },
): ResultAsync<T, E | CatchErr>
export function safeTry<T, E>(
  input:
    | (() => AsyncGenerator<Result<never, E>, Result<T, E>>)
    | SafeTryAsyncOptions<Result<never, E>, Result<T, E>>,
): ResultAsync<T, E>
export function safeTry<
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
export function safeTry<
  YieldErr extends Result<never, unknown>,
  GeneratorReturnResult extends Result<unknown, unknown>,
>(
  input:
    | (() => AsyncGenerator<YieldErr, GeneratorReturnResult>)
    | SafeTryAsyncOptions<YieldErr, GeneratorReturnResult>,
): ResultAsync<
  InferOkTypes<GeneratorReturnResult>,
  InferErrTypes<YieldErr> | InferErrTypes<GeneratorReturnResult>
>
export function safeTry<T, E, CatchErr = never>(
  input:
    | (() => Generator<Result<never, E>, Result<T, E>>)
    | (() => AsyncGenerator<Result<never, E>, Result<T, E>>)
    | SafeTryOptions<Result<never, E>, Result<T, E>, CatchErr>
    | SafeTryAsyncOptions<Result<never, E>, Result<T, E>, CatchErr>,
): Result<T, E | CatchErr> | ResultAsync<T, E | CatchErr> {
  const body = typeof input === 'function' ? input : input.try
  const catchFn = typeof input === 'function' ? undefined : input.catch
  let n:
    | IteratorResult<Result<never, E>, Result<T, E>>
    | Promise<IteratorResult<Result<never, E>, Result<T, E>>> = undefined as never

  try {
    n = body().next()
  } catch (error) {
    if (catchFn) {
      return err<T, E | CatchErr>(catchFn(error))
    }

    throw error
  }

  if (n instanceof Promise) {
    return createResultAsync<ResultAsync<T, E | CatchErr>>(
      n
        .then((r) => r.value)
        .catch((error: unknown) => {
          if (catchFn) {
            return err<T, E | CatchErr>(catchFn(error))
          }

          throw error
        }),
    )
  }

  return n.value
}

/**
 * Creates an Ok result.
 */
export function ok<T, E = never>(value: T): OkResult<T, E>
export function ok<E = never>(value: void): OkResult<void, E>
export function ok<T, E = never>(value: T): OkResult<T, E> {
  return new Ok<T, E>(value)
}

/**
 * Creates an Err result.
 */
export function err<T = never, E extends string = string>(err: E): ErrResult<T, E>
export function err<T = never, E = unknown>(err: E): ErrResult<T, E>
export function err<T = never>(err: void): ErrResult<T, void>
export function err<T = never, E = unknown>(error: E): ErrResult<T, E> {
  return new Err<T, E>(error)
}

/**
 * Wraps a throwing synchronous function so every later call returns a Result.
 *
 * Prefer `tryResult` when you want to run the operation immediately.
 */
export const fromThrowable: typeof Result.fromThrowable = Result.fromThrowable

/**
 * Runs synchronous work and captures thrown values into `Result<T, E>`.
 *
 * Use `tryResult` at the edge of uncontrolled synchronous code: JSON parsing, environment parsing,
 * platform APIs, or third-party functions that may throw. The mapper receives the thrown `unknown`
 * cause and returns the typed error for the Resultar channel.
 *
 * @example
 * ```ts
 * const config = tryResult(
 *   () => JSON.parse(input) as Config,
 *   (cause) => new ParseConfigError({ cause }),
 * )
 * ```
 */
export function tryResult<T, E>(
  fn: () => Exclude<T, Promise<unknown>>,
  errorFn: (e: unknown) => E,
): Result<T, E>
/**
 * Captures a synchronous boundary with named `try` and `catch` fields.
 *
 * This is equivalent to `tryResult(() => ..., toError)`, but it reads better when the boundary has
 * a clear domain name or label.
 */
export function tryResult<T, E>(
  options: TryResultOptions<T, E> & { readonly catch: (e: unknown) => E },
): Result<T, E>
/**
 * Runs synchronous work and captures thrown values into `Result<T, unknown>`.
 *
 * Prefer the overload with a catch mapper in application code so the error channel stays documented.
 * This overload is useful while adapting unknown external failures or during migration.
 */
export function tryResult<T>(
  input: (() => Exclude<T, Promise<unknown>>) | TryResultOptions<T>,
): Result<T, unknown>
export function tryResult<T, E = unknown>(
  input: (() => Exclude<T, Promise<unknown>>) | TryResultOptions<T, E>,
  errorFn?: (e: unknown) => E,
): Result<T, E> {
  const fn = typeof input === 'function' ? input : input.try
  const catchFn = typeof input === 'function' ? errorFn : input.catch

  try {
    return ok<T, E>(fn() as T)
  } catch (error) {
    if (catchFn) {
      return err<T, E>(catchFn(error))
    }

    return err<T, E>(error as E)
  }
}

/**
 * Creates an Ok result with `undefined`.
 */
export function unit<E = never>(): OkResult<undefined, E> {
  return ok<undefined, E>(undefined)
}

/**
 * Runs a `Result` at an application boundary and returns the success value.
 *
 * If the result is `Err`, this throws the error. Use it at final framework, CLI, test, or bootstrap
 * boundaries after the error channel has already been modeled with Resultar.
 */
export const runSync = <T, E>(result: Result<T, E>): T => result.unwrapOrThrow()

/** Compatibility alias. Prefer `tryResult` in new code. */
export const tryCatch: typeof tryResult = tryResult

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
export type Transpose<
  A,
  Transposed extends unknown[][] = [],
  Depth extends number = 10,
> = A extends [infer T, ...infer Rest]
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
type CombineResults<T extends readonly Result<unknown, unknown>[]> =
  IsLiteralArray<T> extends 1 ? Traverse<T> : Result<ExtractOkTypes<T>, ExtractErrTypes<T>[number]>

// Combines the array of results into one result with all errors.
type CombineResultsWithAllErrorsArray<T extends readonly Result<unknown, unknown>[]> =
  IsLiteralArray<T> extends 1
    ? TraverseWithAllErrors<T>
    : Result<ExtractOkTypes<T>, ExtractErrTypes<T>[number][]>

// #endregion
