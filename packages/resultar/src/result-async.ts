import type {
  Combine,
  Dedup,
  EmptyArrayToNever,
  IsLiteralArray,
  MatchHandlers,
  MemberListOf,
  MembersToUnion,
} from './result.js'
import type {
  ExtractErrAsyncTypes,
  ExtractOkAsyncTypes,
  InferAsyncErrTypes,
  InferAsyncOkTypes,
  InferErrTypes,
  InferOkTypes,
} from './utils.js'

import { Pipeable } from './pipe.js'
import { registerResultAsyncFactory } from './result-async-adapter.js'
import { Result, createEmptyResultsCollectionError, err, getMatchErrorHandler } from './result.js'
import { callTaggedHandler, hasTag, matchTaggedOr } from './tagged-match.js'
import type {
  CatchTagHandlerResult,
  ErrorForTag,
  ExcludeTag,
  MatchTagHandlerResult,
  MatchTagHandlers,
  PartialMatchTagHandlers,
  ResultAsyncCatchTagHandlers as CatchTagHandlers,
  TagsOf,
} from './tagged-types.js'

type ResultAsyncFinalizer<T, E> = (
  value: T | undefined,
  error: E | undefined,
) => void | Promise<void>

export interface TryResultAsyncOptions<T, E = unknown> {
  readonly try: () => Promise<T>
  readonly catch?: (e: unknown) => E
}

type HandlerOk<R> = InferOkTypes<R> | InferAsyncOkTypes<R>
type HandlerErr<R> = InferErrTypes<R> | InferAsyncErrTypes<R>
type IterableElement<T> = T extends Iterable<infer Element> ? Element : never
export type ResultAsyncCandidate = () => ResultAsync<unknown, unknown>
export type FirstSuccessOfAsync<Candidates extends Iterable<ResultAsyncCandidate>> = ResultAsync<
  InferAsyncOkTypes<ReturnType<IterableElement<Candidates>>>,
  InferAsyncErrTypes<ReturnType<IterableElement<Candidates>>>
>
type ResultAsyncLoopCollected<R extends ResultAsync<unknown, unknown>> = ResultAsync<
  readonly InferAsyncOkTypes<R>[],
  InferAsyncErrTypes<R>
>
type ResultAsyncLoopDiscarded<R extends ResultAsync<unknown, unknown>> = ResultAsync<
  void,
  InferAsyncErrTypes<R>
>
type ResultAsyncIterated<State, R extends ResultAsync<State, unknown>> = ResultAsync<
  State,
  InferAsyncErrTypes<R>
>
type ResultAsyncForEachCollected<R extends ResultAsync<unknown, unknown>> = ResultAsync<
  readonly InferAsyncOkTypes<R>[],
  InferAsyncErrTypes<R>
>
type ResultAsyncForEachDiscarded<R extends ResultAsync<unknown, unknown>> = ResultAsync<
  void,
  InferAsyncErrTypes<R>
>
type ResultAsyncValidatedAll<R extends ResultAsync<unknown, unknown>> = ResultAsync<
  readonly InferAsyncOkTypes<R>[],
  InferAsyncErrTypes<R>[]
>
type ResultAsyncZipped<
  Left extends ResultAsync<unknown, unknown>,
  Right extends ResultAsync<unknown, unknown>,
> = ResultAsync<
  [InferAsyncOkTypes<Left>, InferAsyncOkTypes<Right>],
  InferAsyncErrTypes<Left> | InferAsyncErrTypes<Right>
>
type ResultAsyncBooleanCondition = boolean | (() => boolean)
type ResultAsyncConditional = Result<unknown, unknown> | ResultAsync<unknown, unknown>
type ResultAsyncConditionResult = Result<boolean, unknown> | ResultAsync<boolean, unknown>
type ResultAsyncIf<
  ConditionErr,
  OnTrue extends ResultAsyncConditional,
  OnFalse extends ResultAsyncConditional,
> = ResultAsync<
  HandlerOk<OnTrue> | HandlerOk<OnFalse>,
  ConditionErr | HandlerErr<OnTrue> | HandlerErr<OnFalse>
>
type ResultAsyncWhen<R extends ResultAsyncConditional> = ResultAsync<
  HandlerOk<R> | undefined,
  HandlerErr<R>
>
type ResultAsyncWhenWithCondition<
  Condition extends ResultAsyncConditionResult,
  R extends ResultAsyncConditional,
> = ResultAsync<HandlerOk<R> | undefined, HandlerErr<Condition> | HandlerErr<R>>
type WidenLiteral<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends bigint
        ? bigint
        : T

interface ResultAsyncLoopOptions<
  State,
  BodyState extends State,
  R extends ResultAsync<unknown, unknown>,
> {
  readonly body: (state: BodyState) => R
  readonly discard?: false
  readonly step: (state: BodyState) => State
  readonly while: (state: State) => state is BodyState
}

interface ResultAsyncLoopBooleanOptions<State, R extends ResultAsync<unknown, unknown>> {
  readonly body: (state: State) => R
  readonly discard?: false
  readonly step: (state: State) => State
  readonly while: (state: State) => boolean
}

interface ResultAsyncLoopDiscardOptions<
  State,
  BodyState extends State,
  R extends ResultAsync<unknown, unknown>,
> {
  readonly body: (state: BodyState) => R
  readonly discard: true
  readonly step: (state: BodyState) => State
  readonly while: (state: State) => state is BodyState
}

interface ResultAsyncLoopBooleanDiscardOptions<State, R extends ResultAsync<unknown, unknown>> {
  readonly body: (state: State) => R
  readonly discard: true
  readonly step: (state: State) => State
  readonly while: (state: State) => boolean
}

interface ResultAsyncLoopRuntimeOptions<State, R extends ResultAsync<unknown, unknown>> {
  readonly body: (state: State) => R
  readonly discard?: boolean
  readonly step: (state: State) => State
  readonly while: (state: State) => boolean
}

interface ResultAsyncIterateOptions<
  State,
  BodyState extends State,
  R extends ResultAsync<State, unknown>,
> {
  readonly body: (state: BodyState) => R
  readonly while: (state: State) => state is BodyState
}

interface ResultAsyncIterateBooleanOptions<State, R extends ResultAsync<State, unknown>> {
  readonly body: (state: State) => R
  readonly while: (state: State) => boolean
}

interface ResultAsyncIterateRuntimeOptions<State, R extends ResultAsync<State, unknown>> {
  readonly body: (state: State) => R
  readonly while: (state: State) => boolean
}

interface ResultAsyncForEachOptions {
  readonly discard?: false
}

interface ResultAsyncForEachDiscardOptions {
  readonly discard: true
}

interface ResultAsyncForEachRuntimeOptions {
  readonly discard?: boolean
}

