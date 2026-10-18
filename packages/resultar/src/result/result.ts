import { dual } from '../core/dual.js'
import { type ErrorConfig, createResultarError } from '../core/error.js'
import { type FnPipe, Pipeable, runFnPipe } from '../core/pipe.js'
import type { InferErrTypes, InferOkTypes } from '../core/utils.js'
import {
  callTaggedHandler,
  hasTag,
  isTaggedHandlerMatch,
  matchTaggedOr,
} from '../tagged/tagged-match.js'
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
  ResultCatchReasonHandlers as CatchReasonHandlers,
  ResultCatchTagHandlers as CatchTagHandlers,
  TagsOf,
  TagsWithReasonOf,
} from '../tagged/tagged-types.js'
import { createResultAsync } from '../result-async/result-async-adapter.js'
import type { ResultAsync } from '../result-async/result-async.js'
import type { ResultAsyncAndThen, ResultAsyncMap } from '../result-async/async-types.js'
import type {
  AsyncResultGenGuard,
  AsyncResultGenOptions,
  LegacySafeTry,
  SafeTryAsyncOptions,
  SafeTryOptions,
} from '../result-async/generator-types.js'
import {
  callSyncSideEffect,
  createEmptyResultsCollectionError,
  DisposableResult,
  getMatchErrorHandler,
  getReason,
  isIterable,
  OkResultIterator,
} from './result-helpers.js'
import type {
  CombineResults,
  CombineResultsIterable,
  CombineResultsIterableWithAllErrors,
  CombineResultsRecord,
  CombineResultsRecordWithAllErrors,
  CombineResultsWithAllErrorsArray,
  ErrResult,
  FirstSuccessOf,
  MatchErrorHandler,
  MatchHandlers,
  MatchOkHandler,
  OkResult,
  ResultAndThen,
  ResultAs,
  ResultBooleanCondition,
  ResultCandidate,
  ResultCatchReason,
  ResultCatchReasons,
  ResultCatchTag,
  ResultCatchTags,
  ResultCondition,
  ResultConditionError,
  ResultFilterOrElse,
  ResultFinalizer,
  ResultFnBody,
  ResultFnGuard,
  ResultFnOutput,
  ResultForEachCollected,
  ResultForEachDiscardOptions,
  ResultForEachDiscarded,
  ResultForEachOptions,
  ResultForEachRuntimeOptions,
  ResultFromNullishOr,
  ResultGeneratorCatch,
  ResultGeneratorError,
  ResultGeneratorReturn,
  ResultGenOptions,
  ResultIf,
  ResultIfOptions,
  ResultInspect,
  ResultInspectBoth,
  ResultInspectError,
  ResultIterateBooleanOptions,
  ResultIterated,
  ResultIterateOptions,
  ResultIterateRuntimeOptions,
  ResultLiftPredicate,
  ResultLoopBooleanDiscardOptions,
  ResultLoopBooleanOptions,
  ResultLoopCollected,
  ResultLoopDiscardOptions,
  ResultLoopDiscarded,
  ResultLoopOptions,
  ResultLoopRuntimeOptions,
  ResultMap,
  ResultMapErr,
  ResultMatch,
  ResultMatchTags,
  ResultMatchTagsPartial,
  ResultOrElse,
  ResultOrElseSucceed,
  ResultRecord,
  ResultUnwrapOr,
  ResultUnwrapReason,
  ResultValidatedAll,
  ResultWhen,
  ResultWhenWithCondition,
  ResultZipped,
  ResultAsVoid,
  SyncResultGenGuard,
  TryResultOptions,
  WidenLiteral,
} from './result-types.js'

export { createEmptyResultsCollectionError, DisposableResult } from './result-helpers.js'
export type { AsyncResultGenOptions } from '../result-async/generator-types.js'
export type {
  ErrResult,
  OkResult,
  ResultGenerator,
  ResultGenOptions,
  ResultOperations,
  StrictResult,
  TryResultOptions,
} from './result-types.js'

export type Result<T, E> = OkResult<T, E> | ErrResult<T, E>

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

const whenByExpected = <Condition extends ResultCondition, R extends Result<unknown, unknown>>(
  condition: Condition,
  body: R | (() => R),
  expected: boolean,
): ResultWhen<R, ResultConditionError<Condition>> => {
  const rawCondition: ResultCondition = condition
  const evaluatedCondition = typeof rawCondition === 'function' ? rawCondition() : rawCondition

  if (typeof evaluatedCondition === 'boolean') {
    if (evaluatedCondition === expected) {
      return (typeof body === 'function' ? body() : body) as ResultWhen<
        R,
        ResultConditionError<Condition>
      >
    }

    return ok<InferOkTypes<R> | undefined, ResultConditionError<Condition> | InferErrTypes<R>>(
      undefined,
    )
  }

  if (evaluatedCondition.isErr()) {
    return err(evaluatedCondition.error as ResultConditionError<Condition>) as ResultWhen<
      R,
      ResultConditionError<Condition>
    >
  }

  if (evaluatedCondition.value !== expected) {
    return ok<InferOkTypes<R> | undefined, ResultConditionError<Condition> | InferErrTypes<R>>(
      undefined,
    )
  }

  return (typeof body === 'function' ? body() : body) as ResultWhen<
    R,
    ResultConditionError<Condition>
  >
}