interface ResultAsyncIfOptions<
  OnTrue extends ResultAsyncConditional,
  OnFalse extends ResultAsyncConditional,
> {
  readonly onFalse: () => OnFalse
  readonly onTrue: () => OnTrue
}

function isTryResultAsyncOptions<T, E>(
  input: Promise<T> | (() => Promise<T>) | TryResultAsyncOptions<T, E>,
): input is TryResultAsyncOptions<T, E> {
  return typeof input === 'object' && input !== null && 'try' in input
}

const combineResultAsyncList = <T, E>(
  asyncResultList: readonly ResultAsync<T, E>[],
): ResultAsync<readonly T[], E> =>
  ResultAsync.fromSafePromise(Promise.all(asyncResultList)).andThen((resultList) =>
    Result.combine(resultList),
  )

const combineResultAsyncListWithAllErrors = <T, E>(
  asyncResultList: readonly ResultAsync<T, E>[],
): ResultAsync<readonly T[], E[]> =>
  ResultAsync.fromSafePromise(Promise.all(asyncResultList)).andThen((resultList) =>
    Result.combineWithAllErrors(resultList),
  ) as ResultAsync<T[], E[]>

const validateAllResultAsyncItems = <Item, R extends ResultAsync<unknown, unknown>>(
  items: Iterable<Item>,
  f: (value: Item, index: number) => R,
): ResultAsyncValidatedAll<R> => {
  const resultList = Array.from(items, f)

  return combineResultAsyncListWithAllErrors(resultList) as ResultAsyncValidatedAll<R>
}

const firstSuccessOfAsyncCandidates = <Candidates extends Iterable<ResultAsyncCandidate>>(
  candidates: Candidates,
): FirstSuccessOfAsync<Candidates> => {
  const promise = Promise.try(async () => {
    let latestError: Result<unknown, unknown> | undefined = undefined
    let hasCandidates = false

    for (const candidate of candidates) {
      hasCandidates = true

      // eslint-disable-next-line no-await-in-loop
      const result = await candidate()

      if (result.isOk()) {
        return result
      }

      latestError = result
    }

    if (!hasCandidates || latestError === undefined) {
      throw createEmptyResultsCollectionError()
    }

    return latestError
  })

  return new ResultAsync(promise) as FirstSuccessOfAsync<Candidates>
}

const loopResultAsync = <State, R extends ResultAsync<unknown, unknown>>(
  initial: State,
  options: ResultAsyncLoopRuntimeOptions<State, R>,
): ResultAsyncLoopCollected<R> | ResultAsyncLoopDiscarded<R> => {
  const promise: Promise<Result<readonly InferAsyncOkTypes<R>[] | void, InferAsyncErrTypes<R>>> =
    Promise.try(async () => {
      let state = initial
      const values: InferAsyncOkTypes<R>[] = []

      while (options.while(state)) {
        // eslint-disable-next-line no-await-in-loop
        const result = await options.body(state)

        if (result.isErr()) {
          return Result.err(result.error as InferAsyncErrTypes<R>)
        }

        if (options.discard !== true) {
          values.push(result.value as InferAsyncOkTypes<R>)
        }

        state = options.step(state)
      }

      if (options.discard === true) {
        return Result.ok<void, InferAsyncErrTypes<R>>(undefined)
      }

      return Result.ok<readonly InferAsyncOkTypes<R>[], InferAsyncErrTypes<R>>(values)
    })

  return new ResultAsync(promise) as ResultAsyncLoopCollected<R> | ResultAsyncLoopDiscarded<R>
}

const iterateResultAsync = <State, R extends ResultAsync<State, unknown>>(
  initial: State,
  options: ResultAsyncIterateRuntimeOptions<State, R>,
): ResultAsyncIterated<State, R> => {
  const promise = Promise.try(async () => {
    let state = initial

    while (options.while(state)) {
      // eslint-disable-next-line no-await-in-loop
      const result = await options.body(state)

      if (result.isErr()) {
        return Result.err(result.error as InferAsyncErrTypes<R>)
      }

      state = result.value
    }

    return Result.ok<State, InferAsyncErrTypes<R>>(state)
  })

  return new ResultAsync(promise) as ResultAsyncIterated<State, R>
}

const forEachResultAsync = <Item, R extends ResultAsync<unknown, unknown>>(
  items: Iterable<Item>,
  f: (value: Item, index: number) => R,
  options?: ResultAsyncForEachRuntimeOptions,
): ResultAsyncForEachCollected<R> | ResultAsyncForEachDiscarded<R> => {
  const promise: Promise<Result<readonly InferAsyncOkTypes<R>[] | void, InferAsyncErrTypes<R>>> =
    Promise.try(async () => {
      const values: InferAsyncOkTypes<R>[] = []
      let index = 0

      for (const item of items) {
        // eslint-disable-next-line no-await-in-loop
        const result = await f(item, index)

        if (result.isErr()) {
          return Result.err(result.error as InferAsyncErrTypes<R>)
        }

        if (options?.discard !== true) {
          values.push(result.value as InferAsyncOkTypes<R>)
        }

        index += 1
      }

      if (options?.discard === true) {
        return Result.ok<void, InferAsyncErrTypes<R>>(undefined)
      }

      return Result.ok<readonly InferAsyncOkTypes<R>[], InferAsyncErrTypes<R>>(values)
    })

  return new ResultAsync(promise) as ResultAsyncForEachCollected<R> | ResultAsyncForEachDiscarded<R>
}

const resolveResultAsyncBooleanCondition = (condition: ResultAsyncBooleanCondition): boolean =>
  typeof condition === 'function' ? condition() : condition

const toResultAsync = <R extends ResultAsyncConditional>(
  result: R,
): ResultAsync<HandlerOk<R>, HandlerErr<R>> => {
  if (result instanceof ResultAsync) {
    return result as ResultAsync<HandlerOk<R>, HandlerErr<R>>
  }

  return new ResultAsync(Promise.resolve(result as Result<HandlerOk<R>, HandlerErr<R>>))
}

const ifResultAsync = <
  OnTrue extends ResultAsyncConditional,
  OnFalse extends ResultAsyncConditional,
>(
  condition: ResultAsyncBooleanCondition,
  options: ResultAsyncIfOptions<OnTrue, OnFalse>,
): ResultAsyncIf<never, OnTrue, OnFalse> => {
  const promise: Promise<
    Result<HandlerOk<OnTrue> | HandlerOk<OnFalse>, HandlerErr<OnTrue> | HandlerErr<OnFalse>>
  > = Promise.try(async () => {
    const result = resolveResultAsyncBooleanCondition(condition)
      ? options.onTrue()
      : options.onFalse()

    return (await toResultAsync(result)) as Result<
      HandlerOk<OnTrue> | HandlerOk<OnFalse>,
      HandlerErr<OnTrue> | HandlerErr<OnFalse>
    >
  })

  return new ResultAsync(promise) as ResultAsyncIf<never, OnTrue, OnFalse>
}

const ifResultAsyncWithCondition = <
  Condition extends ResultAsyncConditionResult,
  OnTrue extends ResultAsyncConditional,
  OnFalse extends ResultAsyncConditional,
>(
  condition: Condition,
  options: ResultAsyncIfOptions<OnTrue, OnFalse>,
): ResultAsyncIf<HandlerErr<Condition>, OnTrue, OnFalse> => {
  const promise: Promise<
    Result<
      HandlerOk<OnTrue> | HandlerOk<OnFalse>,
      HandlerErr<Condition> | HandlerErr<OnTrue> | HandlerErr<OnFalse>
    >
  > = Promise.try(async () => {
    const conditionResult = await toResultAsync(condition)

    if (conditionResult.isErr()) {
      return Result.err(conditionResult.error)
    }

    const result = conditionResult.value ? options.onTrue() : options.onFalse()

    return (await toResultAsync(result)) as Result<
      HandlerOk<OnTrue> | HandlerOk<OnFalse>,
      HandlerErr<Condition> | HandlerErr<OnTrue> | HandlerErr<OnFalse>
    >
  })

  return new ResultAsync(promise) as ResultAsyncIf<HandlerErr<Condition>, OnTrue, OnFalse>
}

const whenResultAsync = <R extends ResultAsyncConditional>(
  condition: ResultAsyncBooleanCondition,
  body: () => R,
): ResultAsyncWhen<R> => {
  const promise: Promise<Result<HandlerOk<R> | undefined, HandlerErr<R>>> = Promise.try(
    async () => {
      if (!resolveResultAsyncBooleanCondition(condition)) {
        return Result.ok<HandlerOk<R> | undefined, HandlerErr<R>>(undefined)
      }

      return (await toResultAsync(body())) as Result<HandlerOk<R> | undefined, HandlerErr<R>>
    },
  )

  return new ResultAsync(promise) as ResultAsyncWhen<R>
}

const whenResultAsyncWithConditionByPredicate = <
  Condition extends ResultAsyncConditionResult,
  R extends ResultAsyncConditional,
>(
  condition: Condition,
  body: () => R,
  predicate: (condition: boolean) => boolean,
): ResultAsyncWhenWithCondition<Condition, R> => {
  const promise: Promise<Result<HandlerOk<R> | undefined, HandlerErr<Condition> | HandlerErr<R>>> =
    Promise.try(async () => {
      const conditionResult = await toResultAsync(condition)

      if (conditionResult.isErr()) {
        return Result.err(conditionResult.error)
      }

      if (!predicate(conditionResult.value)) {
        return Result.ok<HandlerOk<R> | undefined, HandlerErr<Condition> | HandlerErr<R>>(undefined)
      }

      return (await toResultAsync(body())) as Result<
        HandlerOk<R> | undefined,
        HandlerErr<Condition> | HandlerErr<R>
      >
    })

  return new ResultAsync(promise) as ResultAsyncWhenWithCondition<Condition, R>
}

const whenResultAsyncWithCondition = <
  Condition extends ResultAsyncConditionResult,
  R extends ResultAsyncConditional,
>(
  condition: Condition,
  body: () => R,
): ResultAsyncWhenWithCondition<Condition, R> =>
  whenResultAsyncWithConditionByPredicate(condition, body, (value) => value)

const unlessResultAsync = <R extends ResultAsyncConditional>(
  condition: ResultAsyncBooleanCondition,
  body: () => R,
): ResultAsyncWhen<R> => whenResultAsync(() => !resolveResultAsyncBooleanCondition(condition), body)

const unlessResultAsyncWithCondition = <
  Condition extends ResultAsyncConditionResult,
  R extends ResultAsyncConditional,
>(
  condition: Condition,
  body: () => R,
): ResultAsyncWhenWithCondition<Condition, R> =>
  whenResultAsyncWithConditionByPredicate(condition, body, (value) => !value)

interface MatchResolvedResultTagsOptions<T, E, A, F> {
  readonly fallback: (error: E) => F
  readonly handlers: object
  readonly ok: (value: T) => A
  readonly result: Result<T, E>
}

const matchResolvedResultTags = <T, E, A, R, F>({
  fallback,
  handlers,
  ok,
  result,
}: MatchResolvedResultTagsOptions<T, E, A, F>): A | R | F => {
  if (result.isOk()) {
    return ok(result.value)
  }

  return matchTaggedOr<E, R, F>(result.error, handlers, fallback)
}

const callAsyncSideEffect = async (effect: () => void | Promise<void>): Promise<void> => {
  try {
    await effect()
  } catch {
    /* empty */
  }
}

export class DisposableResultAsync<T, E> implements PromiseLike<Result<T, E>>, AsyncDisposable {
  private readonly innerPromise: Promise<Result<T, E>>
  private readonly finalizer: (value: unknown, error: unknown) => void | Promise<void>
  private disposed = false

  public constructor(res: Promise<Result<T, E>>, finalizer: ResultAsyncFinalizer<T, E>) {
    this.innerPromise = res
    this.finalizer = finalizer as (value: unknown, error: unknown) => void | Promise<void>
  }

  public then<A, B>(
    successCallback?: (res: Result<T, E>) => A | PromiseLike<A>,
    failureCallback?: (reason: unknown) => B | PromiseLike<B>,
  ): PromiseLike<A | B> {
    return this.innerPromise.then(successCallback, failureCallback)
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    if (this.disposed) {
      return
    }

    this.disposed = true
    const result = await this.innerPromise

    try {
      await this.finalizer(
        result.isOk() ? result.value : undefined,
        result.isErr() ? result.error : undefined,
      )
    } catch {
      /* empty */
    }
  }
}

/**
 * Represents an asynchronous Result type that wraps a Promise of a Result<T, E>.
 * This class provides a way to handle asynchronous operations that may succeed with a value of type T
 * or fail with an error of type E.
 *
 * @template T - The type of the success value
 * @template E - The type of the error value
 *
 * @implements {PromiseLike<Result<T, E>>}
 *
 * @example
 * ```typescript
 * // Create a successful async result
 * const okAsync = ResultAsync.okAsync(42);
 *
 * // Create a failed async result
 * const errAsync = ResultAsync.errAsync(new Error("Something went wrong"));
 *
 * // Transform a Promise into a ResultAsync
 * const resultFromPromise = ResultAsync.fromPromise(
 *   fetch("https://api.example.com/data"),
 *   (error) => new Error(`API call failed: ${error}`)
 * );
 * ```
 *
 * @remarks
 * ResultAsync implements the PromiseLike interface, allowing it to be used with async/await syntax.
 * It provides various utility methods for transforming and combining results, similar to the Result type,
 * but operating in an asynchronous context.
 *
 * The class includes methods for:
 * - Creating ResultAsync instances (okAsync, errAsync, fromPromise)
 * - Transforming values (map, mapErr)
 * - Chaining operations (andThen, orElse)
 * - Error handling (tapError)
 * - Conditional branching (if)
 * - Combining multiple ResultAsync instances (combine, combineWithAllErrors)
 */