const curryWhenByExpected =
  <Condition extends ResultCondition>(condition: Condition, expected: boolean) =>
  <Body extends Result<unknown, unknown>>(
    target: Body | (() => Body),
  ): ResultWhen<Body, ResultConditionError<Condition>> =>
    whenByExpected(condition, target, expected)

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

interface ResultStatic {
  /** Maps success in direct or curried form; callback exceptions propagate. */
  readonly map: ResultMap
  /** Maps failure in direct or curried form; callback exceptions propagate. */
  readonly mapErr: ResultMapErr
  /** Chains another Result in direct or curried form and combines its error channel. */
  readonly andThen: ResultAndThen
  /** Recovers the error channel in direct or curried form. */
  readonly orElse: ResultOrElse
  /** Recovers the error channel with a plain success value in direct or curried form. */
  readonly orElseSucceed: ResultOrElseSucceed
  /** Returns the Ok value or `defaultValue` when Err, in direct or curried form. */
  readonly unwrapOr: ResultUnwrapOr
  /** Recovers a specific tagged error in direct or curried form. */
  readonly catchTag: ResultCatchTag
  /** Recovers multiple tagged errors in direct or curried form. */
  readonly catchTags: ResultCatchTags
  /** Recovers a specific nested tagged reason on a tagged error in direct or curried form. */
  readonly catchReason: ResultCatchReason
  /** Recovers multiple nested tagged reasons on a tagged error in direct or curried form. */
  readonly catchReasons: ResultCatchReasons
  /** Moves the nested reason of a tagged error into the error channel in direct or curried form. */
  readonly unwrapReason: ResultUnwrapReason
  /** Observes success in direct or curried form and preserves the original Result. */
  readonly inspect: ResultInspect
  /** Observes failure in direct or curried form and preserves the original Result. */
  readonly inspectError: ResultInspectError
  /** Observes both branches in direct or curried form and preserves the original Result. */
  readonly inspectBoth: ResultInspectBoth
  /** Handles both branches in direct or curried form, using an object or two callbacks. */
  readonly match: ResultMatch
  /** Exhaustively matches success and tagged error cases in direct or curried form. */
  readonly matchTags: ResultMatchTags
  /** Partially matches tagged error cases with a narrowed fallback in direct or curried form. */
  readonly matchTagsPartial: ResultMatchTagsPartial
  /** Replaces the success value in direct or curried form. */
  readonly as: ResultAs
  /** Replaces the success value with `undefined` (`void`) in direct or curried form. */
  readonly asVoid: ResultAsVoid
  /** Validates success in direct or curried form, retaining refinement narrowing. */
  readonly filterOrElse: ResultFilterOrElse
  /** Chains eager ResultAsync work from success in direct or curried form. */
  readonly asyncAndThen: ResultAsyncAndThen
  /** Maps success with an eager Promise callback in direct or curried form. */
  readonly asyncMap: ResultAsyncMap
  /**
   * Runtime `instanceof Result` support for Ok and Err values.
   */
  [Symbol.hasInstance]: (value: unknown) => boolean
  /**
   * Runs a generator workflow that unwraps yielded Results and wraps the returned value in Ok,
   * matching `ResultTask.gen`.
   *
   * @example
   * ```ts
   * import { Result } from 'resultar'
   *
   * const outcome = Result.gen(function* () {
   *   const a = yield* Result.ok(10)
   *   const b = yield* Result.ok(32)
   *   return a + b
   * })
   * ```
   */
  gen: typeof resultGen
  /**
   * Wraps a synchronous or asynchronous generator function so each call runs a `Result.gen`
   * workflow, optionally piping the resulting `Result` or `ResultAsync` through post-body
   * operators.
   *
   * @example
   * ```ts
   * import { Result } from 'resultar'
   *
   * const parsePair = Result.fn(
   *   function* (rawA: string, rawB: string) {
   *     const a = yield* Result.liftPredicate(Number(rawA), Number.isFinite, () => 'BadA' as const)
   *     const b = yield* Result.liftPredicate(Number(rawB), Number.isFinite, () => 'BadB' as const)
   *     return a + b
   *   },
   *   Result.map((sum) => sum * 2),
   * )
   * ```
   */
  fn: typeof resultFn
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
   * Converts `null` or `undefined` to an `Err`; all other values (including `0`, `false`, and `""`)
   * become `Ok(NonNullable<A>)`. Supports direct and curried forms.
   *
   * @example
   * ```ts
   * import { Result } from 'resultar'
   *
   * const host = Result.fromNullishOr(process.env.HOST, () => 'MissingHost' as const)
   * ```
   */
  fromNullishOr: ResultFromNullishOr
  /**
   * Constructs a `Result` from a boolean predicate or TypeScript type-guard refinement.
   * Supports direct and curried forms; only a rejected input invokes `onFalse`.
   *
   * @example
   * ```ts
   * import { Result } from 'resultar'
   *
   * const positive = Result.liftPredicate(42, (n): n is number => n > 0, (n) => `non-positive:${n}`)
   * ```
   */
  liftPredicate: ResultLiftPredicate
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
   * Combines many Result values and stops at the first Err, matching `ResultTask.all` and `Promise.all`.
   *
   * Arrays return an Ok array, records return an Ok record with the same keys, and iterables return
   * an Ok readonly array.
   */
  all: {
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
   * Runs `body` only when the condition resolves to `true`; otherwise returns `Ok(undefined)`.
   */
  when: {
    <Condition extends ResultCondition, R extends Result<unknown, unknown>>(
      this: void,
      condition: Condition,
      body: R | (() => R),
    ): ResultWhen<R, ResultConditionError<Condition>>
    <Condition extends ResultCondition>(
      this: void,
      condition: Condition,
    ): <R extends Result<unknown, unknown>>(
      body: R | (() => R),
    ) => ResultWhen<R, ResultConditionError<Condition>>
  }
  /**
   * Runs `body` only when a Result boolean condition is Ok(true).
   */
  whenResult: <Condition extends Result<boolean, unknown>, R extends Result<unknown, unknown>>(
    this: void,
    condition: Condition,
    body: R | (() => R),
  ) => ResultWhenWithCondition<Condition, R>
  /**
   * Runs `body` only when the condition resolves to `false`; otherwise returns `Ok(undefined)`.
   */
  unless: {
    <Condition extends ResultCondition, R extends Result<unknown, unknown>>(
      this: void,
      condition: Condition,
      body: R | (() => R),
    ): ResultWhen<R, ResultConditionError<Condition>>
    <Condition extends ResultCondition>(
      this: void,
      condition: Condition,
    ): <R extends Result<unknown, unknown>>(
      body: R | (() => R),
    ) => ResultWhen<R, ResultConditionError<Condition>>
  }
  /**
   * Runs `body` only when a Result boolean condition is Ok(false).
   */
  unlessResult: <Condition extends Result<boolean, unknown>, R extends Result<unknown, unknown>>(
    this: void,
    condition: Condition,
    body: R | (() => R),
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
  public static readonly map: ResultMap = dual(
    (args) => args.length === 2,
    (self: Result<unknown, unknown>, f: (value: unknown) => unknown) => self.map(f),
  ) as ResultMap

  public static readonly mapErr: ResultMapErr = dual(
    (args) => args.length === 2,
    (self: Result<unknown, unknown>, f: (error: unknown) => unknown) => self.mapErr(f),
  ) as ResultMapErr

  public static readonly andThen: ResultAndThen = dual(
    (args) => args.length === 2,
    (self: Result<unknown, unknown>, f: (value: unknown) => Result<unknown, unknown>) =>
      self.andThen(f),
  ) as ResultAndThen

  public static readonly orElse: ResultOrElse = dual(
    (args) => args.length === 2,
    (self: Result<unknown, unknown>, f: (error: unknown) => Result<unknown, unknown>) =>
      self.orElse(f),
  ) as ResultOrElse

  public static readonly orElseSucceed: ResultOrElseSucceed = dual(
    (args) => args.length === 2,
    (self: Result<unknown, unknown>, f: (error: unknown) => unknown) => self.orElseSucceed(f),
  ) as ResultOrElseSucceed

  public static readonly unwrapOr: ResultUnwrapOr = dual(
    (args) => args.length === 2,
    (self: Result<unknown, unknown>, defaultValue: unknown) => self.unwrapOr(defaultValue),
  ) as ResultUnwrapOr

  public static readonly catchTag: ResultCatchTag = dual(
    (args) => args.length === 3,
    (self: Result<unknown, unknown>, tag: string, f: (error: never) => Result<unknown, unknown>) =>
      self.catchTag(tag as never, f),
  ) as ResultCatchTag

  public static readonly catchTags: ResultCatchTags = dual(
    (args) => args.length === 2,
    (self: Result<unknown, unknown>, handlers: Record<string, never>) => self.catchTags(handlers),
  ) as ResultCatchTags

  /* eslint-disable max-params */
  public static readonly catchReason: ResultCatchReason = dual(
    (args) => args.length === 4,
    (
      self: Result<unknown, unknown>,
      errorTag: string,
      reasonTag: string,
      f: (reason: never, error: never) => Result<unknown, unknown>,
    ) => self.catchReason(errorTag as never, reasonTag as never, f),
  ) as ResultCatchReason
  /* eslint-enable max-params */

  public static readonly catchReasons: ResultCatchReasons = dual(
    (args) => args.length === 3,
    (self: Result<unknown, unknown>, errorTag: string, handlers: Record<string, never>) =>
      self.catchReasons(errorTag as never, handlers),
  ) as ResultCatchReasons

  public static readonly unwrapReason: ResultUnwrapReason = dual(
    (args) => args.length === 2,
    (self: Result<unknown, unknown>, errorTag: string) => self.unwrapReason(errorTag as never),
  ) as ResultUnwrapReason

  public static readonly inspect: ResultInspect = dual(
    (args) => args.length === 2,
    (self: Result<unknown, unknown>, f: (value: unknown) => void) => self.inspect(f),
  ) as ResultInspect

  public static readonly inspectError: ResultInspectError = dual(
    (args) => args.length === 2,
    (self: Result<unknown, unknown>, f: (error: unknown) => void) => self.inspectError(f),
  ) as ResultInspectError

  public static readonly inspectBoth: ResultInspectBoth = dual(
    (args) => args.length === 3 || (args.length === 2 && typeof args[0] !== 'function'),
    (
      self: Result<unknown, unknown>,
      handlers: MatchHandlers<unknown, unknown, void, void> | ((value: unknown) => void),
      fnErr?: (error: unknown) => void,
    ): Result<unknown, unknown> =>
      typeof handlers === 'function'
        ? self.inspectBoth(handlers, getMatchErrorHandler(handlers, fnErr))
        : self.inspectBoth(handlers),
  ) as ResultInspectBoth

  public static readonly match: ResultMatch = dual(
    (args) => args.length === 3 || (args.length === 2 && typeof args[0] !== 'function'),
    (
      self: Result<unknown, unknown>,
      handlers: MatchHandlers<unknown, unknown, unknown> | MatchOkHandler<unknown, unknown>,
      fnErr?: MatchErrorHandler<unknown, unknown>,
    ): unknown =>
      typeof handlers === 'function'
        ? self.match(handlers, getMatchErrorHandler(handlers, fnErr))
        : self.match(handlers),
  ) as ResultMatch

  public static readonly matchTags: ResultMatchTags = dual(
    (args) => args.length === 3,
    (self: Result<unknown, unknown>, fnOk: (value: unknown) => unknown, handlers: never) =>
      self.matchTags(fnOk, handlers),
  ) as ResultMatchTags

  /* eslint-disable max-params */
  public static readonly matchTagsPartial: ResultMatchTagsPartial = dual(
    (args) => args.length === 4,
    (
      self: Result<unknown, unknown>,
      fnOk: (value: unknown) => unknown,
      handlers: never,
      fallback: (error: unknown) => unknown,
    ) => self.matchTagsPartial(fnOk, handlers, fallback),
  ) as ResultMatchTagsPartial
  /* eslint-enable max-params */

  public static readonly as: ResultAs = dual(
    (args) => args.length === 2,
    (self: Result<unknown, unknown>, value: unknown) => self.as(value),
  ) as ResultAs

  public static readonly asVoid: ResultAsVoid = ((...args: readonly unknown[]): unknown => {
    if (args.length === 0) {
      return (self: Result<unknown, unknown>) => self.asVoid()
    }
    return (args[0] as Result<unknown, unknown>).asVoid()
  }) as ResultAsVoid

  public static readonly filterOrElse: ResultFilterOrElse = dual(
    (args) => args.length === 3,
    (
      self: Result<unknown, unknown>,
      predicate: (value: unknown) => boolean,
      onFalse: (value: unknown) => unknown,
    ) => self.filterOrElse(predicate, onFalse),
  ) as ResultFilterOrElse

  public static readonly asyncAndThen: ResultAsyncAndThen = dual(
    (args) => args.length === 2,
    (self: Result<unknown, unknown>, f: (value: unknown) => ResultAsync<unknown, unknown>) =>
      self.asyncAndThen(f),
  ) as ResultAsyncAndThen

  public static readonly asyncMap: ResultAsyncMap = dual(
    (args) => args.length === 2,
    (self: Result<unknown, unknown>, f: (value: unknown) => Promise<unknown>) => self.asyncMap(f),
  ) as ResultAsyncMap

  public static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Ok || value instanceof Err
  }

  /**
   * Runs a generator that returns a plain success value and composes Results with `yield*`.
   */
  public static readonly gen: typeof resultGen = resultGen

  /**
   * Wraps a synchronous or asynchronous generator function so each call runs a `Result.gen`
   * workflow.
   */
  public static readonly fn: typeof resultFn = resultFn

  /** Converts nullish values to typed failures without rejecting other falsy values. */
  public static readonly fromNullishOr: ResultFromNullishOr = dual(
    (args) => args.length === 2,
    (value: unknown, onNullish: (value: unknown) => unknown): Result<unknown, unknown> =>
      value === null || value === undefined ? err(onNullish(value)) : ok(value),
  ) as ResultFromNullishOr

  /** Lifts a value into a Result using a predicate or narrowing refinement. */
  public static readonly liftPredicate: ResultLiftPredicate = dual(
    (args) => args.length === 3,
    (
      value: unknown,
      predicate: (value: unknown) => boolean,
      onFalse: (value: unknown) => unknown,
    ): Result<unknown, unknown> => (predicate(value) ? ok(value) : err(onFalse(value))),
  ) as ResultLiftPredicate

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
    if (errorFn) {
      return function (this: unknown, a?: unknown): Result<ReturnType<Fn>, E> {
        try {
          /* Stryker disable all: 0/1-arg fast-path avoids rest array allocation and is equivalent to Reflect.apply. */
          if (this === undefined && arguments.length <= 1) {
            return ok((fn as (arg?: unknown) => ReturnType<Fn>)(a))
          }
          /* Stryker restore all */
          // eslint-disable-next-line prefer-rest-params
          return ok(Reflect.apply(fn, this, arguments) as ReturnType<Fn>)
        } catch (error) {
          return err(errorFn(error))
        }
      } as unknown as (...args: Parameters<Fn>) => Result<ReturnType<Fn>, E>
    }
    return function (this: unknown, a?: unknown): Result<ReturnType<Fn>, E> {
      try {
        /* Stryker disable all: 0/1-arg fast-path avoids rest array allocation and is equivalent to Reflect.apply. */
        if (this === undefined && arguments.length <= 1) {
          return ok((fn as (arg?: unknown) => ReturnType<Fn>)(a))
        }
        /* Stryker restore all */
        // eslint-disable-next-line prefer-rest-params
        return ok(Reflect.apply(fn, this, arguments) as ReturnType<Fn>)
      } catch (error) {
        return err(error as E)
      }
    } as unknown as (...args: Parameters<Fn>) => Result<ReturnType<Fn>, E>
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

  public static all<T extends readonly [Result<unknown, unknown>, ...Result<unknown, unknown>[]]>(
    this: void,
    resultList: T,
  ): CombineResults<T>
  public static all<T extends readonly Result<unknown, unknown>[]>(
    this: void,
    resultList: T,
  ): CombineResults<T>
  public static all<T extends ResultRecord>(this: void, resultRecord: T): CombineResultsRecord<T>
  public static all<R extends Result<unknown, unknown>>(
    this: void,
    results: Iterable<R>,
  ): CombineResultsIterable<R>
  public static all<
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
    return ResultNamespace.combine(input as readonly Result<unknown, unknown>[]) as CombineResults<
      T & readonly Result<unknown, unknown>[]
    >
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

  public static when<Condition extends ResultCondition, R extends Result<unknown, unknown>>(
    this: void,
    condition: Condition,
    body: R | (() => R),
  ): ResultWhen<R, ResultConditionError<Condition>>
  public static when<Condition extends ResultCondition>(
    this: void,
    condition: Condition,
  ): <R extends Result<unknown, unknown>>(
    body: R | (() => R),
  ) => ResultWhen<R, ResultConditionError<Condition>>
  public static when<Condition extends ResultCondition, R extends Result<unknown, unknown>>(
    this: void,
    condition: Condition,
    body?: R | (() => R),
  ):
    | ResultWhen<R, ResultConditionError<Condition>>
    | (<Body extends Result<unknown, unknown>>(
        target: Body | (() => Body),
      ) => ResultWhen<Body, ResultConditionError<Condition>>) {
    if (body === undefined) {
      return curryWhenByExpected(condition, true)
    }

    return whenByExpected(condition, body, true)
  }

  public static whenResult<
    Condition extends Result<boolean, unknown>,
    R extends Result<unknown, unknown>,
  >(this: void, condition: Condition, body: R | (() => R)): ResultWhenWithCondition<Condition, R> {
    return whenByExpected(condition, body, true)
  }

  public static unless<Condition extends ResultCondition, R extends Result<unknown, unknown>>(
    this: void,
    condition: Condition,
    body: R | (() => R),
  ): ResultWhen<R, ResultConditionError<Condition>>
  public static unless<Condition extends ResultCondition>(
    this: void,
    condition: Condition,
  ): <R extends Result<unknown, unknown>>(
    body: R | (() => R),
  ) => ResultWhen<R, ResultConditionError<Condition>>
  public static unless<Condition extends ResultCondition, R extends Result<unknown, unknown>>(
    this: void,
    condition: Condition,
    body?: R | (() => R),
  ):
    | ResultWhen<R, ResultConditionError<Condition>>
    | (<Body extends Result<unknown, unknown>>(
        target: Body | (() => Body),
      ) => ResultWhen<Body, ResultConditionError<Condition>>) {
    if (body === undefined) {
      return curryWhenByExpected(condition, false)
    }

    return whenByExpected(condition, body, false)
  }

  public static unlessResult<
    Condition extends Result<boolean, unknown>,
    R extends Result<unknown, unknown>,
  >(this: void, condition: Condition, body: R | (() => R)): ResultWhenWithCondition<Condition, R> {
    return whenByExpected(condition, body, false)
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

  public when<Condition extends ResultCondition>(
    condition: Condition,
  ): Result<T | undefined, E | ResultConditionError<Condition>> {
    return Result.when(condition, this as unknown as Result<T, E>)
  }

  public unless<Condition extends ResultCondition>(
    condition: Condition,
  ): Result<T | undefined, E | ResultConditionError<Condition>> {
    return Result.unless(condition, this as unknown as Result<T, E>)
  }

  public orElseSucceed<A>(f: (e: E) => A): Result<T | A, never> {
    return this.orElse((error) => ok<A, never>(f(error)))
  }

  public asVoid(): Result<void, E> {
    return this.as(undefined)
  }

  /** @deprecated Use inspect; the original best-effort behavior is preserved. */
  public tap(fn: (value: T) => void): this {
    return this.inspect(fn)
  }

  /** @deprecated Use inspectError; the original best-effort behavior is preserved. */
  public tapError(fn: (error: E) => void): this {
    return this.inspectError(fn)
  }

  public toDisposable(f: ResultFinalizer<T, E>): DisposableResult<T, E> {
    return new DisposableResult(this as unknown as Result<T, E>, f)
  }

  public abstract as<X>(value: X): Result<X, E>

  public abstract inspect(fn: (t: T) => void): this

  public abstract inspectError(fn: (e: E) => void): this

  public abstract orElse<R extends Result<unknown, unknown>>(
    f: (e: E) => R,
  ): Result<InferOkTypes<R> | T, InferErrTypes<R>>
  public abstract orElse<U, A>(f: (e: E) => Result<U, A>): Result<U | T, A>

  protected abstract branchResult<X1, Y1, X2, Y2>(
    fCondition: (t: T) => boolean,
    fTrue: (t: T) => Result<X1, Y1>,
    fFalse: (t: T) => Result<X2, Y2>,
  ): Result<X1 | X2, Y1 | Y2 | E>
}

class Ok<T, E> {
  public readonly value: T

  public constructor(value: T) {
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

  public orElse<R extends Result<unknown, unknown>>(
    _f: (e: E) => R,
  ): Result<InferOkTypes<R> | T, InferErrTypes<R>>
  public orElse<U, A>(_f: (e: E) => Result<U, A>): Result<U | T, A>
  public orElse<U, A>(_f: (e: E) => Result<U, A>): Result<U | T, A> {
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
    | ExcludeTag<E, CoveredHandlerKeys<Handlers> & string>
    | InferErrTypes<CatchTagHandlerResult<Handlers>>
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
    | ExcludeReasonTag<E, ErrorTag, CoveredHandlerKeys<Handlers> & string>
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
    return typeof input === 'function' ? input(this.value) : input.ok(this.value)
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

  public inspect(fn: (t: T) => void): this {
    callSyncSideEffect(() => {
      fn(this.value)
    })
    return this
  }

  public inspectError(_fn: (e: E) => void): this {
    return this
  }

  public inspectBoth(handlers: MatchHandlers<T, E, void, void>): this
  public inspectBoth(fnOk: (t: T) => void, fnErr: (e: E) => void): this
  public inspectBoth(
    input: MatchHandlers<T, E, void, void> | ((t: T) => void),
    _fnErr?: (e: E) => void,
  ): this {
    return this.inspect(typeof input === 'function' ? input : input.ok)
  }

  public unwrapOrThrow(): T {
    return this.value
  }

  public _unsafeUnwrap(_config?: ErrorConfig): T {
    return this.value
  }

  public _unsafeUnwrapErr(config?: ErrorConfig): E {
    throw createResultarError(
      'Called `_unsafeUnwrapErr` on an Ok',
      this as unknown as Result<T, E>,
      config,
    )
  }

  public [Symbol.iterator](): Generator<Result<never, E>, T> {
    return new OkResultIterator(this.value) as unknown as Generator<Result<never, E>, T>
  }

  /** @deprecated Use `yield* result` inside Result.gen. */
  public safeUnwrap(): Generator<Result<never, E>, T> {
    const { value } = this
    /* eslint-disable-next-line require-yield */
    return (function* () {
      return value
    })()
  }
}

class Err<T, E> {
  public readonly error: E

  public constructor(error: E) {
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

  public filterOrElse<U extends T, F>(
    predicate: (value: T) => value is U,
    onFalse: (value: T) => F,
  ): Result<U, E | F>
  public filterOrElse<F>(
    predicate: (value: T) => boolean,
    onFalse: (value: T) => F,
  ): Result<T, E | F>
  public filterOrElse<F>(
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

  public orElse<R extends Result<unknown, unknown>>(
    f: (e: E) => R,
  ): Result<InferOkTypes<R> | T, InferErrTypes<R>>
  public orElse<U, A>(f: (e: E) => Result<U, A>): Result<U | T, A>
  public orElse<U, A>(f: (e: E) => Result<U, A>): Result<U | T, A> {
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
    | ExcludeTag<E, CoveredHandlerKeys<Handlers> & string>
    | InferErrTypes<CatchTagHandlerResult<Handlers>>
  > {
    const error = this.error
    const handled = callTaggedHandler<CatchTagHandlerResult<Handlers>>(error, handlers)

    if (isTaggedHandlerMatch(handled)) {
      return handled.value as Result<
        T | InferOkTypes<CatchTagHandlerResult<Handlers>>,
        | ExcludeTag<E, CoveredHandlerKeys<Handlers> & string>
        | InferErrTypes<CatchTagHandlerResult<Handlers>>
      >
    }

    return err(error as ExcludeTag<E, CoveredHandlerKeys<Handlers> & string>)
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
    | ExcludeReasonTag<E, ErrorTag, CoveredHandlerKeys<Handlers> & string>
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
            | ExcludeReasonTag<E, ErrorTag, CoveredHandlerKeys<Handlers> & string>
            | InferErrTypes<CatchReasonHandlerResult<Handlers>>
          >
        }
      }
    }

    return err(this.error as ExcludeReasonTag<E, ErrorTag, CoveredHandlerKeys<Handlers> & string>)
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

  public inspect(_fn: (t: T) => void): this {
    return this
  }

  public inspectError(fn: (e: E) => void): this {
    callSyncSideEffect(() => {
      fn(this.error)
    })
    return this
  }

  public inspectBoth(handlers: MatchHandlers<T, E, void, void>): this
  public inspectBoth(fnOk: (t: T) => void, fnErr: (e: E) => void): this
  public inspectBoth(
    input: MatchHandlers<T, E, void, void> | ((t: T) => void),
    fnErr?: (e: E) => void,
  ): this {
    return this.inspectError(getMatchErrorHandler(input, fnErr))
  }

  public unwrapOrThrow(): T {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw this.error as Error
  }

  public _unsafeUnwrap(config?: ErrorConfig): T {
    throw createResultarError(
      'Called `_unsafeUnwrap` on an Err',
      this as unknown as Result<T, E>,
      config,
    )
  }

  public _unsafeUnwrapErr(_config?: ErrorConfig): E {
    return this.error
  }

  public *[Symbol.iterator](): Generator<Result<never, E>, T> {
    yield this as never
    return this as never
  }

  /** @deprecated Use `yield* result` inside Result.gen. */
  public safeUnwrap(): Generator<Result<never, E>, T> {
    const { error } = this
    return (function* () {
      yield err(error)

      throw new Error('Do not use this generator out of `safeTry`')
    })()
  }
}

/* Stryker disable all: copying shared methods onto Ok/Err prototypes avoids derived constructor super() overhead while keeping V8 fast prototype mode. */
const copyPrototypeMethods = (target: object, source: object): void => {
  for (const name of Object.getOwnPropertyNames(source)) {
    if (name !== 'constructor') {
      ;(target as Record<string, unknown>)[name] = (source as Record<string, unknown>)[name]
    }
  }
}
copyPrototypeMethods(Ok.prototype, Pipeable.prototype)
copyPrototypeMethods(Ok.prototype, ResultVariant.prototype)
copyPrototypeMethods(Err.prototype, Pipeable.prototype)
copyPrototypeMethods(Err.prototype, ResultVariant.prototype)
/* Stryker restore all */

const resultGenStep = (
  step: IteratorResult<Result<never, unknown>, unknown>,
): Result<unknown, unknown> => (step.done === true ? ok(step.value) : step.value)

const safeTryStep = (
  step: IteratorResult<Result<never, unknown>, unknown>,
): Result<unknown, unknown> => step.value as Result<unknown, unknown>

const runResultGenerator = (
  input:
    | (() => Generator<Result<never, unknown>, unknown>)
    | (() => AsyncGenerator<Result<never, unknown>, unknown>)
    | ResultGenOptions<Result<never, unknown>, unknown, unknown>
    | AsyncResultGenOptions<Result<never, unknown>, unknown, unknown>,
  onStep: (step: IteratorResult<Result<never, unknown>, unknown>) => Result<unknown, unknown>,
): Result<unknown, unknown> | ResultAsync<unknown, unknown> => {
  const body = typeof input === 'function' ? input : input.try
  const catchFn = typeof input === 'function' ? undefined : input.catch
  let n:
    | IteratorResult<Result<never, unknown>, unknown>
    | Promise<IteratorResult<Result<never, unknown>, unknown>> = undefined as never

  try {
    n = body().next()
    if (!(n instanceof Promise)) return onStep(n)
  } catch (error) {
    if (catchFn) {
      return err(catchFn(error))
    }

    throw error
  }

  return createResultAsync<ResultAsync<unknown, unknown>>(
    n.then(onStep).catch((error: unknown) => {
      if (catchFn) {
        return err(catchFn(error))
      }

      throw error
    }),
  )
}

/**
 * Evaluates a synchronous or asynchronous generator and returns the first yielded Err or wraps the
 * returned value in Ok(value).
 *
 * Inside the generator, use `yield* result` (or `yield* resultAsync` in async generators) to unwrap
 * Ok values and short-circuit on Err. The object form can map thrown or rejected setup errors into
 * the error channel.
 */
function resultGen<Body extends () => Generator<Result<never, unknown>, unknown>>(
  input: Body & SyncResultGenGuard<ResultGeneratorReturn<ReturnType<Body>>>,
): Result<ResultGeneratorReturn<ReturnType<Body>>, ResultGeneratorError<ReturnType<Body>>>
function resultGen<Input extends ResultGenOptions<Result<never, unknown>, unknown, unknown>>(
  input: Input & SyncResultGenGuard<ResultGeneratorReturn<ReturnType<Input['try']>>>,
): Result<
  ResultGeneratorReturn<ReturnType<Input['try']>>,
  ResultGeneratorError<ReturnType<Input['try']>> | ResultGeneratorCatch<Input>
>
function resultGen<Body extends () => AsyncGenerator<Result<never, unknown>, unknown>>(
  input: Body & AsyncResultGenGuard<ResultGeneratorReturn<ReturnType<Body>>>,
): ResultAsync<ResultGeneratorReturn<ReturnType<Body>>, ResultGeneratorError<ReturnType<Body>>>
function resultGen<Input extends AsyncResultGenOptions<Result<never, unknown>, unknown, unknown>>(
  input: Input & AsyncResultGenGuard<ResultGeneratorReturn<ReturnType<Input['try']>>>,
): ResultAsync<
  ResultGeneratorReturn<ReturnType<Input['try']>>,
  ResultGeneratorError<ReturnType<Input['try']>> | ResultGeneratorCatch<Input>
>
function resultGen(
  input:
    | (() => Generator<Result<never, unknown>, unknown>)
    | (() => AsyncGenerator<Result<never, unknown>, unknown>)
    | ResultGenOptions<Result<never, unknown>, unknown, unknown>
    | AsyncResultGenOptions<Result<never, unknown>, unknown, unknown>,
): Result<unknown, unknown> | ResultAsync<unknown, unknown> {
  return runResultGenerator(input, resultGenStep)
}

/* eslint-disable max-params */
function resultFn<Body extends ResultFnBody>(
  body: Body & ResultFnGuard<Body>,
): (this: ThisParameterType<Body>, ...args: Parameters<Body>) => ResultFnOutput<Body>
function resultFn<Body extends ResultFnBody, A>(
  body: Body & ResultFnGuard<Body>,
  ab: FnPipe<ResultFnOutput<Body>, Parameters<Body>, A>,
): (this: ThisParameterType<Body>, ...args: Parameters<Body>) => A
function resultFn<Body extends ResultFnBody, A, B>(
  body: Body & ResultFnGuard<Body>,
  ab: FnPipe<ResultFnOutput<Body>, Parameters<Body>, A>,
  bc: FnPipe<A, Parameters<Body>, B>,
): (this: ThisParameterType<Body>, ...args: Parameters<Body>) => B
function resultFn<Body extends ResultFnBody, A, B, C>(
  body: Body & ResultFnGuard<Body>,
  ab: FnPipe<ResultFnOutput<Body>, Parameters<Body>, A>,
  bc: FnPipe<A, Parameters<Body>, B>,
  cd: FnPipe<B, Parameters<Body>, C>,
): (this: ThisParameterType<Body>, ...args: Parameters<Body>) => C
function resultFn<Body extends ResultFnBody, A, B, C, D>(
  body: Body & ResultFnGuard<Body>,
  ab: FnPipe<ResultFnOutput<Body>, Parameters<Body>, A>,
  bc: FnPipe<A, Parameters<Body>, B>,
  cd: FnPipe<B, Parameters<Body>, C>,
  de: FnPipe<C, Parameters<Body>, D>,
): (this: ThisParameterType<Body>, ...args: Parameters<Body>) => D
function resultFn<Body extends ResultFnBody, A, B, C, D, E>(
  body: Body & ResultFnGuard<Body>,
  ab: FnPipe<ResultFnOutput<Body>, Parameters<Body>, A>,
  bc: FnPipe<A, Parameters<Body>, B>,
  cd: FnPipe<B, Parameters<Body>, C>,
  de: FnPipe<C, Parameters<Body>, D>,
  ef: FnPipe<D, Parameters<Body>, E>,
): (this: ThisParameterType<Body>, ...args: Parameters<Body>) => E
function resultFn<Body extends ResultFnBody, A, B, C, D, E, F>(
  body: Body & ResultFnGuard<Body>,
  ab: FnPipe<ResultFnOutput<Body>, Parameters<Body>, A>,
  bc: FnPipe<A, Parameters<Body>, B>,
  cd: FnPipe<B, Parameters<Body>, C>,
  de: FnPipe<C, Parameters<Body>, D>,
  ef: FnPipe<D, Parameters<Body>, E>,
  fg: FnPipe<E, Parameters<Body>, F>,
): (this: ThisParameterType<Body>, ...args: Parameters<Body>) => F
function resultFn<Body extends ResultFnBody, A, B, C, D, E, F, G>(
  body: Body & ResultFnGuard<Body>,
  ab: FnPipe<ResultFnOutput<Body>, Parameters<Body>, A>,
  bc: FnPipe<A, Parameters<Body>, B>,
  cd: FnPipe<B, Parameters<Body>, C>,
  de: FnPipe<C, Parameters<Body>, D>,
  ef: FnPipe<D, Parameters<Body>, E>,
  fg: FnPipe<E, Parameters<Body>, F>,
  gh: FnPipe<F, Parameters<Body>, G>,
): (this: ThisParameterType<Body>, ...args: Parameters<Body>) => G
function resultFn<Body extends ResultFnBody, A, B, C, D, E, F, G, H>(
  body: Body & ResultFnGuard<Body>,
  ab: FnPipe<ResultFnOutput<Body>, Parameters<Body>, A>,
  bc: FnPipe<A, Parameters<Body>, B>,
  cd: FnPipe<B, Parameters<Body>, C>,
  de: FnPipe<C, Parameters<Body>, D>,
  ef: FnPipe<D, Parameters<Body>, E>,
  fg: FnPipe<E, Parameters<Body>, F>,
  gh: FnPipe<F, Parameters<Body>, G>,
  hi: FnPipe<G, Parameters<Body>, H>,
): (this: ThisParameterType<Body>, ...args: Parameters<Body>) => H
function resultFn<Body extends ResultFnBody>(
  body: Body,
  ...fns: readonly FnPipe<never, readonly never[], unknown>[]
): (this: ThisParameterType<Body>, ...args: Parameters<Body>) => unknown {
  return function (this: ThisParameterType<Body>, ...args: Parameters<Body>): unknown {
    const initial = runResultGenerator(
      () =>
        (
          body as (
            this: ThisParameterType<Body>,
            ...input: Parameters<Body>
          ) => Generator<Result<never, unknown>, unknown>
        ).call(this, ...args),
      resultGenStep,
    )
    return runFnPipe(initial, args, fns)
  }
}
/* eslint-enable max-params */

/** @deprecated Use Result.gen or ResultTask.gen with plain success returns; this helper retains its returned Result contract. */
export const safeTry: LegacySafeTry = ((
  input:
    | (() => Generator<Result<never, unknown>, Result<unknown, unknown>>)
    | (() => AsyncGenerator<Result<never, unknown>, Result<unknown, unknown>>)
    | SafeTryOptions<Result<never, unknown>, Result<unknown, unknown>, unknown>
    | SafeTryAsyncOptions<Result<never, unknown>, Result<unknown, unknown>, unknown>,
) => runResultGenerator(input, safeTryStep)) as LegacySafeTry

/**
 * Creates an Ok result.
 */
export function ok<T, E = never>(value: T): OkResult<T, E>
export function ok<E = never>(value: void): OkResult<void, E>
export function ok<T, E = never>(value: T): OkResult<T, E> {
  return new Ok<T, E>(value) as unknown as OkResult<T, E>
}

/**
 * Creates an Err result.
 */
export function err<T = never, E extends string = string>(err: E): ErrResult<T, E>
export function err<T = never, E = unknown>(err: E): ErrResult<T, E>
export function err<T = never>(err: void): ErrResult<T, void>
export function err<T = never, E = unknown>(error: E): ErrResult<T, E> {
  return new Err<T, E>(error) as unknown as ErrResult<T, E>
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

/** @deprecated Use tryResult; this alias retains its existing behavior. */
export const tryCatch: typeof tryResult = tryResult