export class ResultAsync<T, E> extends Pipeable implements PromiseLike<Result<T, E>> {
  /**
   * Returns a ResultAsync instance that is immediately resolved with a Result.ok(value).
   *
   * @param {T} value - The value to be wrapped in a Result.ok.
   * @return {ResultAsync<T, E>} A ResultAsync instance with the given value and error type E.
   */
  public static okAsync<T, E = never>(this: void, value: T): ResultAsync<T, E>
  public static okAsync<E = never>(this: void, value: void): ResultAsync<void, E>
  public static okAsync<T, E = never>(this: void, value: T): ResultAsync<T, E> {
    return new ResultAsync<T, E>(Promise.resolve(Result.ok(value)))
  }

  /**
   * Returns a ResultAsync that is immediately resolved with a Result.ok(undefined) value.
   *
   * @return {ResultAsync<undefined, E>} A ResultAsync instance with undefined as the value type and E as the error type.
   */
  public static unitAsync<E = never>(this: void): ResultAsync<undefined, E> {
    return new ResultAsync<undefined, E>(Promise.resolve(Result.unit()))
  }

  /**
   * Returns a ResultAsync instance that is immediately resolved with a Result.err(error).
   *
   * @param {E} error - The error to be wrapped in a Result.err.
   * @return {ResultAsync<T, E>} A ResultAsync instance with the given error and value type T.
   */
  public static errAsync<T = never, E = unknown>(this: void, err: E): ResultAsync<T, E>
  public static errAsync<T = never>(this: void, err: void): ResultAsync<T, void>
  public static errAsync<T = never, E = unknown>(this: void, error: E): ResultAsync<T, E> {
    return new ResultAsync<T, E>(Promise.resolve(Result.err(error)))
  }

  /**
   * Creates a ResultAsync from a Promise, catching any errors that occur during its execution.
   *
   * Compatibility alias. Prefer the top-level `tryResultAsync` helper in new code.
   *
   * @param fn - The Promise or a function returning a Promise to be wrapped in a ResultAsync.
   * @param errorFn - Optional function to transform the caught error into a specific error type.
   *                  If not provided, the original error will be used.
   * @returns A ResultAsync that will resolve to Ok with the promise's value if successful,
   *          or Err with either the transformed error (if errorFn is provided) or the original error.
   *
   * New code should use the top-level `tryResultAsync` helper instead.
   */
  public static tryCatch<T>(
    this: void,
    fn: Promise<T> | (() => Promise<T>),
  ): ResultAsync<T, unknown>
  public static tryCatch<T, E>(
    this: void,
    fn: Promise<T> | (() => Promise<T>),
    errorFn: (e: unknown) => E,
  ): ResultAsync<T, E>
  public static tryCatch<T, E>(
    this: void,
    fn: Promise<T> | (() => Promise<T>),
    errorFn?: (e: unknown) => E,
  ): ResultAsync<T, unknown> {
    const promiseToProcess = typeof fn === 'function' ? Promise.try(fn) : fn
    const newPromise = promiseToProcess
      .then((value: T) => Result.ok(value))
      .catch((error: unknown) => {
        if (errorFn) {
          return Result.err(errorFn(error))
        }
        return Result.err(error)
      })
    return new ResultAsync<T, unknown>(newPromise)
  }

  /**
   * Returns a ResultAsync instance that is resolved with a Result.ok(value) or Result.err(error)
   * based on the provided promise.
   *
   * @param {Promise<T>} promise - The promise to be wrapped in a ResultAsync.
   * @return {ResultAsync<T, E>} A ResultAsync instance with the given promise and error type E.
   */
  public static fromSafePromise<T, E = never>(
    this: void,
    promise: PromiseLike<T>,
  ): ResultAsync<T, E>
  public static fromSafePromise<T, E = never>(this: void, promise: Promise<T>): ResultAsync<T, E> {
    const newPromise = promise.then((value: T) => Result.ok(value))

    return new ResultAsync<T, E>(newPromise)
  }

  /**
   * Returns a ResultAsync instance that is resolved with a Result.ok(value) or Result.err(error)
   * based on the provided promise.
   *
   * @param {Promise<T>} promise - The promise to be wrapped in a ResultAsync.
   * @param {(e: unknown) => E} errorFn - A function that transforms the error from the promise into the error type E.
   * @return {ResultAsync<T, E>} A ResultAsync instance with the given promise and error type E.
   */
  public static fromPromise<T, E>(
    this: void,
    promise: PromiseLike<T>,
    errorFn: (e: unknown) => E,
  ): ResultAsync<T, E>
  public static fromPromise<T, E>(
    this: void,
    promise: Promise<T>,
    errorFn: (e: unknown) => E,
  ): ResultAsync<T, E> {
    const newPromise = promise
      .then((value: T) => Result.ok(value))
      .catch((error: unknown) => Result.err(errorFn(error)))

    return new ResultAsync<T, E>(newPromise)
  }

  public static combine<
    T extends readonly [ResultAsync<unknown, unknown>, ...ResultAsync<unknown, unknown>[]],
  >(this: void, asyncResultList: T): CombineResultAsyncs<T>
  public static combine<T extends readonly ResultAsync<unknown, unknown>[]>(
    this: void,
    asyncResultList: T,
  ): CombineResultAsyncs<T>
  public static combine<T extends readonly ResultAsync<unknown, unknown>[]>(
    this: void,
    asyncResultList: T,
  ): CombineResultAsyncs<T> {
    return combineResultAsyncList(asyncResultList) as CombineResultAsyncs<T>
  }

  public static combineWithAllErrors<
    T extends readonly [ResultAsync<unknown, unknown>, ...ResultAsync<unknown, unknown>[]],
  >(this: void, asyncResultList: T): CombineResultsWithAllErrorsArrayAsync<T>
  public static combineWithAllErrors<T extends readonly ResultAsync<unknown, unknown>[]>(
    this: void,
    asyncResultList: T,
  ): CombineResultsWithAllErrorsArrayAsync<T>
  public static combineWithAllErrors<T extends readonly ResultAsync<unknown, unknown>[]>(
    this: void,
    asyncResultList: T,
  ): CombineResultsWithAllErrorsArrayAsync<T> {
    return combineResultAsyncListWithAllErrors(
      asyncResultList,
    ) as CombineResultsWithAllErrorsArrayAsync<T>
  }

  public static validateAll<
    T extends readonly [ResultAsync<unknown, unknown>, ...ResultAsync<unknown, unknown>[]],
  >(this: void, asyncResultList: T): CombineResultsWithAllErrorsArrayAsync<T>
  public static validateAll<T extends readonly ResultAsync<unknown, unknown>[]>(
    this: void,
    asyncResultList: T,
  ): CombineResultsWithAllErrorsArrayAsync<T>
  public static validateAll<Item, R extends ResultAsync<unknown, unknown>>(
    this: void,
    items: Iterable<Item>,
    f: (value: Item, index: number) => R,
  ): ResultAsyncValidatedAll<R>
  public static validateAll<
    T extends readonly ResultAsync<unknown, unknown>[],
    Item,
    R extends ResultAsync<unknown, unknown>,
  >(
    this: void,
    asyncResultListOrItems: T | Iterable<Item>,
    f?: (value: Item, index: number) => R,
  ): CombineResultsWithAllErrorsArrayAsync<T> | ResultAsyncValidatedAll<R> {
    if (f === undefined) {
      return combineResultAsyncListWithAllErrors(
        asyncResultListOrItems as T,
      ) as CombineResultsWithAllErrorsArrayAsync<T>
    }

    return validateAllResultAsyncItems(asyncResultListOrItems as Iterable<Item>, f)
  }

  public static zip<
    Left extends ResultAsync<unknown, unknown>,
    Right extends ResultAsync<unknown, unknown>,
  >(this: void, left: Left, right: Right): ResultAsyncZipped<Left, Right> {
    return combineResultAsyncList([left, right]) as ResultAsyncZipped<Left, Right>
  }

  public static firstSuccessOf<Candidates extends Iterable<ResultAsyncCandidate>>(
    this: void,
    candidates: Candidates,
  ): FirstSuccessOfAsync<Candidates> {
    return firstSuccessOfAsyncCandidates(candidates)
  }

  public static if<OnTrue extends ResultAsyncConditional, OnFalse extends ResultAsyncConditional>(
    this: void,
    condition: ResultAsyncBooleanCondition,
    options: ResultAsyncIfOptions<OnTrue, OnFalse>,
  ): ResultAsyncIf<never, OnTrue, OnFalse>
  public static if<
    Condition extends ResultAsyncConditionResult,
    OnTrue extends ResultAsyncConditional,
    OnFalse extends ResultAsyncConditional,
  >(
    this: void,
    condition: Condition,
    options: ResultAsyncIfOptions<OnTrue, OnFalse>,
  ): ResultAsyncIf<HandlerErr<Condition>, OnTrue, OnFalse>
  public static if<
    Condition extends ResultAsyncConditionResult,
    OnTrue extends ResultAsyncConditional,
    OnFalse extends ResultAsyncConditional,
  >(
    this: void,
    condition: Condition | ResultAsyncBooleanCondition,
    options: ResultAsyncIfOptions<OnTrue, OnFalse>,
  ): ResultAsyncIf<HandlerErr<Condition>, OnTrue, OnFalse> | ResultAsyncIf<never, OnTrue, OnFalse> {
    if (typeof condition === 'boolean' || typeof condition === 'function') {
      return ifResultAsync(condition, options)
    }

    return ifResultAsyncWithCondition(condition, options)
  }

  public static when<R extends ResultAsyncConditional>(
    this: void,
    condition: ResultAsyncBooleanCondition,
    body: () => R,
  ): ResultAsyncWhen<R> {
    return whenResultAsync(condition, body)
  }

  public static whenResult<
    Condition extends ResultAsyncConditionResult,
    R extends ResultAsyncConditional,
  >(this: void, condition: Condition, body: () => R): ResultAsyncWhenWithCondition<Condition, R> {
    return whenResultAsyncWithCondition(condition, body)
  }

  public static unless<R extends ResultAsyncConditional>(
    this: void,
    condition: ResultAsyncBooleanCondition,
    body: () => R,
  ): ResultAsyncWhen<R> {
    return unlessResultAsync(condition, body)
  }

  public static unlessResult<
    Condition extends ResultAsyncConditionResult,
    R extends ResultAsyncConditional,
  >(this: void, condition: Condition, body: () => R): ResultAsyncWhenWithCondition<Condition, R> {
    return unlessResultAsyncWithCondition(condition, body)
  }

  public static loop<State, BodyState extends State, R extends ResultAsync<unknown, unknown>>(
    this: void,
    initial: State,
    options: ResultAsyncLoopOptions<State, BodyState, R>,
  ): ResultAsyncLoopCollected<R>
  public static loop<State, R extends ResultAsync<unknown, unknown>>(
    this: void,
    initial: State,
    options: ResultAsyncLoopBooleanOptions<State, R>,
  ): ResultAsyncLoopCollected<R>
  public static loop<State, BodyState extends State, R extends ResultAsync<unknown, unknown>>(
    this: void,
    initial: State,
    options: ResultAsyncLoopDiscardOptions<State, BodyState, R>,
  ): ResultAsyncLoopDiscarded<R>
  public static loop<State, R extends ResultAsync<unknown, unknown>>(
    this: void,
    initial: State,
    options: ResultAsyncLoopBooleanDiscardOptions<State, R>,
  ): ResultAsyncLoopDiscarded<R>
  public static loop<State, R extends ResultAsync<unknown, unknown>>(
    this: void,
    initial: State,
    options:
      | ResultAsyncLoopBooleanOptions<State, R>
      | ResultAsyncLoopBooleanDiscardOptions<State, R>
      | ResultAsyncLoopOptions<State, State, R>
      | ResultAsyncLoopDiscardOptions<State, State, R>,
  ): ResultAsyncLoopCollected<R> | ResultAsyncLoopDiscarded<R> {
    return loopResultAsync(initial, options as ResultAsyncLoopRuntimeOptions<State, R>)
  }

  public static iterate<
    State,
    BodyState extends WidenLiteral<State>,
    R extends ResultAsync<WidenLiteral<State>, unknown>,
  >(
    this: void,
    initial: State,
    options: ResultAsyncIterateOptions<WidenLiteral<State>, BodyState, R>,
  ): ResultAsyncIterated<WidenLiteral<State>, R>
  public static iterate<State, R extends ResultAsync<WidenLiteral<State>, unknown>>(
    this: void,
    initial: State,
    options: ResultAsyncIterateBooleanOptions<WidenLiteral<State>, R>,
  ): ResultAsyncIterated<WidenLiteral<State>, R>
  public static iterate<State, R extends ResultAsync<WidenLiteral<State>, unknown>>(
    this: void,
    initial: State,
    options:
      | ResultAsyncIterateBooleanOptions<WidenLiteral<State>, R>
      | ResultAsyncIterateOptions<WidenLiteral<State>, WidenLiteral<State>, R>,
  ): ResultAsyncIterated<WidenLiteral<State>, R> {
    return iterateResultAsync(
      initial as WidenLiteral<State>,
      options as ResultAsyncIterateRuntimeOptions<WidenLiteral<State>, R>,
    )
  }

  public static forEach<Item, R extends ResultAsync<unknown, unknown>>(
    this: void,
    items: Iterable<Item>,
    f: (value: Item, index: number) => R,
    options?: ResultAsyncForEachOptions,
  ): ResultAsyncForEachCollected<R>
  public static forEach<Item, R extends ResultAsync<unknown, unknown>>(
    this: void,
    items: Iterable<Item>,
    f: (value: Item, index: number) => R,
    options: ResultAsyncForEachDiscardOptions,
  ): ResultAsyncForEachDiscarded<R>
  public static forEach<Item, R extends ResultAsync<unknown, unknown>>(
    this: void,
    items: Iterable<Item>,
    f: (value: Item, index: number) => R,
    options?: ResultAsyncForEachOptions | ResultAsyncForEachDiscardOptions,
  ): ResultAsyncForEachCollected<R> | ResultAsyncForEachDiscarded<R> {
    return forEachResultAsync(items, f, options)
  }

  /**
   * Wraps a async function with a try catch, creating a new function with the same
   * arguments but returning `Ok` if successful, `Err` if the function throws
   *
   * @param fn function to wrap with ok on success or err on failure
   * @param errorFn when an error is thrown, this will wrap the error result if provided
   * @returns a new function that returns a `ResultAsync`
   */
  public static fromThrowable<A extends readonly unknown[], T, E>(
    this: void,
    fn: (...args: A) => Promise<T>,
    errorFn?: (err: unknown) => E,
  ): (...args: A) => ResultAsync<T, E> {
    return (...args) =>
      new ResultAsync<T, E>(
        (async () => {
          try {
            const v = await fn(...args)
            return Result.ok(v)
          } catch (error) {
            const e = errorFn ? errorFn(error) : error
            return Result.err(e as E)
          }
        })(),
      )
  }

  private readonly innerPromise: Promise<Result<T, E>>

  public constructor(res: Promise<Result<T, E>>) {
    super()
    this.innerPromise = res
  }

  public then<A, B>(
    successCallback?: (res: Result<T, E>) => A | PromiseLike<A>,
    failureCallback?: (reason: unknown) => B | PromiseLike<B>,
  ): PromiseLike<A | B> {
    return this.innerPromise.then(successCallback, failureCallback)
  }

  public mapErr<U>(f: (t: E) => U | Promise<U>): ResultAsync<T, U> {
    return new ResultAsync<T, U>(
      this.innerPromise.then(async (res) => {
        if (res.isOk()) {
          return Result.ok<T, U>(res.value)
        }

        return Result.err<T, U>(await f(res.error))
      }),
    )
  }

  public map<X>(f: (t: T) => X | Promise<X>): ResultAsync<X, E> {
    return new ResultAsync<X, E>(
      this.innerPromise.then(async (res: Result<T, E>) => {
        if (res.isErr()) {
          return Result.err<X, E>(res.error)
        }

        return Result.ok<X, E>(await f(res.value))
      }),
    )
  }

  public as<X>(value: X): ResultAsync<X, E> {
    return new ResultAsync<X, E>(
      this.innerPromise.then((res: Result<T, E>) => {
        if (res.isErr()) {
          return Result.err<X, E>(res.error)
        }

        return Result.ok<X, E>(value)
      }),
    )
  }

  public filterOrElse<U extends T, F>(
    predicate: (value: T) => value is U,
    onFalse: (value: T) => F | Promise<F>,
  ): ResultAsync<U, E | F>
  public filterOrElse<F>(
    predicate: (value: T) => boolean | Promise<boolean>,
    onFalse: (value: T) => F | Promise<F>,
  ): ResultAsync<T, E | F>
  public filterOrElse<F>(
    predicate: (value: T) => boolean | Promise<boolean>,
    onFalse: (value: T) => F | Promise<F>,
  ): ResultAsync<T, E | F> {
    return new ResultAsync<T, E | F>(
      this.innerPromise.then(async (res) => {
        if (res.isErr()) {
          return Result.err(res.error)
        }

        if (await predicate(res.value)) {
          return Result.ok(res.value)
        }

        return Result.err(await onFalse(res.value))
      }),
    )
  }

  public andThen<R extends Result<unknown, unknown>>(
    f: (t: T) => R,
  ): ResultAsync<InferOkTypes<R>, InferErrTypes<R> | E>
  public andThen<R extends ResultAsync<unknown, unknown>>(
    f: (t: T) => R,
  ): ResultAsync<InferAsyncOkTypes<R>, InferAsyncErrTypes<R> | E>
  public andThen<U, F>(f: (t: T) => Result<U, F> | ResultAsync<U, F>): ResultAsync<U, E | F>
  public andThen<U, F>(f: (t: T) => Result<U, F> | ResultAsync<U, F>): ResultAsync<U, E | F> {
    return new ResultAsync<U, E | F>(
      this.innerPromise.then((res) => {
        if (res.isErr()) {
          return Result.err<U, E | F>(res.error)
        }

        const next = f(res.value)
        return next instanceof ResultAsync ? next.innerPromise : next
      }),
    )
  }

  public if(fCondition: (t: T) => boolean): {
    true: <X1, Y1>(
      fTrue: (t: T) => ResultAsync<X1, Y1>,
    ) => {
      false: <X2, Y2>(fFalse: (t: T) => ResultAsync<X2, Y2>) => ResultAsync<X1 | X2, Y1 | Y2 | E>
    }
  } {
    return {
      true: <X1, Y1>(fTrue: (t: T) => ResultAsync<X1, Y1>) => ({
        false: <X2, Y2>(fFalse: (t: T) => ResultAsync<X2, Y2>): ResultAsync<X1 | X2, Y1 | Y2 | E> =>
          new ResultAsync(
            this.innerPromise.then(async (res) => {
              if (res.isOk()) {
                const condition = fCondition(res.value)
                return condition ? fTrue(res.value) : fFalse(res.value)
              }

              return errAsync(res.error)
            }),
          ),
      }),
    }
  }

  public orElse<R extends Result<unknown, unknown>>(
    f: (e: E) => R,
  ): ResultAsync<InferOkTypes<R> | T, InferErrTypes<R>>
  public orElse<R extends ResultAsync<unknown, unknown>>(
    f: (e: E) => R,
  ): ResultAsync<InferAsyncOkTypes<R> | T, InferAsyncErrTypes<R>>
  public orElse<U, A>(f: (e: E) => Result<U, A> | ResultAsync<U, A>): ResultAsync<U | T, A>
  public orElse<U, A>(f: (e: E) => Result<U, A> | ResultAsync<U, A>): ResultAsync<U | T, A> {
    return new ResultAsync<U | T, A>(
      this.innerPromise.then((res) => {
        if (res.isErr()) {
          const next = f(res.error)
          return next instanceof ResultAsync ? next.innerPromise : next
        }

        return Result.ok<U | T, A>(res.value)
      }),
    )
  }

  public catchTag<const Tag extends TagsOf<E>, R extends Result<unknown, unknown>>(
    tag: Tag,
    f: (error: ErrorForTag<E, Tag>) => R,
  ): ResultAsync<T | InferOkTypes<R>, ExcludeTag<E, Tag> | InferErrTypes<R>>
  public catchTag<const Tag extends TagsOf<E>, R extends ResultAsync<unknown, unknown>>(
    tag: Tag,
    f: (error: ErrorForTag<E, Tag>) => R,
  ): ResultAsync<T | InferAsyncOkTypes<R>, ExcludeTag<E, Tag> | InferAsyncErrTypes<R>>
  public catchTag<U, F, const Tag extends TagsOf<E>>(
    tag: Tag,
    f: (error: ErrorForTag<E, Tag>) => Result<U, F> | ResultAsync<U, F>,
  ): ResultAsync<T | U, ExcludeTag<E, Tag> | F>
  public catchTag<U, F, const Tag extends TagsOf<E>>(
    tag: Tag,
    f: (error: ErrorForTag<E, Tag>) => Result<U, F> | ResultAsync<U, F>,
  ): ResultAsync<T | U, ExcludeTag<E, Tag> | F> {
    return new ResultAsync(
      this.innerPromise.then((res) => {
        if (res.isOk()) {
          return Result.ok(res.value)
        }

        if (hasTag(res.error, tag)) {
          const next = f(res.error as ErrorForTag<E, Tag>)
          return next instanceof ResultAsync ? next.innerPromise : next
        }

        return Result.err(res.error as ExcludeTag<E, Tag>)
      }),
    )
  }

  public catchTags<const Handlers extends object>(
    handlers: Handlers & CatchTagHandlers<E, Handlers>,
  ): ResultAsync<
    T | HandlerOk<CatchTagHandlerResult<Handlers>>,
    ExcludeTag<E, keyof Handlers & string> | HandlerErr<CatchTagHandlerResult<Handlers>>
  > {
    return new ResultAsync<
      T | HandlerOk<CatchTagHandlerResult<Handlers>>,
      ExcludeTag<E, keyof Handlers & string> | HandlerErr<CatchTagHandlerResult<Handlers>>
    >(
      this.innerPromise.then((res) => {
        if (res.isOk()) {
          return Result.ok(res.value)
        }

        const error = res.error
        const handled = callTaggedHandler<CatchTagHandlerResult<Handlers>>(error, handlers)

        if (handled.matched) {
          const next = handled.value as Result<unknown, unknown> | ResultAsync<unknown, unknown>
          return next instanceof ResultAsync ? next.innerPromise : next
        }

        return Result.err(error as ExcludeTag<E, keyof Handlers & string>)
      }) as Promise<
        Result<
          T | HandlerOk<CatchTagHandlerResult<Handlers>>,
          ExcludeTag<E, keyof Handlers & string> | HandlerErr<CatchTagHandlerResult<Handlers>>
        >
      >,
    )
  }

  public async match<A, B = A>(handlers: MatchHandlers<T, E, A, B>): Promise<A | B>
  public async match<A, B = A>(ok: (t: T) => A, fnErr: (e: E) => B): Promise<A | B>
  public async match<A, B = A>(
    input: MatchHandlers<T, E, A, B> | ((t: T) => A),
    fnErr?: (e: E) => B,
  ): Promise<A | B> {
    return this.innerPromise.then((res) =>
      typeof input === 'function'
        ? res.match(input, getMatchErrorHandler(input, fnErr))
        : res.match(input),
    )
  }

  public async matchTags<A, const Handlers extends object>(
    ok: (t: T) => A,
    handlers: Handlers & MatchTagHandlers<E, Handlers>,
  ): Promise<A | MatchTagHandlerResult<Handlers>> {
    return this.innerPromise.then((res) =>
      matchResolvedResultTags<T, E, A, MatchTagHandlerResult<Handlers>, never>({
        result: res,
        ok,
        handlers,
        fallback: (error) => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw error
        },
      }),
    )
  }

  public async matchTagsPartial<A, B, const Handlers extends object>(
    ok: (t: T) => A,
    handlers: Handlers & PartialMatchTagHandlers<E, Handlers>,
    fallback: (error: E) => B,
  ): Promise<A | MatchTagHandlerResult<Handlers> | B> {
    return this.innerPromise.then((res) =>
      matchResolvedResultTags<T, E, A, MatchTagHandlerResult<Handlers>, B>({
        result: res,
        ok,
        handlers,
        fallback,
      }),
    )
  }

  public async unwrapOr<A>(t: A): Promise<T | A> {
    return this.innerPromise.then((res) => res.unwrapOr(t))
  }

  public async unwrapOrThrow(): Promise<T> {
    return this.innerPromise.then((res) => res.unwrapOrThrow())
  }

  /**
   * Runs a side effect for either variant and preserves the original async result.
   *
   * For `Ok`, the callback receives `(value, undefined)`.
   * For `Err`, the callback receives `(undefined, error)`.
   * Callback errors and rejected callback promises are intentionally ignored.
   *
   * Use `map`, `mapErr`, `andThen`, or `orElse` when the callback should
   * transform the result.
   */
  public log(f: (t?: T, e?: E) => void | Promise<void>): ResultAsync<T, E> {
    return new ResultAsync(
      this.innerPromise.then(async (res) => {
        if (res.isOk()) {
          await callAsyncSideEffect(() => f(res.value))

          return okAsync(res.value)
        }

        await callAsyncSideEffect(() => f(undefined, res.error))

        return errAsync(res.error)
      }),
    )
  }

  /**
   * Runs a side effect only for the `Ok` variant and preserves the original async result.
   *
   * Callback errors and rejected callback promises are intentionally ignored.
   * Use `map` or `andThen` when the callback should transform the value.
   */
  public tap(f: (t: T) => void | Promise<void>): ResultAsync<T, E> {
    return new ResultAsync(
      this.innerPromise.then(async (res) => {
        if (res.isErr()) {
          return errAsync(res.error)
        }

        await callAsyncSideEffect(() => f(res.value))

        return okAsync(res.value)
      }),
    )
  }

  /**
   * Runs a side effect only for the `Err` variant and preserves the original async result.
   *
   * Callback errors and rejected callback promises are intentionally ignored.
   * Use `mapErr` or `orElse` when the callback should transform the error.
   */
  public tapError(f: (e: E) => void | Promise<void>): ResultAsync<T, E> {
    return new ResultAsync(
      this.innerPromise.then(async (res) => {
        if (res.isErr()) {
          await callAsyncSideEffect(() => f(res.error))

          return errAsync(res.error)
        }

        return okAsync(res.value)
      }),
    )
  }

  public toAsyncDisposable(f: ResultAsyncFinalizer<T, E>): DisposableResultAsync<T, E> {
    return new DisposableResultAsync(this.innerPromise, f)
  }

  public async *[Symbol.asyncIterator](): AsyncGenerator<Result<never, E>, T> {
    const result = await this.innerPromise

    if (result.isOk()) {
      return result.value
    }

    yield err(result.error)

    return undefined as T
  }
}

registerResultAsyncFactory(
  (promise) => new ResultAsync(promise as Promise<Result<unknown, unknown>>),
)

export type StrictResultAsync<T, E extends Error = Error> = ResultAsync<T, E>

export const okAsync: typeof ResultAsync.okAsync = ResultAsync.okAsync
export const errAsync: typeof ResultAsync.errAsync = ResultAsync.errAsync
export const fromPromise: typeof ResultAsync.fromPromise = ResultAsync.fromPromise
export const fromSafePromise: typeof ResultAsync.fromSafePromise = ResultAsync.fromSafePromise
export const unitAsync: typeof ResultAsync.unitAsync = ResultAsync.unitAsync
export const fromThrowableAsync: typeof ResultAsync.fromThrowable = ResultAsync.fromThrowable

export function tryResultAsync<T, E>(
  fn: Promise<T> | (() => Promise<T>),
  errorFn: (e: unknown) => E,
): ResultAsync<T, E>
export function tryResultAsync<T, E>(
  options: TryResultAsyncOptions<T, E> & { readonly catch: (e: unknown) => E },
): ResultAsync<T, E>
export function tryResultAsync<T>(
  input: Promise<T> | (() => Promise<T>) | TryResultAsyncOptions<T>,
): ResultAsync<T, unknown>
export function tryResultAsync<T, E = unknown>(
  input: Promise<T> | (() => Promise<T>) | TryResultAsyncOptions<T, E>,
  errorFn?: (e: unknown) => E,
): ResultAsync<T, E> {
  const promiseOrFn = isTryResultAsyncOptions(input) ? input.try : input
  const catchFn = isTryResultAsyncOptions(input) ? input.catch : errorFn
  const promiseToProcess =
    typeof promiseOrFn === 'function' ? Promise.try(promiseOrFn) : promiseOrFn
  const newPromise = promiseToProcess
    .then((value: T) => Result.ok<T, E>(value))
    .catch((error: unknown) => {
      if (catchFn) {
        return Result.err<T, E>(catchFn(error))
      }

      return Result.err<T, E>(error as E)
    })

  return new ResultAsync<T, E>(newPromise)
}

/** Compatibility alias. Prefer `tryResultAsync` in new code. */
export const tryCatchAsync: typeof tryResultAsync = tryResultAsync

// Combines the array of async results into one result.
export type CombineResultAsyncs<T extends readonly ResultAsync<unknown, unknown>[]> =
  IsLiteralArray<T> extends 1
    ? TraverseAsync<UnwrapAsync<T>>
    : ResultAsync<ExtractOkAsyncTypes<T>, ExtractErrAsyncTypes<T>[number]>

// Combines the array of async results into one result with all errors.
export type CombineResultsWithAllErrorsArrayAsync<
  T extends readonly ResultAsync<unknown, unknown>[],
> =
  IsLiteralArray<T> extends 1
    ? TraverseWithAllErrorsAsync<UnwrapAsync<T>>
    : ResultAsync<ExtractOkAsyncTypes<T>, ExtractErrAsyncTypes<T>[number][]>

// Unwraps the inner `Result` from a `ResultAsync` for all elements.
type UnwrapAsync<T> =
  IsLiteralArray<T> extends 1
    ? Writable<T> extends [infer H, ...infer Rest]
      ? H extends PromiseLike<infer HI>
        ? HI extends Result<unknown, unknown>
          ? [Dedup<HI>, ...UnwrapAsync<Rest>]
          : never
        : never
      : []
    : // If we got something too general such as ResultAsync<X, Y>[] then we
      // simply need to map it to ResultAsync<X[], Y[]>. Yet `ResultAsync`
      // itself is a union therefore it would be enough to cast it to Ok.
      T extends (infer A)[]
      ? A extends PromiseLike<infer HI>
        ? HI extends Result<infer L, infer R>
          ? Result<L, R>[]
          : never
        : never
      : never

// Traverse through the tuples of the async results and create one
// `ResultAsync` where the collected tuples are merged.
type TraverseAsync<T, Depth extends number = 5> =
  IsLiteralArray<T> extends 1
    ? Combine<T, Depth> extends [infer Oks, infer Errs]
      ? ResultAsync<EmptyArrayToNever<Oks>, MembersToUnion<Errs>>
      : never
    : // The following check is important if we somehow reach to the point of
      // checking something similar to ResultAsync<X, Y>[]. In this case we don't
      // know the length of the elements, therefore we need to traverse the X and Y
      // in a way that the result should contain X[] and Y[].
      T extends (infer I)[]
      ? // The MemberListOf<I> here is to include all possible types. Therefore
        // if we face (ResultAsync<X, Y> | ResultAsync<A, B>)[] this type should
        // handle the case.
        Combine<MemberListOf<I>, Depth> extends [infer Oks, infer Errs]
        ? // The following `extends unknown[]` checks are just to satisfy the TS.
          // we already expect them to be an array.
          Oks extends unknown[]
          ? Errs extends unknown[]
            ? ResultAsync<EmptyArrayToNever<Oks[number][]>, MembersToUnion<Errs[number][]>>
            : ResultAsync<EmptyArrayToNever<Oks[number][]>, Errs>
          : // The rest of the conditions are to satisfy the TS and support
            // the edge cases which are not really expected to happen.
            Errs extends unknown[]
            ? ResultAsync<Oks, MembersToUnion<Errs[number][]>>
            : ResultAsync<Oks, Errs>
        : never
      : never

// This type is similar to the `TraverseAsync` while the errors are also
// collected in a list. For the checks/conditions made here, see that type
// for the documentation.
type TraverseWithAllErrorsAsync<T, Depth extends number = 5> =
  TraverseAsync<T, Depth> extends ResultAsync<infer Oks, infer Errs>
    ? ResultAsync<Oks, Errs[]>
    : never

// Converts a reaodnly array into a writable array
type Writable<T> = T extends readonly unknown[] ? [...T] : T
