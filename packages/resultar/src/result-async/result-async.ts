/* eslint-disable @typescript-eslint/no-deprecated -- Preserve the supported deprecated eager Async contract. */
import { AbortError } from '../core/abort-error.js'
import { dual } from '../core/dual.js'
import { Pipeable } from '../core/pipe.js'
import {
  isRetryPolicy,
  observeRetry,
  retryContext,
  retryPolicyDelay,
  validateRetryPolicy,
} from '../core/retry.js'
import type { RetryContext, RetryPolicy } from '../core/retry.js'
import type { InferErrTypes, InferOkTypes } from '../core/utils.js'
import { Result, err, ok as resultOk } from '../result/result.js'
import {
  createEmptyResultsCollectionError,
  getMatchErrorHandler,
} from '../result/result-helpers.js'
import type {
  Combine,
  Dedup,
  EmptyArrayToNever,
  IsLiteralArray,
  MatchHandlers,
  MemberListOf,
  MembersToUnion,
} from '../result/result-types.js'
import { isError } from '../tagged/tagged-match.js'
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
  ReasonsOf,
  ReasonTagsOf,
  RemainingMatchTagErrors,
  TagsOf,
  TagsWithReasonOf,
} from '../tagged/tagged-types.js'
import type { ResultTask } from '../task/result-task.js'
import { isResultTask } from '../task/task-helpers.js'
import type {
  ExtractErrAsyncTypes,
  ExtractOkAsyncTypes,
  InferAsyncErrTypes,
  InferAsyncOkTypes,
  ResultAsyncCatchReasonHandlers as CatchReasonHandlers,
  ResultAsyncCatchTagHandlers as CatchTagHandlers,
} from './async-types.js'
import { DisposableResultAsync } from './disposable-result-async.js'
import type { ResultAsyncFinalizer } from './disposable-result-async.js'
import { registerResultAsyncFactory } from './result-async-adapter.js'

/**
 * Object form accepted by `tryResultAsync`.
 *
 * Use this form when named `try` and `catch` fields make an async boundary easier to read, or when
 * you want the mapper next to the promise factory.
 */
export interface TryResultAsyncOptions<T, E = unknown> {
  /**
   * Creates the promise whose rejection should become `Err<E>`.
   *
   * Synchronous throws from this function are also captured.
   */
  readonly try: () => Promise<T>
  /**
   * Converts a rejected or thrown `unknown` cause into the typed Resultar error channel.
   *
   * If omitted, the error channel is `unknown`.
   */
  readonly catch?: (e: unknown) => E
}

/** Minimal abort-signal contract used by cancellable Resultar operations. */
export interface ResultAsyncAbortSignal {
  /**
   * Whether the cooperative async operation has been aborted.
   */
  readonly aborted: boolean
  /**
   * Optional abort cause provided by the losing race, timeout, or caller.
   */
  readonly reason?: unknown
  /**
   * Registers an abort listener.
   */
  addEventListener: (
    type: 'abort',
    listener: () => void,
    options?: { readonly once?: boolean },
  ) => void
  /**
   * Removes an abort listener.
   */
  removeEventListener: (type: 'abort', listener: () => void) => void
}

/**
 * Context passed to `ResultAsync.fromCallback` subscriptions.
 */
export interface ResultAsyncCallbackContext<T> {
  /**
   * Completes the operation with `Ok(value)`.
   */
  readonly resolve: (value: T) => void
  /**
   * Completes the operation with a cause mapped by the subscription's `catch` function.
   */
  readonly reject: (cause: unknown) => void
  /**
   * Cooperative cancellation signal for the subscription.
   */
  readonly signal: ResultAsyncAbortSignal
}

/**
 * Synchronous cleanup returned by a `ResultAsync.fromCallback` subscription.
 */
export type ResultAsyncCallbackCleanup = () => void

/**
 * Options for adapting a callback or subscription API into `ResultAsync`.
 */
export interface ResultAsyncFromCallbackOptions<T, E> {
  /**
   * Maps callback failures and synchronous subscription throws into the typed error channel.
   */
  readonly catch: (cause: unknown) => E
  /**
   * Optional external signal that cancels the subscription with `AbortError`.
   */
  readonly signal?: ResultAsyncAbortSignal
  /**
   * Registers the callback source and optionally returns a synchronous unsubscribe function.
   */
  readonly subscribe: (context: ResultAsyncCallbackContext<T>) => ResultAsyncCallbackCleanup | void
}

/**
 * Concurrency setting for async collection helpers.
 *
 * Use a number for bounded parallelism or `'unbounded'` when every task may start immediately.
 */
export type ResultAsyncConcurrency = number | 'unbounded'

type HandlerOk<R> = InferOkTypes<R> | InferAsyncOkTypes<R>
type HandlerErr<R> = InferErrTypes<R> | InferAsyncErrTypes<R>
type IterableElement<T> = T extends Iterable<infer Element> ? Element : never
/**
 * Candidate used by `ResultAsync.firstSuccessOf`.
 */
export type ResultAsyncCandidate = () => ResultAsync<unknown, unknown>
type ResultAsyncRecord = Readonly<Record<string, ResultAsync<unknown, unknown>>>
type CombineResultAsyncsRecord<T extends ResultAsyncRecord> = ResultAsync<
  { readonly [Key in keyof T]: InferAsyncOkTypes<T[Key]> },
  InferAsyncErrTypes<T[keyof T]>
>
type CombineResultAsyncsRecordWithAllErrors<T extends ResultAsyncRecord> = ResultAsync<
  { readonly [Key in keyof T]: InferAsyncOkTypes<T[Key]> },
  InferAsyncErrTypes<T[keyof T]>[]
>
type CombineResultAsyncsIterable<R extends ResultAsync<unknown, unknown>> = ResultAsync<
  readonly InferAsyncOkTypes<R>[],
  InferAsyncErrTypes<R>
>
type CombineResultAsyncsIterableWithAllErrors<R extends ResultAsync<unknown, unknown>> =
  ResultAsync<readonly InferAsyncOkTypes<R>[], InferAsyncErrTypes<R>[]>
/**
 * Task used by race, timeout, and retry helpers.
 *
 * The signal lets the task cooperate with cancellation when another task wins or a timeout fires.
 */
export type ResultAsyncRaceTask<T, E> = (signal: ResultAsyncAbortSignal) => ResultAsync<T, E>
type ResultAsyncRaceTaskOk<Task> = Task extends ResultAsyncRaceTask<infer T, unknown> ? T : never
type ResultAsyncRaceTaskErr<Task> = Task extends ResultAsyncRaceTask<unknown, infer E> ? E : never
type ResultAsyncRaceTasksOk<Tasks extends readonly ResultAsyncRaceTask<unknown, unknown>[]> =
  ResultAsyncRaceTaskOk<Tasks[number]>
type ResultAsyncRaceTasksErr<Tasks extends readonly ResultAsyncRaceTask<unknown, unknown>[]> =
  ResultAsyncRaceTaskErr<Tasks[number]>
/** Running cancellable task returned by Resultar race helpers. */
export interface ResultAsyncRaceHandle<T, E> {
  /**
   * Abort signal associated with the running task.
   */
  readonly signal: ResultAsyncAbortSignal
  /**
   * Aborts the running task with an optional reason.
   */
  abort: (reason?: unknown) => void
  /**
   * Waits for the task to settle as a ResultAsync.
   */
  wait: () => ResultAsync<T, E>
}

/**
 * Options for `ResultAsync.timeout`.
 */
export interface ResultAsyncTimeoutOptions<E> {
  /**
   * Creates the typed timeout error when the timeout wins.
   */
  readonly onTimeout: () => E
  /**
   * Timeout duration in milliseconds.
   */
  readonly timeoutMs: number
}

/**
 * Metadata passed to retry predicates, delays, callbacks, and fallback handlers.
 */
export interface ResultAsyncRetryContext extends RetryContext {
  /**
   * Current attempt number, starting at 0.
   */
  readonly attempt: number
  /**
   * Next attempt number if another retry is scheduled.
   */
  readonly nextAttempt: number
  /**
   * Number of retries still available after the current failure.
   */
  readonly retriesRemaining: number
}

/**
 * Task used by `ResultAsync.retry` and `ResultAsync.retryOrElse`.
 */
export type ResultAsyncRetryTask<T, E> = (
  attempt: number,
  signal: ResultAsyncAbortSignal,
) => ResultAsync<T, E>
type ResultAsyncRetryTaskOk<Task> = Task extends ResultAsyncRetryTask<infer T, infer _E> ? T : never
type ResultAsyncRetryTaskErr<Task> =
  Task extends ResultAsyncRetryTask<infer _T, infer E> ? E : never
// eslint-disable-next-line typescript/no-explicit-any -- Unknown contextual returns erase concrete errors in inline factories; outputs are inferred from Task.
type ResultAsyncRetryCandidate = ResultAsyncRetryTask<any, any>
type ResultAsyncRetryDelay = number | ((context: ResultAsyncRetryContext) => number)
/** Retry policy for `ResultAsync.retry` and related helpers. */
export interface ResultAsyncRetryOptions<E> {
  /**
   * Delay in milliseconds before retrying. Functions receive retry context.
   */
  readonly delayMs?: ResultAsyncRetryDelay
  /**
   * Randomizes the computed delay by this percentage factor.
   *
   * For example, `0.5` means 50% below to 50% above the computed delay.
   */
  readonly jittered?: number
  /**
   * Side effect called after a failed attempt that will be retried.
   */
  readonly onRetry?: (error: E, context: ResultAsyncRetryContext) => void | Promise<void>
  /**
   * Optional external abort signal for the retry loop.
   */
  readonly signal?: ResultAsyncAbortSignal
  /**
   * Maximum number of retries after the initial attempt.
   */
  readonly times: number
  /**
   * Predicate deciding whether a failure is retryable.
   */
  readonly while?: (error: E, context: ResultAsyncRetryContext) => boolean | Promise<boolean>
}

/**
 * Options for `ResultAsync.retryOrElse`.
 */
export interface ResultAsyncRetryOrElseOptions<E, F, U> extends ResultAsyncRetryOptions<E> {
  /**
   * Fallback Resultar operation used after retry exhaustion.
   */
  readonly orElse: (error: E, context: ResultAsyncRetryContext) => Result<U, F> | ResultAsync<U, F>
}

type ResultAsyncRetryInput<E> =
  | ResultAsyncRetryOptions<E>
  | (RetryPolicy<E> & { readonly signal?: ResultAsyncAbortSignal })
type ResultAsyncRetryOrElseInput<E, F, U> = ResultAsyncRetryInput<E> & {
  readonly orElse: (error: E, context: ResultAsyncRetryContext) => Result<U, F> | ResultAsync<U, F>
}

/**
 * Acquires a resource for `ResultAsync.withResource`.
 */
export type ResultAsyncResourceAcquire<Resource, E> = (
  signal: ResultAsyncAbortSignal,
) => ResultAsync<Resource, E>
/**
 * Operation accepted by `ResultAsync.withResource` use/release callbacks.
 */
export type ResultAsyncResourceEffect<T, E> = Result<T, E> | ResultAsync<T, E>
/**
 * Uses an acquired resource inside `ResultAsync.withResource`.
 */
export type ResultAsyncResourceUse<Resource, T, E> = (
  resource: Resource,
  signal: ResultAsyncAbortSignal,
) => ResultAsyncResourceEffect<T, E>

/**
 * Context passed to resource release callbacks.
 */
export interface ResultAsyncResourceReleaseContext {
  /**
   * Result produced by the use phase, or undefined when acquisition failed.
   */
  readonly result: Result<unknown, unknown> | undefined
  /**
   * Abort signal shared by the resource lifecycle.
   */
  readonly signal: ResultAsyncAbortSignal
}
/**
 * Releases a resource after use, regardless of success or failure.
 */
export type ResultAsyncResourceRelease<Resource> = (
  resource: Resource,
  context: ResultAsyncResourceReleaseContext,
) => ResultAsyncResourceEffect<unknown, unknown> | Promise<void> | void

/**
 * Options for `ResultAsync.withResource`.
 */
export interface ResultAsyncWithResourceOptions<Resource, AcquireError, T, UseError> {
  /**
   * Acquires the resource.
   */
  readonly acquire: ResultAsyncResourceAcquire<Resource, AcquireError>
  /**
   * Releases the resource after use.
   */
  readonly release: ResultAsyncResourceRelease<Resource>
  /**
   * Optional external abort signal for the full lifecycle.
   */
  readonly signal?: ResultAsyncAbortSignal
  /**
   * Uses the acquired resource.
   */
  readonly use: ResultAsyncResourceUse<Resource, T, UseError>
}
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
type ResultAsyncCondition =
  | ResultAsyncBooleanCondition
  | ResultAsyncConditionResult
  | (() => ResultAsyncConditionResult)
type ResultAsyncConditionError<Condition> = Condition extends () => infer Value
  ? HandlerErr<Value>
  : HandlerErr<Condition>
type ResultAsyncIf<
  ConditionErr,
  OnTrue extends ResultAsyncConditional,
  OnFalse extends ResultAsyncConditional,
> = ResultAsync<
  HandlerOk<OnTrue> | HandlerOk<OnFalse>,
  ConditionErr | HandlerErr<OnTrue> | HandlerErr<OnFalse>
>
type ResultAsyncWhen<R extends ResultAsyncConditional, ConditionErr = never> = ResultAsync<
  HandlerOk<R> | undefined,
  ConditionErr | HandlerErr<R>
>
type ResultAsyncWhenWithCondition<
  Condition extends ResultAsyncConditionResult,
  R extends ResultAsyncConditional,
> = ResultAsyncWhen<R, HandlerErr<Condition>>
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
  readonly concurrency?: ResultAsyncConcurrency
  readonly discard?: false
}

interface ResultAsyncForEachDiscardOptions {
  readonly concurrency?: ResultAsyncConcurrency
  readonly discard: true
}

interface ResultAsyncForEachRuntimeOptions {
  readonly concurrency?: ResultAsyncConcurrency
  readonly discard?: boolean
}

interface ResultAsyncValidateAllOptions {
  readonly concurrency?: ResultAsyncConcurrency
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
  // Stryker disable next-line all: guards prevent applying `in` to null/non-objects in invalid runtime calls.
  return typeof input === 'object' && input !== null && 'try' in input
}

const combineResultAsyncList = <T, E>(
  asyncResultList: readonly ResultAsync<T, E>[],
): ResultAsync<readonly T[], E> =>
  ResultAsync.fromSafePromise(Promise.all(asyncResultList)).andThen((resultList) =>
    Result.combine(resultList),
  )

const collectResultAsyncRecord = async (
  asyncResultRecord: ResultAsyncRecord,
): Promise<Record<string, Result<unknown, unknown>>> => {
  const entries = await Promise.all(
    Object.entries(asyncResultRecord).map(
      async ([key, asyncResult]) => [key, await asyncResult] as const,
    ),
  )

  return Object.fromEntries(entries)
}

const combineResultAsyncRecord = <T extends ResultAsyncRecord>(
  asyncResultRecord: T,
): CombineResultAsyncsRecord<T> => {
  const promise = collectResultAsyncRecord(asyncResultRecord).then((resultRecord) =>
    Result.combine(resultRecord),
  )
  return new ResultAsync(promise) as CombineResultAsyncsRecord<T>
}

const combineResultAsyncListWithAllErrors = <T, E>(
  asyncResultList: readonly ResultAsync<T, E>[],
): ResultAsync<readonly T[], E[]> =>
  ResultAsync.fromSafePromise(Promise.all(asyncResultList)).andThen((resultList) =>
    Result.combineWithAllErrors(resultList),
  ) as ResultAsync<T[], E[]>

const combineResultAsyncRecordWithAllErrors = <T extends ResultAsyncRecord>(
  asyncResultRecord: T,
): CombineResultAsyncsRecordWithAllErrors<T> => {
  const promise = collectResultAsyncRecord(asyncResultRecord).then((resultRecord) =>
    Result.combineWithAllErrors(resultRecord),
  )
  return new ResultAsync(promise) as CombineResultAsyncsRecordWithAllErrors<T>
}

const isIterable = (value: unknown): value is Iterable<unknown> =>
  // Stryker disable next-line all: invalid null input still fails outside the iterable branch; this guard keeps the hot check explicit.
  value !== null &&
  (typeof value === 'object' || typeof value === 'function') &&
  typeof (value as { readonly [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'

interface IndexedResultAsyncError<E> {
  readonly error: E
  readonly index: number
}

const createIllegalArgumentException = (message: string): Error => {
  const error = new Error(message)
  error.name = 'IllegalArgumentException'

  return error
}

const createInvalidResultAsyncConcurrencyError = (): Error =>
  createIllegalArgumentException(
    'ResultAsync concurrency must be a positive integer or "unbounded"',
  )

const normalizeResultAsyncConcurrency = (concurrency?: ResultAsyncConcurrency): number => {
  if (concurrency === undefined) {
    return 1
  }

  if (concurrency === 'unbounded') {
    return Number.POSITIVE_INFINITY
  }

  if (Number.isInteger(concurrency) && concurrency > 0) {
    return concurrency
  }

  throw createInvalidResultAsyncConcurrencyError()
}

const toResultAsyncRejectionError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error))

const sortIndexedResultAsyncErrors = <E>(
  errors: readonly IndexedResultAsyncError<E>[],
): IndexedResultAsyncError<E>[] => [...errors].toSorted((left, right) => left.index - right.index)

interface ResultAsyncTraversalState<T, E> {
  activeCount: number
  readonly errors: IndexedResultAsyncError<E>[]
  iteratorDone: boolean
  nextIndex: number
  stopScheduling: boolean
  readonly values: T[]
}

interface RunConcurrentResultAsyncItemsOptions<Item, T, E, Output, Failure> {
  readonly concurrency: ResultAsyncConcurrency | undefined
  readonly finish: (state: ResultAsyncTraversalState<T, E>) => Result<Output, Failure> | undefined
  readonly items: Iterable<Item>
  readonly onResult: (
    result: Result<T, E>,
    index: number,
    state: ResultAsyncTraversalState<T, E>,
  ) => void
  readonly run: (value: Item, index: number) => ResultAsync<T, E>
}

const createResultAsyncTraversalState = <T, E>(): ResultAsyncTraversalState<T, E> => ({
  activeCount: 0,
  errors: [],
  iteratorDone: false,
  nextIndex: 0,
  stopScheduling: false,
  values: [],
})

const runConcurrentResultAsyncItems = <Item, T, E, Output, Failure>(
  options: RunConcurrentResultAsyncItemsOptions<Item, T, E, Output, Failure>,
): Promise<Result<Output, Failure>> =>
  Promise.try(async () => {
    const concurrency = normalizeResultAsyncConcurrency(options.concurrency)
    const iterator = options.items[Symbol.iterator]()
    const state = createResultAsyncTraversalState<T, E>()

    return new Promise<Result<Output, Failure>>((resolve, reject) => {
      let settled = false

      const rejectOnce = (error: unknown): void => {
        // Stryker disable next-line all: setting the guard prevents later state updates after rejection.
        settled = true
        reject(toResultAsyncRejectionError(error))
      }

      const finishIfDone = (): void => {
        const result = options.finish(state)

        if (result !== undefined) {
          // Stryker disable next-line all: setting the guard prevents later state updates after resolution.
          settled = true
          resolve(result)
        }
      }

      const readNext = (): IteratorResult<Item> | undefined => {
        try {
          return iterator.next()
        } catch (error) {
          rejectOnce(error)
          return undefined
        }
      }

      const schedule = (): void => {
        while (!state.stopScheduling && !state.iteratorDone && state.activeCount < concurrency) {
          const next = readNext()

          // Stryker disable next-line all: undefined means iterator.next threw and rejectOnce already settled.
          if (next === undefined) {
            return
          }

          if (next.done === true) {
            state.iteratorDone = true
            break
          }

          const currentIndex = state.nextIndex
          state.nextIndex += 1
          startItem(next.value, currentIndex)
        }

        finishIfDone()
      }

      const startItem = (item: Item, currentIndex: number): void => {
        state.activeCount += 1

        try {
          const resultAsync = options.run(item, currentIndex)

          void Promise.resolve(resultAsync)
            .then((result) => {
              options.onResult(result, currentIndex, state)
            }, rejectOnce)
            .finally(() => {
              // Stryker disable next-line all: skip bookkeeping after rejectOnce/resolveOnce settled the promise.
              if (settled) {
                return
              }

              state.activeCount -= 1
              schedule()
            })
        } catch (error) {
          rejectOnce(error)
        }
      }

      schedule()
    })
  })

const createResultAsyncRetryAbortError = (signal: ResultAsyncAbortSignal): AbortError =>
  signal.reason === undefined
    ? new AbortError('ResultAsync retry aborted')
    : new AbortError('ResultAsync retry aborted', { cause: signal.reason })

const createResultAsyncResourceAbortError = (signal: ResultAsyncAbortSignal): AbortError =>
  signal.reason === undefined
    ? new AbortError('ResultAsync resource scope aborted')
    : new AbortError('ResultAsync resource scope aborted', { cause: signal.reason })

const createResultAsyncCallbackAbortError = (signal: ResultAsyncAbortSignal): AbortError =>
  signal.reason === undefined
    ? new AbortError('ResultAsync callback aborted')
    : new AbortError('ResultAsync callback aborted', { cause: signal.reason })

const emptyResultAsyncCallbackCleanup = (): void => undefined

const callResultAsyncCallbackCleanup = (cleanup: ResultAsyncCallbackCleanup): void => {
  try {
    cleanup()
  } catch {
    /* Cleanup is best-effort; use ResultTask.scoped/acquireRelease to preserve release failures. */
  }
}

const normalizeResultAsyncCallbackUnexpectedError = (error: unknown): Error =>
  isError(error)
    ? error
    : new Error('ResultAsync callback error mapper threw a non-Error value', { cause: error })

type ResultAsyncCallbackSettlement<T, E> =
  | { readonly error: unknown }
  | { readonly result: Result<T, E | AbortError> }

interface ResultAsyncCallbackCompletion<T, E> {
  readonly rejectResult: (error: Error) => void
  readonly resolveResult: (result: Result<T, E | AbortError>) => void
  readonly settlement: ResultAsyncCallbackSettlement<T, E>
}

const completeResultAsyncCallback = <T, E>(
  completion: ResultAsyncCallbackCompletion<T, E>,
): void => {
  if ('error' in completion.settlement) {
    completion.rejectResult(
      normalizeResultAsyncCallbackUnexpectedError(completion.settlement.error),
    )
    return
  }

  completion.resolveResult(completion.settlement.result)
}

const fromResultAsyncCallback = <T, E>(
  options: ResultAsyncFromCallbackOptions<T, E>,
): ResultAsync<T, E | AbortError> => {
  const signal: ResultAsyncAbortSignal = options.signal ?? new AbortController().signal
  const promise = new Promise<Result<T, E | AbortError>>((resolveResult, rejectResult) => {
    if (signal.aborted) {
      resolveResult(Result.err(createResultAsyncCallbackAbortError(signal)))
      return
    }

    let cleanup: ResultAsyncCallbackCleanup = emptyResultAsyncCallbackCleanup
    let settlement: ResultAsyncCallbackSettlement<T, E> | undefined = undefined
    let subscribed = false

    const finalize = (): void => {
      if (!subscribed) {
        return
      }

      const completed = settlement

      if (completed === undefined) {
        return
      }

      signal.removeEventListener('abort', abort)
      callResultAsyncCallbackCleanup(cleanup)
      completeResultAsyncCallback({ rejectResult, resolveResult, settlement: completed })
    }
    const settle = (result: Result<T, E | AbortError>): void => {
      if (settlement !== undefined) {
        return
      }

      settlement = { result }
      finalize()
    }
    const rejectUnexpected = (error: unknown): void => {
      settlement = { error }
      finalize()
    }
    const abort = (): void => {
      settle(Result.err(createResultAsyncCallbackAbortError(signal)))
    }
    const context: ResultAsyncCallbackContext<T> = {
      reject: (cause) => {
        if (settlement !== undefined) {
          return
        }

        try {
          settle(Result.err(options.catch(cause)))
        } catch (error) {
          rejectUnexpected(error)
        }
      },
      resolve: (value) => {
        settle(Result.ok(value))
      },
      signal,
    }

    signal.addEventListener('abort', abort)

    try {
      cleanup = options.subscribe(context) ?? emptyResultAsyncCallbackCleanup
    } catch (error) {
      context.reject(error)
    }

    subscribed = true
    finalize()
  })

  return new ResultAsync(promise)
}

const validateResultAsyncRetryTimes = (times: number): void => {
  if (!Number.isInteger(times) || times < 0) {
    throw createIllegalArgumentException('ResultAsync retry times must be a non-negative integer')
  }
}

const validateResultAsyncRetryDelayValue = (delayMs: number): void => {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw createIllegalArgumentException(
      'ResultAsync retry delayMs must be a non-negative finite number',
    )
  }
}

const validateResultAsyncRetryJittered = (jittered: number): void => {
  if (!Number.isFinite(jittered) || jittered < 0) {
    throw createIllegalArgumentException(
      'ResultAsync retry jittered must be a non-negative finite number',
    )
  }
}

const validateResultAsyncRetryJitterRandomValue = (value: number): void => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw createIllegalArgumentException(
      'ResultAsync retry jitter random value must be a finite number between 0 and 1',
    )
  }
}

const validateResultAsyncRetryStaticJittered = (jittered: number | undefined): void => {
  if (jittered !== undefined) {
    validateResultAsyncRetryJittered(jittered)
  }
}

const validateResultAsyncRetryStaticDelay = (delay: ResultAsyncRetryDelay | undefined): void => {
  if (typeof delay === 'number') {
    validateResultAsyncRetryDelayValue(delay)
  }
}

const validateResultAsyncRetry = <E>(options: ResultAsyncRetryInput<E>): void => {
  if (isRetryPolicy<E>(options)) {
    validateRetryPolicy(options)
  } else {
    validateResultAsyncRetryTimes(options.times)
    validateResultAsyncRetryStaticDelay(options.delayMs)
    validateResultAsyncRetryStaticJittered(options.jittered)
  }
}

const resultAsyncRetryDelay = <E>(
  options: ResultAsyncRetryInput<E>,
  context: ResultAsyncRetryContext,
): number => {
  if (isRetryPolicy<E>(options)) return retryPolicyDelay(options, context, Math.random)
  let delayMs =
    typeof options.delayMs === 'function' ? options.delayMs(context) : (options.delayMs ?? 0)
  validateResultAsyncRetryDelayValue(delayMs)
  const jittered = options.jittered
  if (jittered !== undefined && jittered !== 0 && delayMs !== 0) {
    const random = Math.random()
    validateResultAsyncRetryJitterRandomValue(random)
    const range = delayMs * jittered
    const min = Math.max(0, delayMs - range)
    const max = delayMs + range
    delayMs = min + (max - min) * random
  }
  return delayMs
}

const waitResultAsyncRetryDelay = async (
  delayMs: number,
  signal: ResultAsyncAbortSignal,
): Promise<Result<void, AbortError>> => {
  if (signal.aborted) {
    return Result.err(createResultAsyncRetryAbortError(signal))
  }

  if (delayMs === 0) {
    return Result.ok(undefined)
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve(Result.ok(undefined))
    }, delayMs)
    const abort = (): void => {
      clearTimeout(timeout)
      resolve(Result.err(createResultAsyncRetryAbortError(signal)))
    }

    signal.addEventListener('abort', abort, { once: true })
  })
}

const canRetryResultAsyncAttempt = async <E>(
  options: ResultAsyncRetryInput<E>,
  error: E,
  context: ResultAsyncRetryContext,
): Promise<boolean> => {
  if (context.attempt >= options.times) {
    if (options.while !== undefined && !isRetryPolicy<E>(options)) {
      await options.while(error, context)
    }
    return false
  }
  return options.while === undefined ? true : options.while(error, context)
}

// Expected failures stay in Result; unexpected callback failures reject the eager operation.
const runResultAsyncRetryAttempts = async <T, E, U, F>(
  task: ResultAsyncRetryTask<T, E>,
  options: ResultAsyncRetryInput<E>,
  recover: (error: E, context: ResultAsyncRetryContext) => Result<U, F> | ResultAsync<U, F>,
): Promise<Result<T | U, F | AbortError>> => {
  validateResultAsyncRetry(options)

  const signal: ResultAsyncAbortSignal = options.signal ?? new AbortController().signal
  let attempt = 0

  while (true) {
    if (signal.aborted) {
      return Result.err(createResultAsyncRetryAbortError(signal))
    }

    // eslint-disable-next-line no-await-in-loop
    const result = await task(attempt, signal)

    if (result.isOk()) {
      return Result.ok(result.value)
    }

    const context = retryContext(attempt, options.times)

    // eslint-disable-next-line no-await-in-loop
    if (!(await canRetryResultAsyncAttempt(options, result.error, context))) {
      return recover(result.error, context)
    }

    const onRetry = options.onRetry

    // Stryker disable next-line all: skip a needless function call and await when no retry hook exists.
    if (onRetry !== undefined) {
      // eslint-disable-next-line no-await-in-loop
      await observeRetry(options, result.error, context)
    }

    const delayMs = resultAsyncRetryDelay(options, context)

    // eslint-disable-next-line no-await-in-loop
    const delayResult = await waitResultAsyncRetryDelay(delayMs, signal)

    if (delayResult.isErr()) {
      return Result.err(delayResult.error)
    }

    attempt += 1
  }
}

const retryResultAsyncTask = <T, E>(
  task: ResultAsyncRetryTask<T, E>,
  options: ResultAsyncRetryInput<E>,
): ResultAsync<T, E | AbortError> =>
  new ResultAsync(
    runResultAsyncRetryAttempts<T, E, never, E>(task, options, (error) => Result.err(error)),
  )

const retryOrElseResultAsyncTask = <T, E, U, F>(
  task: ResultAsyncRetryTask<T, E>,
  options: ResultAsyncRetryOrElseInput<E, F, U>,
): ResultAsync<T | U, F | AbortError> =>
  new ResultAsync(
    runResultAsyncRetryAttempts<T, E, U, F>(task, options, (error, context) =>
      options.orElse(error, context),
    ),
  )

const callResultAsyncResourceRelease = async <Resource>(
  release: ResultAsyncResourceRelease<Resource>,
  resource: Resource,
  context: ResultAsyncResourceReleaseContext,
): Promise<void> => {
  try {
    await release(resource, context)
  } catch {
    /* empty */
  }
}

const runResultAsyncWithResource = async <Resource, AcquireError, T, UseError>(
  options: ResultAsyncWithResourceOptions<Resource, AcquireError, T, UseError>,
): Promise<Result<T, AcquireError | UseError | AbortError>> => {
  const signal: ResultAsyncAbortSignal = options.signal ?? new AbortController().signal

  if (signal.aborted) {
    return Result.err(createResultAsyncResourceAbortError(signal))
  }

  const acquired = await options.acquire(signal)

  if (acquired.isErr()) {
    return Result.err(acquired.error)
  }

  let result: Result<T, UseError | AbortError> | undefined = undefined

  try {
    if (signal.aborted) {
      result = Result.err(createResultAsyncResourceAbortError(signal))
      return result
    }

    result = await toResultAsync(options.use(acquired.value, signal))

    return result
  } finally {
    await callResultAsyncResourceRelease(options.release, acquired.value, { result, signal })
  }
}

const withResultAsyncResource = <Resource, AcquireError, T, UseError>(
  options: ResultAsyncWithResourceOptions<Resource, AcquireError, T, UseError>,
): ResultAsync<T, AcquireError | UseError | AbortError> =>
  new ResultAsync(runResultAsyncWithResource(options))

const validateAllResultAsyncItems = <Item, R extends ResultAsync<unknown, unknown>>(
  items: Iterable<Item>,
  f: (value: Item, index: number) => R,
  options?: ResultAsyncValidateAllOptions,
): ResultAsyncValidatedAll<R> => {
  const promise: Promise<Result<readonly InferAsyncOkTypes<R>[], InferAsyncErrTypes<R>[]>> =
    runConcurrentResultAsyncItems({
      concurrency: options?.concurrency,
      finish: (state) => {
        if (!state.iteratorDone || state.activeCount > 0) {
          return undefined
        }

        if (state.errors.length > 0) {
          return Result.err<readonly InferAsyncOkTypes<R>[], InferAsyncErrTypes<R>[]>(
            sortIndexedResultAsyncErrors(state.errors).map((entry) => entry.error),
          )
        }

        return Result.ok<readonly InferAsyncOkTypes<R>[], InferAsyncErrTypes<R>[]>(state.values)
      },
      items,
      onResult: (result, currentIndex, state) => {
        if (result.isErr()) {
          state.errors.push({ error: result.error, index: currentIndex })
          return
        }

        state.values[currentIndex] = result.value
      },
      run: f as (
        value: Item,
        index: number,
      ) => ResultAsync<InferAsyncOkTypes<R>, InferAsyncErrTypes<R>>,
    })

  return new ResultAsync(promise) as ResultAsyncValidatedAll<R>
}

const firstSuccessOfAsyncCandidates = <Candidates extends Iterable<ResultAsyncCandidate>>(
  candidates: Candidates,
): FirstSuccessOfAsync<Candidates> => {
  const promise = Promise.try(async () => {
    let latestError: Result<unknown, unknown> | undefined = undefined

    for (const candidate of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const result = await candidate()

      if (result.isOk()) {
        return result
      }

      latestError = result
    }

    if (latestError === undefined) {
      throw createEmptyResultsCollectionError()
    }

    return latestError
  })

  return new ResultAsync(promise) as FirstSuccessOfAsync<Candidates>
}

interface StartedRaceTask<T, E> {
  readonly controller: AbortController
  readonly result: ResultAsync<T, E>
  readonly settled: Promise<{ readonly index: number; readonly result: Result<T, E> }>
}

const createRaceAbortReason = (): AbortError => new AbortError('ResultAsync race loser interrupted')

const startRaceTask = <T, E>(
  task: ResultAsyncRaceTask<T, E>,
  index: number,
): StartedRaceTask<T, E> => {
  const controller = new AbortController()
  const result = task(controller.signal)
  const settled = Promise.resolve(result).then((taskResult) => ({ index, result: taskResult }))

  return { controller, result, settled }
}

const createRaceHandle = <T, E>(task: StartedRaceTask<T, E>): ResultAsyncRaceHandle<T, E> => ({
  get signal() {
    return task.controller.signal
  },
  abort(reason = createRaceAbortReason()) {
    task.controller.abort(reason)
  },
  wait() {
    return task.result
  },
})

interface RaceSettlementState {
  settled: boolean
}

interface RaceSuccessState extends RaceSettlementState {
  completedCount: number
  completedIndexes: Set<number>
  latestError: Result<unknown, unknown> | undefined
}

interface RaceFirstObserverContext<Tasks extends readonly ResultAsyncRaceTask<unknown, unknown>[]> {
  readonly resolve: (
    result: Result<ResultAsyncRaceTasksOk<Tasks>, ResultAsyncRaceTasksErr<Tasks>>,
  ) => void
  readonly startedTasks: readonly StartedRaceTask<unknown, unknown>[]
  readonly state: RaceSettlementState
}

interface RaceSuccessObserverContext<
  Tasks extends readonly ResultAsyncRaceTask<unknown, unknown>[],
> {
  readonly resolve: (
    result: Result<ResultAsyncRaceTasksOk<Tasks>, ResultAsyncRaceTasksErr<Tasks>>,
  ) => void
  readonly startedTasks: readonly StartedRaceTask<unknown, unknown>[]
  readonly state: RaceSuccessState
}

type RaceTaskResolve<Tasks extends readonly ResultAsyncRaceTask<unknown, unknown>[]> = (
  result: Result<ResultAsyncRaceTasksOk<Tasks>, ResultAsyncRaceTasksErr<Tasks>>,
) => void

const observeRaceFirstTask = <Tasks extends readonly ResultAsyncRaceTask<unknown, unknown>[]>(
  task: StartedRaceTask<unknown, unknown>,
  context: RaceFirstObserverContext<Tasks>,
): void => {
  void task.settled.then(({ index, result }) => {
    if (context.state.settled) {
      return
    }

    context.state.settled = true
    const startedTasks = context.startedTasks

    for (const [loserIndex, loser] of startedTasks.entries()) {
      if (loserIndex !== index) {
        loser.controller.abort(createRaceAbortReason())
      }
    }

    context.resolve(result as Result<ResultAsyncRaceTasksOk<Tasks>, ResultAsyncRaceTasksErr<Tasks>>)
  })
}

const observeRaceSuccessTask = <Tasks extends readonly ResultAsyncRaceTask<unknown, unknown>[]>(
  task: StartedRaceTask<unknown, unknown>,
  context: RaceSuccessObserverContext<Tasks>,
): void => {
  void task.settled.then(({ index, result }) => {
    // Stryker disable next-line all: ignore late settlements after the race already resolved.
    if (context.state.settled) {
      return
    }

    context.state.completedIndexes.add(index)

    if (result.isOk()) {
      // Stryker disable next-line all: marks the race as resolved before aborting pending losers.
      context.state.settled = true
      const startedTasks = context.startedTasks

      for (const [loserIndex, loser] of startedTasks.entries()) {
        if (!context.state.completedIndexes.has(loserIndex)) {
          loser.controller.abort(createRaceAbortReason())
        }
      }

      context.resolve(
        result as Result<ResultAsyncRaceTasksOk<Tasks>, ResultAsyncRaceTasksErr<Tasks>>,
      )
      return
    }

    context.state.completedCount += 1
    context.state.latestError = result

    if (context.state.completedCount === context.startedTasks.length) {
      // Stryker disable next-line all: all tasks failed, so future late settlements must be ignored.
      context.state.settled = true
      context.resolve(
        context.state.latestError as Result<
          ResultAsyncRaceTasksOk<Tasks>,
          ResultAsyncRaceTasksErr<Tasks>
        >,
      )
    }
  })
}

const observeRaceResultAsyncTasks = <
  Tasks extends readonly ResultAsyncRaceTask<unknown, unknown>[],
  Context,
>(
  tasks: Tasks,
  createContext: (
    resolve: RaceTaskResolve<Tasks>,
    startedTasks: readonly StartedRaceTask<unknown, unknown>[],
  ) => Context,
  observeTask: (task: StartedRaceTask<unknown, unknown>, context: Context) => void,
): ResultAsync<ResultAsyncRaceTasksOk<Tasks>, ResultAsyncRaceTasksErr<Tasks>> => {
  const taskList = [...tasks]

  if (taskList.length === 0) {
    return new ResultAsync(
      Promise.resolve(Result.err(createEmptyResultsCollectionError())),
    ) as ResultAsync<ResultAsyncRaceTasksOk<Tasks>, ResultAsyncRaceTasksErr<Tasks>>
  }

  const promise = new Promise<
    Result<ResultAsyncRaceTasksOk<Tasks>, ResultAsyncRaceTasksErr<Tasks>>
  >((resolve) => {
    const startedTasks = taskList.map((task, index) => startRaceTask(task, index))
    const context = createContext(resolve, startedTasks)

    for (const task of startedTasks) {
      observeTask(task, context)
    }
  })

  return new ResultAsync(promise)
}

const raceResultAsyncTasks = <Tasks extends readonly ResultAsyncRaceTask<unknown, unknown>[]>(
  tasks: Tasks,
): ResultAsync<ResultAsyncRaceTasksOk<Tasks>, ResultAsyncRaceTasksErr<Tasks>> =>
  observeRaceResultAsyncTasks<Tasks, RaceSuccessObserverContext<Tasks>>(
    tasks,
    (resolve, startedTasks) => ({
      resolve,
      startedTasks,
      state: {
        completedCount: 0,
        completedIndexes: new Set<number>(),
        latestError: undefined,
        // Stryker disable next-line all: explicit false and missing value are equivalent before first settlement.
        settled: false,
      },
    }),
    observeRaceSuccessTask,
  )

const loopResultAsync = <State, R extends ResultAsync<unknown, unknown>>(
  initial: State,
  options: ResultAsyncLoopRuntimeOptions<State, R>,
): ResultAsyncLoopCollected<R> | ResultAsyncLoopDiscarded<R> => {
  const promise: Promise<Result<readonly InferAsyncOkTypes<R>[] | void, InferAsyncErrTypes<R>>> =
    Promise.try(async () => {
      let state = initial

      if (options.discard === true) {
        while (options.while(state)) {
          // eslint-disable-next-line no-await-in-loop
          const result = await options.body(state)

          if (result.isErr()) {
            return Result.err(result.error as InferAsyncErrTypes<R>)
          }

          state = options.step(state)
        }

        return Result.ok<void, InferAsyncErrTypes<R>>(undefined)
      }

      const values: InferAsyncOkTypes<R>[] = []

      while (options.while(state)) {
        // eslint-disable-next-line no-await-in-loop
        const result = await options.body(state)

        if (result.isErr()) {
          return Result.err(result.error as InferAsyncErrTypes<R>)
        }

        values.push(result.value as InferAsyncOkTypes<R>)
        state = options.step(state)
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
  if (options?.discard === true) {
    const promise: Promise<Result<void, InferAsyncErrTypes<R>>> = runConcurrentResultAsyncItems({
      concurrency: options.concurrency,
      finish: (state) => {
        if (state.activeCount > 0) {
          return undefined
        }

        const firstError = sortIndexedResultAsyncErrors(state.errors)[0]

        if (firstError !== undefined) {
          return Result.err<void, InferAsyncErrTypes<R>>(firstError.error)
        }

        return Result.ok<void, InferAsyncErrTypes<R>>(undefined)
      },
      items,
      onResult: (result, currentIndex, state) => {
        if (result.isErr()) {
          state.errors.push({ error: result.error, index: currentIndex })
          state.stopScheduling = true
        }
      },
      run: f as (
        value: Item,
        index: number,
      ) => ResultAsync<InferAsyncOkTypes<R>, InferAsyncErrTypes<R>>,
    })

    return new ResultAsync(promise) as ResultAsyncForEachDiscarded<R>
  }

  const promise: Promise<Result<readonly InferAsyncOkTypes<R>[] | void, InferAsyncErrTypes<R>>> =
    runConcurrentResultAsyncItems({
      concurrency: options?.concurrency,
      finish: (state) => {
        if (state.activeCount > 0) {
          return undefined
        }

        const firstError = sortIndexedResultAsyncErrors(state.errors)[0]

        if (firstError !== undefined) {
          return Result.err<readonly InferAsyncOkTypes<R>[] | void, InferAsyncErrTypes<R>>(
            firstError.error,
          )
        }

        return Result.ok<readonly InferAsyncOkTypes<R>[], InferAsyncErrTypes<R>>(state.values)
      },
      items,
      onResult: (result, currentIndex, state) => {
        if (result.isErr()) {
          state.errors.push({ error: result.error, index: currentIndex })
          state.stopScheduling = true
          return
        }

        state.values[currentIndex] = result.value
      },
      run: f as (
        value: Item,
        index: number,
      ) => ResultAsync<InferAsyncOkTypes<R>, InferAsyncErrTypes<R>>,
    })

  return new ResultAsync(promise) as ResultAsyncForEachCollected<R> | ResultAsyncForEachDiscarded<R>
}

const resolveResultAsyncBooleanCondition = (condition: ResultAsyncBooleanCondition): boolean =>
  typeof condition === 'function' ? condition() : condition

const toResultAsync = <R extends ResultAsyncConditional>(
  result: R,
): ResultAsync<HandlerOk<R>, HandlerErr<R>> => {
  // Stryker disable next-line all: preserve existing ResultAsync instead of wrapping it in another thenable.
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

const whenResultAsyncByPredicate = <
  Condition extends ResultAsyncCondition,
  R extends ResultAsyncConditional,
>(
  condition: Condition,
  body: R | (() => R),
  predicate: (condition: boolean) => boolean,
): ResultAsyncWhen<R, ResultAsyncConditionError<Condition>> => {
  const promise: Promise<
    Result<HandlerOk<R> | undefined, ResultAsyncConditionError<Condition> | HandlerErr<R>>
  > = Promise.try(async () => {
    const rawCondition: ResultAsyncCondition = condition
    const evaluatedCondition = typeof rawCondition === 'function' ? rawCondition() : rawCondition
    const conditionResult =
      typeof evaluatedCondition === 'boolean'
        ? Result.ok(evaluatedCondition)
        : await toResultAsync(evaluatedCondition)

    if (conditionResult.isErr()) {
      return Result.err(conditionResult.error as ResultAsyncConditionError<Condition>)
    }

    const conditionValue = conditionResult.value

    if (!predicate(conditionValue)) {
      return Result.ok<
        HandlerOk<R> | undefined,
        ResultAsyncConditionError<Condition> | HandlerErr<R>
      >(undefined)
    }

    const evaluatedBody = typeof body === 'function' ? body() : body
    return (await toResultAsync(evaluatedBody)) as Result<
      HandlerOk<R> | undefined,
      ResultAsyncConditionError<Condition> | HandlerErr<R>
    >
  })

  return new ResultAsync(promise) as ResultAsyncWhen<R, ResultAsyncConditionError<Condition>>
}

const callAsyncSideEffect = async (effect: () => unknown): Promise<void> => {
  try {
    const observed = effect()
    if (!isResultTask(observed)) await observed
  } catch {
    /* empty */
  }
}

/**
 * Represents an in-flight `Result<T, E>` (`PromiseLike<Result<T, E>>`) returned at execution
 * boundaries such as `ResultTask.runResult(task)` and `task.runResult()`.
 *
 * Compose new lazy workflows with `ResultTask`, then execute with `runResult()` to await a
 * `Result<T, E>` directly or apply fluent post-execution transformations (`map`, `mapErr`,
 * `andThen`, `orElse`, `match`, `matchTags`, `unwrapOr`, `unwrapOrThrow`, etc.).
 *
 * @template T - The type of the success value
 * @template E - The type of the error value
 *
 * @implements {PromiseLike<Result<T, E>>}
 *
 * @example
 * ```typescript
 * const result = await ResultTask.ok(21)
 *   .map((n) => n * 2)
 *   .runResult()
 *   .map((n) => n + 1)
 * ```
 */
export class ResultAsync<T, E = never> extends Pipeable implements PromiseLike<Result<T, E>> {
  /** Maps the success value directly or as a reusable operator for `pipe`. */
  public static map<Input, ErrorValue, Output>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    f: (value: Input) => Output | Promise<Output>,
  ): ResultAsync<Output, ErrorValue>
  public static map<Input, Output>(
    this: void,
    f: (value: Input) => Output | Promise<Output>,
  ): <ErrorValue>(self: ResultAsync<Input, ErrorValue>) => ResultAsync<Output, ErrorValue>
  public static map(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 2,
      <Input, ErrorValue, Output>(
        self: ResultAsync<Input, ErrorValue>,
        f: (value: Input) => Output | Promise<Output>,
      ) =>
        new ResultAsync<Output, ErrorValue>(
          (async () => {
            const result = await self
            return result.isOk()
              ? resultOk<Output, ErrorValue>(await f(result.value))
              : err<Output, ErrorValue>(result.error)
          })(),
        ),
    )(...args)
  }

  /** Maps the error value directly or as a reusable operator for `pipe`. */
  public static mapErr<Input, ErrorValue, ErrorOutput>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    f: (error: ErrorValue) => ErrorOutput | Promise<ErrorOutput>,
  ): ResultAsync<Input, ErrorOutput>
  public static mapErr<ErrorValue, ErrorOutput>(
    this: void,
    f: (error: ErrorValue) => ErrorOutput | Promise<ErrorOutput>,
  ): <Input>(self: ResultAsync<Input, ErrorValue>) => ResultAsync<Input, ErrorOutput>
  public static mapErr(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 2,
      (self: ResultAsync<unknown, unknown>, f: (error: unknown) => unknown) => self.mapErr(f),
    )(...args)
  }

  /** Chains a Result or ResultAsync directly or as a reusable operator for `pipe`. */
  public static andThen<
    Input,
    ErrorValue,
    Next extends Result<unknown, unknown> | ResultAsync<unknown, unknown>,
  >(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    f: (value: Input) => Next,
  ): ResultAsync<HandlerOk<Next>, ErrorValue | HandlerErr<Next>>
  public static andThen<
    Input,
    Next extends Result<unknown, unknown> | ResultAsync<unknown, unknown>,
  >(
    this: void,
    f: (value: Input) => Next,
  ): <ErrorValue>(
    self: ResultAsync<Input, ErrorValue>,
  ) => ResultAsync<HandlerOk<Next>, ErrorValue | HandlerErr<Next>>
  public static andThen(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 2,
      (
        self: ResultAsync<unknown, unknown>,
        f: (value: unknown) => Result<unknown, unknown> | ResultAsync<unknown, unknown>,
      ) => self.andThen(f),
    )(...args)
  }

  /** Recovers the error channel directly or as a reusable operator for `pipe`. */
  public static orElse<
    Input,
    ErrorValue,
    Next extends Result<unknown, unknown> | ResultAsync<unknown, unknown>,
  >(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    f: (error: ErrorValue) => Next,
  ): ResultAsync<Input | HandlerOk<Next>, HandlerErr<Next>>
  public static orElse<
    ErrorValue,
    Next extends Result<unknown, unknown> | ResultAsync<unknown, unknown>,
  >(
    this: void,
    f: (error: ErrorValue) => Next,
  ): <Input>(
    self: ResultAsync<Input, ErrorValue>,
  ) => ResultAsync<Input | HandlerOk<Next>, HandlerErr<Next>>
  public static orElse(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 2,
      (
        self: ResultAsync<unknown, unknown>,
        f: (error: unknown) => Result<unknown, unknown> | ResultAsync<unknown, unknown>,
      ) => self.orElse(f),
    )(...args)
  }

  /** Recovers the error channel with a plain or async success value directly or in `pipe`. */
  public static orElseSucceed<Input, ErrorValue, Output>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    f: (error: ErrorValue) => Output | Promise<Output>,
  ): ResultAsync<Input | Output, never>
  public static orElseSucceed<ErrorValue, Output>(
    this: void,
    f: (error: ErrorValue) => Output | Promise<Output>,
  ): <Input>(self: ResultAsync<Input, ErrorValue>) => ResultAsync<Input | Output, never>
  public static orElseSucceed(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 2,
      (self: ResultAsync<unknown, unknown>, f: (error: unknown) => unknown) =>
        self.orElseSucceed(f),
    )(...args)
  }

  /** Resolves to the Ok value or `defaultValue` when Err, directly or in `pipe`. */
  public static unwrapOr<Input, ErrorValue, Output>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    defaultValue: Output,
  ): ResultAsync<Input | Output, never>
  public static unwrapOr<Output>(
    this: void,
    defaultValue: Output,
  ): <Input, ErrorValue>(self: ResultAsync<Input, ErrorValue>) => ResultAsync<Input | Output, never>
  public static unwrapOr(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 2,
      (self: ResultAsync<unknown, unknown>, defaultValue: unknown) =>
        self.orElse(() => ResultAsync.ok(defaultValue)),
    )(...args)
  }

  /** Recovers from a specific tagged error directly or as a reusable operator for `pipe`. */
  public static catchTag<
    Input,
    ErrorValue,
    const Tag extends TagsOf<ErrorValue>,
    Next extends Result<unknown, unknown> | ResultAsync<unknown, unknown>,
  >(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    tag: Tag,
    f: (error: NoInfer<ErrorForTag<ErrorValue, Tag>>) => Next,
  ): ResultAsync<Input | HandlerOk<Next>, ExcludeTag<ErrorValue, Tag> | HandlerErr<Next>>
  public static catchTag<
    Input,
    ErrorValue,
    const Tag extends TagsOf<ErrorValue>,
    Next extends Result<unknown, unknown> | ResultAsync<unknown, unknown>,
  >(
    this: void,
    tag: Tag,
    f: (error: NoInfer<ErrorForTag<ErrorValue, Tag>>) => Next,
  ): (
    self: ResultAsync<Input, ErrorValue>,
  ) => ResultAsync<Input | HandlerOk<Next>, ExcludeTag<ErrorValue, Tag> | HandlerErr<Next>>
  public static catchTag<
    const Tag extends string,
    Handled extends { readonly _tag: Tag },
    Next extends Result<unknown, unknown> | ResultAsync<unknown, unknown>,
  >(
    this: void,
    tag: Tag,
    f: (error: Handled) => Next,
  ): <Input, ErrorValue>(
    self: ResultAsync<Input, ErrorValue> &
      (Tag extends TagsOf<ErrorValue>
        ? ErrorForTag<ErrorValue, Tag> extends Handled
          ? unknown
          : never
        : never),
  ) => ResultAsync<Input | HandlerOk<Next>, ExcludeTag<ErrorValue, Tag> | HandlerErr<Next>>
  public static catchTag(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 3,
      (
        self: ResultAsync<unknown, unknown>,
        tag: string,
        f: (error: never) => Result<unknown, unknown> | ResultAsync<unknown, unknown>,
      ) => self.catchTag(tag as never, f),
    )(...args)
  }

  /** Recovers from multiple tagged errors directly or as a reusable operator for `pipe`. */
  public static catchTags<Input, ErrorValue, const Handlers extends object>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    handlers: Handlers & CatchTagHandlers<ErrorValue, Handlers>,
  ): ResultAsync<
    Input | HandlerOk<CatchTagHandlerResult<Handlers>>,
    | ExcludeTag<ErrorValue, CoveredHandlerKeys<Handlers> & string>
    | HandlerErr<CatchTagHandlerResult<Handlers>>
  >
  public static catchTags<Input, ErrorValue, const Handlers extends object>(
    this: void,
    handlers: Handlers & CatchTagHandlers<ErrorValue, Handlers>,
  ): (
    self: ResultAsync<Input, ErrorValue>,
  ) => ResultAsync<
    Input | HandlerOk<CatchTagHandlerResult<Handlers>>,
    | ExcludeTag<ErrorValue, CoveredHandlerKeys<Handlers> & string>
    | HandlerErr<CatchTagHandlerResult<Handlers>>
  >
  public static catchTags<const Handlers extends object>(
    this: void,
    handlers: Handlers,
  ): <Input, ErrorValue>(
    self: ResultAsync<Input, ErrorValue> &
      (Handlers extends CatchTagHandlers<ErrorValue, Handlers> ? unknown : never),
  ) => ResultAsync<
    Input | HandlerOk<CatchTagHandlerResult<Handlers>>,
    | ExcludeTag<ErrorValue, CoveredHandlerKeys<Handlers> & string>
    | HandlerErr<CatchTagHandlerResult<Handlers>>
  >
  public static catchTags(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 2,
      (self: ResultAsync<unknown, unknown>, handlers: Record<string, never>) =>
        self.catchTags(handlers),
    )(...args)
  }

  /* eslint-disable max-params */
  /** Recovers from a nested tagged reason on a specific tagged error directly or in `pipe`. */
  public static catchReason<
    Input,
    ErrorValue,
    const ErrorTag extends TagsWithReasonOf<ErrorValue>,
    const ReasonTag extends ReasonTagsOf<ErrorValue, ErrorTag>,
    Next extends Result<unknown, unknown> | ResultAsync<unknown, unknown>,
  >(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    errorTag: ErrorTag,
    reasonTag: ReasonTag,
    f: (
      reason: NoInfer<ReasonForTag<ErrorValue, ErrorTag, ReasonTag>>,
      error: NoInfer<ErrorForTag<ErrorValue, ErrorTag>>,
    ) => Next,
  ): ResultAsync<
    Input | HandlerOk<Next>,
    ExcludeReasonTag<ErrorValue, ErrorTag, ReasonTag> | HandlerErr<Next>
  >
  public static catchReason<
    Input,
    ErrorValue,
    const ErrorTag extends TagsWithReasonOf<ErrorValue>,
    const ReasonTag extends ReasonTagsOf<ErrorValue, ErrorTag>,
    Next extends Result<unknown, unknown> | ResultAsync<unknown, unknown>,
  >(
    this: void,
    errorTag: ErrorTag,
    reasonTag: ReasonTag,
    f: (
      reason: NoInfer<ReasonForTag<ErrorValue, ErrorTag, ReasonTag>>,
      error: NoInfer<ErrorForTag<ErrorValue, ErrorTag>>,
    ) => Next,
  ): (
    self: ResultAsync<Input, ErrorValue>,
  ) => ResultAsync<
    Input | HandlerOk<Next>,
    ExcludeReasonTag<ErrorValue, ErrorTag, ReasonTag> | HandlerErr<Next>
  >
  public static catchReason<
    const ErrorTag extends string,
    const ReasonTag extends string,
    HandledReason extends { readonly _tag: ReasonTag },
    HandledError extends { readonly _tag: ErrorTag; readonly reason: unknown } = {
      readonly _tag: ErrorTag
      readonly reason: HandledReason
    },
    Next extends Result<unknown, unknown> | ResultAsync<unknown, unknown> =
      | Result<unknown, unknown>
      | ResultAsync<unknown, unknown>,
  >(
    this: void,
    errorTag: ErrorTag,
    reasonTag: ReasonTag,
    f: (reason: HandledReason, error: HandledError) => Next,
  ): <Input, ErrorValue>(
    self: ResultAsync<Input, ErrorValue> &
      (ErrorTag extends TagsWithReasonOf<ErrorValue>
        ? ReasonTag extends ReasonTagsOf<ErrorValue, ErrorTag>
          ? ReasonForTag<ErrorValue, ErrorTag, ReasonTag> extends HandledReason
            ? ErrorForTag<ErrorValue, ErrorTag> extends HandledError
              ? unknown
              : never
            : never
          : never
        : never),
  ) => ResultAsync<
    Input | HandlerOk<Next>,
    ExcludeReasonTag<ErrorValue, ErrorTag, ReasonTag> | HandlerErr<Next>
  >
  public static catchReason(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 4,
      (
        self: ResultAsync<unknown, unknown>,
        errorTag: string,
        reasonTag: string,
        f: (
          reason: never,
          error: never,
        ) => Result<unknown, unknown> | ResultAsync<unknown, unknown>,
      ) => self.catchReason(errorTag as never, reasonTag as never, f),
    )(...args)
  }
  /* eslint-enable max-params */

  /** Recovers from multiple nested tagged reasons on a specific tagged error directly or in `pipe`. */
  public static catchReasons<
    Input,
    ErrorValue,
    const ErrorTag extends TagsWithReasonOf<ErrorValue>,
    const Handlers extends object,
  >(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    errorTag: ErrorTag,
    handlers: Handlers & CatchReasonHandlers<ErrorValue, ErrorTag, Handlers>,
  ): ResultAsync<
    Input | HandlerOk<CatchReasonHandlerResult<Handlers>>,
    | ExcludeReasonTag<ErrorValue, ErrorTag, CoveredHandlerKeys<Handlers> & string>
    | HandlerErr<CatchReasonHandlerResult<Handlers>>
  >
  public static catchReasons<
    Input,
    ErrorValue,
    const ErrorTag extends TagsWithReasonOf<ErrorValue>,
    const Handlers extends object,
  >(
    this: void,
    errorTag: ErrorTag,
    handlers: Handlers & CatchReasonHandlers<ErrorValue, ErrorTag, Handlers>,
  ): (
    self: ResultAsync<Input, ErrorValue>,
  ) => ResultAsync<
    Input | HandlerOk<CatchReasonHandlerResult<Handlers>>,
    | ExcludeReasonTag<ErrorValue, ErrorTag, CoveredHandlerKeys<Handlers> & string>
    | HandlerErr<CatchReasonHandlerResult<Handlers>>
  >
  public static catchReasons<const ErrorTag extends string, const Handlers extends object>(
    this: void,
    errorTag: ErrorTag,
    handlers: Handlers,
  ): <Input, ErrorValue>(
    self: ResultAsync<Input, ErrorValue> &
      (ErrorTag extends TagsWithReasonOf<ErrorValue>
        ? Handlers extends CatchReasonHandlers<ErrorValue, ErrorTag, Handlers>
          ? unknown
          : never
        : never),
  ) => ResultAsync<
    Input | HandlerOk<CatchReasonHandlerResult<Handlers>>,
    | ExcludeReasonTag<ErrorValue, ErrorTag, CoveredHandlerKeys<Handlers> & string>
    | HandlerErr<CatchReasonHandlerResult<Handlers>>
  >
  public static catchReasons(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 3,
      (self: ResultAsync<unknown, unknown>, errorTag: string, handlers: Record<string, never>) =>
        self.catchReasons(errorTag as never, handlers),
    )(...args)
  }

  /** Moves the nested reason of a tagged error into the error channel directly or in `pipe`. */
  public static unwrapReason<
    Input,
    ErrorValue,
    const ErrorTag extends TagsWithReasonOf<ErrorValue>,
  >(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    errorTag: ErrorTag,
  ): ResultAsync<Input, ExcludeTag<ErrorValue, ErrorTag> | ReasonsOf<ErrorValue, ErrorTag>>
  public static unwrapReason<const ErrorTag extends string>(
    this: void,
    errorTag: ErrorTag,
  ): <Input, ErrorValue>(
    self: ResultAsync<Input, ErrorValue> &
      (ErrorTag extends TagsWithReasonOf<ErrorValue> ? unknown : never),
  ) => ResultAsync<Input, ExcludeTag<ErrorValue, ErrorTag> | ReasonsOf<ErrorValue, ErrorTag>>
  public static unwrapReason(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 2,
      (self: ResultAsync<unknown, unknown>, errorTag: string) =>
        self.unwrapReason(errorTag as never),
    )(...args)
  }

  /** Observes success, ignoring callback failures, directly or as an operator for `pipe`. */
  public static inspect<Input, ErrorValue>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    f: (value: Input) => unknown,
  ): ResultAsync<Input, ErrorValue>
  public static inspect<Input>(
    this: void,
    f: (value: Input) => unknown,
  ): <ErrorValue>(self: ResultAsync<Input, ErrorValue>) => ResultAsync<Input, ErrorValue>
  public static inspect(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 2,
      (self: ResultAsync<unknown, unknown>, f: (value: unknown) => unknown) => self.inspect(f),
    )(...args)
  }

  /** Observes failure, ignoring callback failures, directly or as an operator for `pipe`. */
  public static inspectError<Input, ErrorValue>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    f: (error: ErrorValue) => unknown,
  ): ResultAsync<Input, ErrorValue>
  public static inspectError<ErrorValue>(
    this: void,
    f: (error: ErrorValue) => unknown,
  ): <Input>(self: ResultAsync<Input, ErrorValue>) => ResultAsync<Input, ErrorValue>
  public static inspectError(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 2,
      (self: ResultAsync<unknown, unknown>, f: (error: unknown) => unknown) => self.inspectError(f),
    )(...args)
  }

  /** Observes both branches, ignoring callback failures, directly or as an operator for `pipe`. */
  public static inspectBoth<Input, ErrorValue>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    handlers: MatchHandlers<Input, ErrorValue, unknown, unknown>,
  ): ResultAsync<Input, ErrorValue>
  public static inspectBoth<Input, ErrorValue>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    onOk: (value: Input) => unknown,
    onErr: (error: ErrorValue) => unknown,
  ): ResultAsync<Input, ErrorValue>
  public static inspectBoth<Input, ErrorValue>(
    this: void,
    handlers: MatchHandlers<Input, ErrorValue, unknown, unknown>,
  ): (self: ResultAsync<Input, ErrorValue>) => ResultAsync<Input, ErrorValue>
  public static inspectBoth<Input, ErrorValue>(
    this: void,
    onOk: (value: Input) => unknown,
    onErr: (error: ErrorValue) => unknown,
  ): (self: ResultAsync<Input, ErrorValue>) => ResultAsync<Input, ErrorValue>
  public static inspectBoth(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input[0] instanceof ResultAsync,
      (
        self: ResultAsync<unknown, unknown>,
        handlers: MatchHandlers<unknown, unknown, unknown, unknown> | ((value: unknown) => unknown),
        onErr?: (error: unknown) => unknown,
      ) =>
        self.inspectBoth(
          handlers as (value: unknown) => unknown,
          onErr as (error: unknown) => unknown,
        ),
    )(...args)
  }

  /** Converts either variant to an eager success value, directly or in `pipe`. */
  public static match<Input, ErrorValue, Output, FailureOutput = Output>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    handlers: MatchHandlers<Input, ErrorValue, Output, FailureOutput>,
  ): ResultAsync<Awaited<Output | FailureOutput>, never>
  public static match<Input, ErrorValue, Output, FailureOutput = Output>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    onOk: (value: Input) => Output,
    onErr: (error: ErrorValue) => FailureOutput,
  ): ResultAsync<Awaited<Output | FailureOutput>, never>
  public static match<Input, ErrorValue, Output, FailureOutput = Output>(
    this: void,
    handlers: MatchHandlers<Input, ErrorValue, Output, FailureOutput>,
  ): (self: ResultAsync<Input, ErrorValue>) => ResultAsync<Awaited<Output | FailureOutput>, never>
  public static match<Input, ErrorValue, Output, FailureOutput = Output>(
    this: void,
    onOk: (value: Input) => Output,
    onErr: (error: ErrorValue) => FailureOutput,
  ): (self: ResultAsync<Input, ErrorValue>) => ResultAsync<Awaited<Output | FailureOutput>, never>
  public static match(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input[0] instanceof ResultAsync,
      (
        self: ResultAsync<unknown, unknown>,
        handlers: MatchHandlers<unknown, unknown, unknown> | ((value: unknown) => unknown),
        onErr?: (error: unknown) => unknown,
      ) =>
        new ResultAsync(
          self
            .match(handlers as (value: unknown) => unknown, onErr as (error: unknown) => unknown)
            .then((value) => resultOk(value)),
        ),
    )(...args)
  }

  /** Exhaustively matches tagged errors into an eager success value directly or in `pipe`. */
  public static matchTags<Input, ErrorValue, Output, const Handlers extends object>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    onOk: (value: Input) => Output,
    handlers: Handlers & MatchTagHandlers<ErrorValue, Handlers>,
  ): ResultAsync<Awaited<Output | MatchTagHandlerResult<Handlers>>, never>
  public static matchTags<Input, ErrorValue, Output, const Handlers extends object>(
    this: void,
    onOk: (value: Input) => Output,
    handlers: Handlers & MatchTagHandlers<ErrorValue, Handlers>,
  ): (
    self: ResultAsync<Input, ErrorValue>,
  ) => ResultAsync<Awaited<Output | MatchTagHandlerResult<Handlers>>, never>
  public static matchTags(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 3,
      (self: ResultAsync<unknown, unknown>, onOk: (value: unknown) => unknown, handlers: never) =>
        new ResultAsync(self.matchTags(onOk, handlers).then((value) => resultOk(value))),
    )(...args)
  }

  /* eslint-disable max-params */
  /** Partially matches tagged errors with a narrowed fallback into an eager success value directly or in `pipe`. */
  public static matchTagsPartial<
    Input,
    ErrorValue,
    Output,
    FallbackOutput,
    const Handlers extends object,
  >(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    onOk: (value: Input) => Output,
    handlers: Handlers & PartialMatchTagHandlers<ErrorValue, Handlers>,
    fallback: (error: RemainingMatchTagErrors<ErrorValue, Handlers>) => FallbackOutput,
  ): ResultAsync<Awaited<Output | MatchTagHandlerResult<Handlers> | FallbackOutput>, never>
  public static matchTagsPartial<
    Input,
    ErrorValue,
    Output,
    FallbackOutput,
    const Handlers extends object,
  >(
    this: void,
    onOk: (value: Input) => Output,
    handlers: Handlers & PartialMatchTagHandlers<ErrorValue, Handlers>,
    fallback: (error: RemainingMatchTagErrors<ErrorValue, Handlers>) => FallbackOutput,
  ): (
    self: ResultAsync<Input, ErrorValue>,
  ) => ResultAsync<Awaited<Output | MatchTagHandlerResult<Handlers> | FallbackOutput>, never>
  public static matchTagsPartial(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 4,
      (
        self: ResultAsync<unknown, unknown>,
        onOk: (value: unknown) => unknown,
        handlers: never,
        fallback: (error: unknown) => unknown,
      ) =>
        new ResultAsync(
          self.matchTagsPartial(onOk, handlers, fallback).then((value) => resultOk(value)),
        ),
    )(...args)
  }
  /* eslint-enable max-params */

  /** Replaces success with a constant directly or as a reusable operator for `pipe`. */
  public static as<Input, ErrorValue, Output>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    value: Output,
  ): ResultAsync<Output, ErrorValue>
  public static as<Output>(
    this: void,
    value: Output,
  ): <Input, ErrorValue>(self: ResultAsync<Input, ErrorValue>) => ResultAsync<Output, ErrorValue>
  public static as(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 2,
      (self: ResultAsync<unknown, unknown>, value: unknown) => self.as(value),
    )(...args)
  }

  /** Replaces success with `undefined` (`void`) directly or as a reusable operator for `pipe`. */
  public static asVoid<
    Args extends readonly [self: ResultAsync<unknown, unknown>] | readonly [] = readonly [],
  >(
    this: void,
    ...args: Args
  ): Args extends readonly [ResultAsync<unknown, infer ErrorValue>]
    ? ResultAsync<void, ErrorValue>
    : <Input, ErrorValue>(self: ResultAsync<Input, ErrorValue>) => ResultAsync<void, ErrorValue> {
    if (args.length === 0) {
      return ((self: ResultAsync<unknown, unknown>) => self.asVoid()) as never
    }
    return args[0].asVoid() as never
  }

  /** Validates or narrows success directly or as a reusable operator for `pipe`. */
  public static filterOrElse<Input, Narrowed extends Input, ErrorValue, Failure>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    predicate: (value: Input) => value is Narrowed,
    onFalse: (value: Input) => Failure | Promise<Failure>,
  ): ResultAsync<Narrowed, ErrorValue | Failure>
  public static filterOrElse<Input, ErrorValue, Failure>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    predicate: (value: Input) => boolean | Promise<boolean>,
    onFalse: (value: Input) => Failure | Promise<Failure>,
  ): ResultAsync<Input, ErrorValue | Failure>
  public static filterOrElse<Input, Narrowed extends Input, Failure>(
    this: void,
    predicate: (value: Input) => value is Narrowed,
    onFalse: (value: Input) => Failure | Promise<Failure>,
  ): <ErrorValue>(
    self: ResultAsync<Input, ErrorValue>,
  ) => ResultAsync<Narrowed, ErrorValue | Failure>
  public static filterOrElse<Input, Failure>(
    this: void,
    predicate: (value: Input) => boolean | Promise<boolean>,
    onFalse: (value: Input) => Failure | Promise<Failure>,
  ): <ErrorValue>(self: ResultAsync<Input, ErrorValue>) => ResultAsync<Input, ErrorValue | Failure>
  public static filterOrElse(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 3,
      (
        self: ResultAsync<unknown, unknown>,
        predicate: (value: unknown) => boolean | Promise<boolean>,
        onFalse: (value: unknown) => unknown,
      ) => self.filterOrElse(predicate, onFalse),
    )(...args)
  }

  /**
   * Returns a ResultAsync instance that is immediately resolved with a Result.ok(value).
   *
   * @param {T} value - The value to be wrapped in a Result.ok.
   * @return {ResultAsync<T, E>} A ResultAsync instance with the given value and error type E.
   */
  public static ok<T, E = never>(this: void, value: T): ResultAsync<T, E>
  /**
   * Returns a ResultAsync instance that is immediately resolved with a Result.ok(undefined).
   */
  public static ok<E = never>(this: void, value: void): ResultAsync<void, E>
  public static ok<T, E = never>(this: void, value: T): ResultAsync<T, E> {
    return ResultAsync.okAsync<T, E>(value)
  }

  /**
   * Returns a ResultAsync instance that is immediately resolved with a Result.ok(value).
   *
   * @param {T} value - The value to be wrapped in a Result.ok.
   * @return {ResultAsync<T, E>} A ResultAsync instance with the given value and error type E.
   */
  public static okAsync<T, E = never>(this: void, value: T): ResultAsync<T, E>
  /**
   * Returns a ResultAsync instance that is immediately resolved with a Result.ok(undefined).
   */
  public static okAsync<E = never>(this: void, value: void): ResultAsync<void, E>
  public static okAsync<T, E = never>(this: void, value: T): ResultAsync<T, E> {
    return new ResultAsync<T, E>(Promise.resolve(resultOk<T, E>(value)))
  }

  /**
   * Returns a ResultAsync that is immediately resolved with a Result.ok(undefined) value.
   *
   * @return {ResultAsync<undefined, E>} A ResultAsync instance with undefined as the value type and E as the error type.
   */
  public static unit<E = never>(this: void): ResultAsync<undefined, E> {
    return ResultAsync.unitAsync<E>()
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
  public static err<T = never, E = unknown>(this: void, err: E): ResultAsync<T, E>
  /**
   * Returns a ResultAsync instance that is immediately resolved with a Result.err(undefined).
   */
  public static err<T = never>(this: void, err: void): ResultAsync<T, void>
  public static err<T = never, E = unknown>(this: void, error: E): ResultAsync<T, E> {
    return ResultAsync.errAsync<T, E>(error)
  }

  /**
   * Returns a ResultAsync instance that is immediately resolved with a Result.err(error).
   *
   * @param {E} error - The error to be wrapped in a Result.err.
   * @return {ResultAsync<T, E>} A ResultAsync instance with the given error and value type T.
   */
  public static errAsync<T = never, E = unknown>(this: void, err: E): ResultAsync<T, E>
  /**
   * Returns a ResultAsync instance that is immediately resolved with a Result.err(undefined).
   */
  public static errAsync<T = never>(this: void, err: void): ResultAsync<T, void>
  public static errAsync<T = never, E = unknown>(this: void, error: E): ResultAsync<T, E> {
    return new ResultAsync<T, E>(Promise.resolve(err<T, E>(error)))
  }

  /**
   * Captures a promise or async factory into `ResultAsync<T, E>`.
   *
   * Supports `ResultAsync.try(promiseOrFn, catchFn)` and `ResultAsync.try({ try, catch })`.
   */
  public static readonly try: typeof tryResultAsync = tryResultAsync

  /**
   * Creates a ResultAsync from a Promise, catching any errors that occur during its execution.
   *
   * Compatibility alias. Prefer `ResultAsync.try` or `tryResultAsync` for in-flight boundaries,
   * or `ResultTask.tryPromise` for lazy workflows.
   *
   * @deprecated Use ResultAsync.try or tryResultAsync instead; this alias retains its existing behavior.
   * @param fn - The Promise or a function returning a Promise to be wrapped in a ResultAsync.
   * @param errorFn - Optional function to transform the caught error into a specific error type.
   *                  If not provided, the original error will be used.
   * @returns A ResultAsync that will resolve to Ok with the promise's value if successful,
   *          or Err with either the transformed error (if errorFn is provided) or the original error.
   */
  public static tryCatch<T>(
    this: void,
    fn: Promise<T> | (() => Promise<T>),
  ): ResultAsync<T, unknown>
  /**
   * Creates a ResultAsync from a Promise, catching any errors and mapping them with `errorFn`.
   *
   * @deprecated Use ResultAsync.try or tryResultAsync instead; this alias retains its existing behavior.
   */
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
      .then((value: T) => resultOk<T, unknown>(value))
      .catch((error: unknown) => {
        if (errorFn) {
          return err<T, unknown>(errorFn(error))
        }
        return err<T, unknown>(error)
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
  public static fromSafePromise<T, E = never>(
    this: void,
    promise: PromiseLike<T>,
  ): ResultAsync<T, E> {
    const newPromise = Promise.resolve(promise).then((value: T) => resultOk<T, E>(value))

    return new ResultAsync<T, E>(newPromise)
  }

  /**
   * Eagerly executes a ResultTask using the standard runtime and returns its in-flight ResultAsync.
   * Alias of `task.runResult()` / `ResultTask.runResult(task)`.
   *
   * @deprecated Since v4. Use task.runResult() or ResultTask.runResult(task) instead.
   */
  public static fromTask<T, E>(this: void, task: ResultTask<T, E, never>): ResultAsync<T, E> {
    return task.runResult()
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
    promise: PromiseLike<T>,
    errorFn: (e: unknown) => E,
  ): ResultAsync<T, E> {
    const newPromise = Promise.resolve(promise)
      .then((value: T) => resultOk<T, E>(value))
      .catch((error: unknown) => err<T, E>(errorFn(error)))

    return new ResultAsync<T, E>(newPromise)
  }

  /**
   * Adapts a callback or subscription API into a cancellable ResultAsync.
   *
   * The returned cleanup function runs once after resolve, reject, cancellation, or synchronous
   * subscription failure. Cleanup errors are ignored.
   * @deprecated Since v4. Use ResultTask.tryPromise or ResultTask.fromResultAsync for new workflows; keep this adapter for legacy callbacks.
   */
  public static fromCallback<T, E>(
    this: void,
    options: ResultAsyncFromCallbackOptions<T, E>,
  ): ResultAsync<T, E | AbortError> {
    return fromResultAsyncCallback(options)
  }

  /**
   * Combines many ResultAsync values and stops at the first Err.
   *
   * Arrays return an Ok array, records return an Ok record with the same keys, and iterables return
   * an Ok readonly array.
   * @deprecated Since v4. Use ResultTask.all for new workflows.
   */
  public static combine<
    T extends readonly [ResultAsync<unknown, unknown>, ...ResultAsync<unknown, unknown>[]],
  >(this: void, asyncResultList: T): CombineResultAsyncs<T>
  /**
   * Combines an array of ResultAsync values and stops at the first Err.
   *
   * @deprecated Since v4. Use ResultTask.all for new workflows.
   */
  public static combine<T extends readonly ResultAsync<unknown, unknown>[]>(
    this: void,
    asyncResultList: T,
  ): CombineResultAsyncs<T>
  /**
   * Combines a record of ResultAsync values and stops at the first Err.
   *
   * @deprecated Since v4. Use ResultTask.all for new workflows.
   */
  public static combine<T extends ResultAsyncRecord>(
    this: void,
    asyncResultRecord: T,
  ): CombineResultAsyncsRecord<T>
  /**
   * Combines an iterable of ResultAsync values and stops at the first Err.
   *
   * @deprecated Since v4. Use ResultTask.all for new workflows.
   */
  public static combine<R extends ResultAsync<unknown, unknown>>(
    this: void,
    asyncResults: Iterable<R>,
  ): CombineResultAsyncsIterable<R>
  public static combine<
    T extends
      | readonly ResultAsync<unknown, unknown>[]
      | ResultAsyncRecord
      | Iterable<ResultAsync<unknown, unknown>>,
  >(
    this: void,
    input: T,
  ):
    | CombineResultAsyncs<T & readonly ResultAsync<unknown, unknown>[]>
    | CombineResultAsyncsRecord<ResultAsyncRecord>
    | CombineResultAsyncsIterable<ResultAsync<unknown, unknown>> {
    // Stryker disable next-line all: array fast path avoids cloning arrays through the iterable branch.
    if (Array.isArray(input)) {
      return combineResultAsyncList(input) as CombineResultAsyncs<
        T & readonly ResultAsync<unknown, unknown>[]
      >
    }

    if (isIterable(input)) {
      return combineResultAsyncList([...input] as readonly ResultAsync<unknown, unknown>[]) as
        | CombineResultAsyncs<T & readonly ResultAsync<unknown, unknown>[]>
        | CombineResultAsyncsIterable<ResultAsync<unknown, unknown>>
    }

    return combineResultAsyncRecord(input)
  }

  /**
   * Combines many ResultAsync values and stops at the first Err, matching `ResultTask.all` and `Promise.all`.
   *
   * Arrays return an Ok array, records return an Ok record with the same keys, and iterables return
   * an Ok readonly array.
   * @deprecated Since v4. Use ResultTask.all for new workflows.
   */
  public static all<
    T extends readonly [ResultAsync<unknown, unknown>, ...ResultAsync<unknown, unknown>[]],
  >(this: void, asyncResultList: T): CombineResultAsyncs<T>
  /**
   * Combines an array of ResultAsync values and stops at the first Err.
   *
   * @deprecated Since v4. Use ResultTask.all for new workflows.
   */
  public static all<T extends readonly ResultAsync<unknown, unknown>[]>(
    this: void,
    asyncResultList: T,
  ): CombineResultAsyncs<T>
  /**
   * Combines a record of ResultAsync values and stops at the first Err.
   *
   * @deprecated Since v4. Use ResultTask.all for new workflows.
   */
  public static all<T extends ResultAsyncRecord>(
    this: void,
    asyncResultRecord: T,
  ): CombineResultAsyncsRecord<T>
  /**
   * Combines an iterable of ResultAsync values and stops at the first Err.
   *
   * @deprecated Since v4. Use ResultTask.all for new workflows.
   */
  public static all<R extends ResultAsync<unknown, unknown>>(
    this: void,
    asyncResults: Iterable<R>,
  ): CombineResultAsyncsIterable<R>
  public static all<
    T extends
      | readonly ResultAsync<unknown, unknown>[]
      | ResultAsyncRecord
      | Iterable<ResultAsync<unknown, unknown>>,
  >(
    this: void,
    input: T,
  ):
    | CombineResultAsyncs<T & readonly ResultAsync<unknown, unknown>[]>
    | CombineResultAsyncsRecord<ResultAsyncRecord>
    | CombineResultAsyncsIterable<ResultAsync<unknown, unknown>> {
    return ResultAsync.combine(
      input as readonly ResultAsync<unknown, unknown>[],
    ) as CombineResultAsyncs<T & readonly ResultAsync<unknown, unknown>[]>
  }

  /**
   * Combines many ResultAsync values and collects every Err instead of stopping at the first one.
   * @deprecated Since v4. Use ResultTask.validateAll for new workflows.
   */
  public static combineWithAllErrors<
    T extends readonly [ResultAsync<unknown, unknown>, ...ResultAsync<unknown, unknown>[]],
  >(this: void, asyncResultList: T): CombineResultsWithAllErrorsArrayAsync<T>
  /**
   * Combines an array of ResultAsync values and collects every Err.
   *
   * @deprecated Since v4. Use ResultTask.validateAll for new workflows.
   */
  public static combineWithAllErrors<T extends readonly ResultAsync<unknown, unknown>[]>(
    this: void,
    asyncResultList: T,
  ): CombineResultsWithAllErrorsArrayAsync<T>
  /**
   * Combines a record of ResultAsync values and collects every Err.
   *
   * @deprecated Since v4. Use ResultTask.validateAll for new workflows.
   */
  public static combineWithAllErrors<T extends ResultAsyncRecord>(
    this: void,
    asyncResultRecord: T,
  ): CombineResultAsyncsRecordWithAllErrors<T>
  /**
   * Combines an iterable of ResultAsync values and collects every Err.
   *
   * @deprecated Since v4. Use ResultTask.validateAll for new workflows.
   */
  public static combineWithAllErrors<R extends ResultAsync<unknown, unknown>>(
    this: void,
    asyncResults: Iterable<R>,
  ): CombineResultAsyncsIterableWithAllErrors<R>
  public static combineWithAllErrors<
    T extends
      | readonly ResultAsync<unknown, unknown>[]
      | ResultAsyncRecord
      | Iterable<ResultAsync<unknown, unknown>>,
  >(
    this: void,
    input: T,
  ):
    | CombineResultsWithAllErrorsArrayAsync<T & readonly ResultAsync<unknown, unknown>[]>
    | CombineResultAsyncsRecordWithAllErrors<ResultAsyncRecord>
    | CombineResultAsyncsIterableWithAllErrors<ResultAsync<unknown, unknown>> {
    // Stryker disable next-line all: array fast path avoids cloning arrays through the iterable branch.
    if (Array.isArray(input)) {
      return combineResultAsyncListWithAllErrors(input) as CombineResultsWithAllErrorsArrayAsync<
        T & readonly ResultAsync<unknown, unknown>[]
      >
    }

    if (isIterable(input)) {
      return combineResultAsyncListWithAllErrors([...input] as readonly ResultAsync<
        unknown,
        unknown
      >[]) as
        | CombineResultsWithAllErrorsArrayAsync<T & readonly ResultAsync<unknown, unknown>[]>
        | CombineResultAsyncsIterableWithAllErrors<ResultAsync<unknown, unknown>>
    }

    return combineResultAsyncRecordWithAllErrors(input)
  }

  /**
   * Validates many ResultAsync values and collects every Err.
   *
   * When passed items plus a mapper, the mapper must return a ResultAsync for each item. Use the
   * optional concurrency setting to bound parallel work.
   * @deprecated Since v4. Use ResultTask.validateAll for new workflows.
   */
  public static validateAll<
    T extends readonly [ResultAsync<unknown, unknown>, ...ResultAsync<unknown, unknown>[]],
  >(this: void, asyncResultList: T): CombineResultsWithAllErrorsArrayAsync<T>
  /**
   * Validates an array of ResultAsync values and collects every Err.
   *
   * @deprecated Since v4. Use ResultTask.validateAll for new workflows.
   */
  public static validateAll<T extends readonly ResultAsync<unknown, unknown>[]>(
    this: void,
    asyncResultList: T,
  ): CombineResultsWithAllErrorsArrayAsync<T>
  /**
   * Maps items to ResultAsync values and collects every Err.
   *
   * @deprecated Since v4. Use ResultTask.validateAll for new workflows.
   */
  public static validateAll<Item, R extends ResultAsync<unknown, unknown>>(
    this: void,
    items: Iterable<Item>,
    f: (value: Item, index: number) => R,
    options?: ResultAsyncValidateAllOptions,
  ): ResultAsyncValidatedAll<R>
  public static validateAll<
    T extends readonly ResultAsync<unknown, unknown>[],
    Item,
    R extends ResultAsync<unknown, unknown>,
  >(
    this: void,
    asyncResultListOrItems: T | Iterable<Item>,
    f?: (value: Item, index: number) => R,
    options?: ResultAsyncValidateAllOptions,
  ): CombineResultsWithAllErrorsArrayAsync<T> | ResultAsyncValidatedAll<R> {
    if (f === undefined) {
      return combineResultAsyncListWithAllErrors(
        asyncResultListOrItems as T,
      ) as CombineResultsWithAllErrorsArrayAsync<T>
    }

    return validateAllResultAsyncItems(asyncResultListOrItems as Iterable<Item>, f, options)
  }

  /**
   * Combines exactly two ResultAsync values into an Ok tuple or the first Err.
   * @deprecated Since v4. Use ResultTask.zip for new workflows.
   */
  public static zip<
    Left extends ResultAsync<unknown, unknown>,
    Right extends ResultAsync<unknown, unknown>,
  >(this: void, left: Left, right: Right): ResultAsyncZipped<Left, Right> {
    return combineResultAsyncList([left, right]) as ResultAsyncZipped<Left, Right>
  }

  /**
   * Retries a ResultAsync task according to a typed retry policy.
   *
   * The returned error channel includes the task error and `AbortError`.
   * @deprecated Since v4. Use ResultTask.retry for new workflows.
   */
  public static retry<Task extends ResultAsyncRetryCandidate>(
    this: void,
    task: Task,
    policy: RetryPolicy<NoInfer<ResultAsyncRetryTaskErr<Task>>> & {
      readonly signal?: ResultAsyncAbortSignal
    },
  ): ResultAsync<ResultAsyncRetryTaskOk<Task>, ResultAsyncRetryTaskErr<Task> | AbortError>
  /**
   * Retries a ResultAsync task according to retry options.
   *
   * @deprecated Since v4. Use ResultTask.retry for new workflows.
   */
  public static retry<Task extends ResultAsyncRetryTask<unknown, unknown>>(
    this: void,
    task: Task,
    options: ResultAsyncRetryOptions<ResultAsyncRetryTaskErr<Task>>,
  ): ResultAsync<ResultAsyncRetryTaskOk<Task>, ResultAsyncRetryTaskErr<Task> | AbortError>
  public static retry<T, E>(
    this: void,
    task: ResultAsyncRetryTask<T, E>,
    options: ResultAsyncRetryInput<E>,
  ): ResultAsync<T, E | AbortError> {
    return retryResultAsyncTask(task, options)
  }

  /**
   * Retries a ResultAsync task and falls back to another Resultar operation after retry exhaustion.
   * @deprecated Since v4. Compose task.retry(policy).orElse(fallback) (or ResultTask.retry and ResultTask.orElse) for new workflows.
   */
  public static retryOrElse<Task extends ResultAsyncRetryCandidate, U, F>(
    this: void,
    task: Task,
    policy: RetryPolicy<NoInfer<ResultAsyncRetryTaskErr<Task>>> & {
      readonly signal?: ResultAsyncAbortSignal
      readonly orElse: (
        error: NoInfer<ResultAsyncRetryTaskErr<Task>>,
        context: ResultAsyncRetryContext,
      ) => Result<U, F> | ResultAsync<U, F>
    },
  ): ResultAsync<ResultAsyncRetryTaskOk<Task> | U, F | AbortError>
  /**
   * Retries a ResultAsync task according to retry options and falls back to another operation after exhaustion.
   *
   * @deprecated Since v4. Compose task.retry(policy).orElse(fallback) (or ResultTask.retry and ResultTask.orElse) for new workflows.
   */
  public static retryOrElse<Task extends ResultAsyncRetryTask<unknown, unknown>, U, F>(
    this: void,
    task: Task,
    options: ResultAsyncRetryOrElseOptions<ResultAsyncRetryTaskErr<Task>, F, U>,
  ): ResultAsync<ResultAsyncRetryTaskOk<Task> | U, F | AbortError>
  public static retryOrElse<T, E, U, F>(
    this: void,
    task: ResultAsyncRetryTask<T, E>,
    options: ResultAsyncRetryOrElseInput<E, F, U>,
  ): ResultAsync<T | U, F | AbortError> {
    return retryOrElseResultAsyncTask(task, options)
  }

  /**
   * Acquires, uses, and releases a resource with cleanup on every path.
   *
   * Release errors are intentionally not part of the success/error channel; model cleanup failures
   * in `use` when they should affect control flow.
   * @deprecated Since v4. Use ResultTask.acquireRelease (or ResultTask.acquireDisposable) with ResultTask.scoped for new workflows.
   */
  public static withResource<Resource, AcquireError, T, UseError>(
    this: void,
    options: ResultAsyncWithResourceOptions<Resource, AcquireError, T, UseError>,
  ): ResultAsync<T, AcquireError | UseError | AbortError> {
    return withResultAsyncResource(options)
  }

  /**
   * Races two cooperative ResultAsync tasks and returns the first successful Ok.
   *
   * Earlier Err results do not finish the race. If both tasks fail, returns the last completed Err.
   * Pending losers are aborted without waiting for their settlement or cleanup.
   * @deprecated Since v4. Use ResultTask.race for new workflows.
   */
  public static race<
    Left extends ResultAsyncRaceTask<unknown, unknown>,
    Right extends ResultAsyncRaceTask<unknown, unknown>,
  >(
    this: void,
    left: Left,
    right: Right,
  ): ResultAsync<
    ResultAsyncRaceTaskOk<Left> | ResultAsyncRaceTaskOk<Right>,
    ResultAsyncRaceTaskErr<Left> | ResultAsyncRaceTaskErr<Right>
  > {
    return raceResultAsyncTasks([left, right] as const)
  }

  /**
   * Races multiple cooperative ResultAsync tasks and returns the first successful Ok.
   *
   * Earlier Err results do not finish the race. If every task fails, returns the last completed Err.
   * Pending losers are aborted without waiting for their settlement or cleanup.
   * @deprecated Since v4. Use ResultTask.race or ResultTask.firstSuccessOf for new workflows.
   */
  public static raceAll<
    Tasks extends readonly [
      ResultAsyncRaceTask<unknown, unknown>,
      ...ResultAsyncRaceTask<unknown, unknown>[],
    ],
  >(
    this: void,
    tasks: Tasks,
  ): ResultAsync<ResultAsyncRaceTasksOk<Tasks>, ResultAsyncRaceTasksErr<Tasks>> {
    return raceResultAsyncTasks(tasks)
  }

  /**
   * Races two cooperative ResultAsync tasks and returns the first settled Result, whether Ok or Err.
   *
   * Remaining tasks are aborted without waiting for their settlement or cleanup.
   * @deprecated Since v4. Use ResultTask.raceFirst for new workflows.
   */
  public static raceFirst<
    Left extends ResultAsyncRaceTask<unknown, unknown>,
    Right extends ResultAsyncRaceTask<unknown, unknown>,
  >(
    this: void,
    left: Left,
    right: Right,
  ): ResultAsync<
    ResultAsyncRaceTaskOk<Left> | ResultAsyncRaceTaskOk<Right>,
    ResultAsyncRaceTaskErr<Left> | ResultAsyncRaceTaskErr<Right>
  > {
    return observeRaceResultAsyncTasks<
      readonly [Left, Right],
      RaceFirstObserverContext<readonly [Left, Right]>
    >(
      [left, right] as const,
      // Stryker disable next-line all: explicit false and missing value are equivalent before first settlement.
      (resolve, startedTasks) => ({ resolve, startedTasks, state: { settled: false } }),
      observeRaceFirstTask,
    )
  }

  /**
   * Races two cooperative ResultAsync tasks and lets handlers decide what to do when either side
   * settles first.
   *
   * Handlers receive the settled Result and a handle to the still-running opposite task.
   * @deprecated Since v4. Use ResultTask.race, ResultTask.raceFirst, or ResultTask.forkChild for new workflows.
   */
  public static raceWith<
    Left extends ResultAsyncRaceTask<unknown, unknown>,
    Right extends ResultAsyncRaceTask<unknown, unknown>,
    OnLeftDone extends ResultAsyncConditional,
    OnRightDone extends ResultAsyncConditional,
  >(
    this: void,
    left: Left,
    right: Right,
    handlers: {
      readonly onLeftDone: (
        result: Result<ResultAsyncRaceTaskOk<Left>, ResultAsyncRaceTaskErr<Left>>,
        right: ResultAsyncRaceHandle<ResultAsyncRaceTaskOk<Right>, ResultAsyncRaceTaskErr<Right>>,
      ) => OnLeftDone
      readonly onRightDone: (
        result: Result<ResultAsyncRaceTaskOk<Right>, ResultAsyncRaceTaskErr<Right>>,
        left: ResultAsyncRaceHandle<ResultAsyncRaceTaskOk<Left>, ResultAsyncRaceTaskErr<Left>>,
      ) => OnRightDone
    },
  ): ResultAsync<
    HandlerOk<OnLeftDone> | HandlerOk<OnRightDone>,
    HandlerErr<OnLeftDone> | HandlerErr<OnRightDone>
  > {
    const promise = new Promise<
      Result<
        HandlerOk<OnLeftDone> | HandlerOk<OnRightDone>,
        HandlerErr<OnLeftDone> | HandlerErr<OnRightDone>
      >
    >((resolve) => {
      const leftTask = startRaceTask(left, 0)
      const rightTask = startRaceTask(right, 1)
      const leftHandle = createRaceHandle(leftTask) as ResultAsyncRaceHandle<
        ResultAsyncRaceTaskOk<Left>,
        ResultAsyncRaceTaskErr<Left>
      >
      const rightHandle = createRaceHandle(rightTask) as ResultAsyncRaceHandle<
        ResultAsyncRaceTaskOk<Right>,
        ResultAsyncRaceTaskErr<Right>
      >
      let settled = false

      void leftTask.settled.then(({ result }) => {
        if (settled) {
          return
        }

        settled = true
        const handled = handlers.onLeftDone(
          result as Result<ResultAsyncRaceTaskOk<Left>, ResultAsyncRaceTaskErr<Left>>,
          rightHandle,
        )

        void Promise.resolve(toResultAsync(handled)).then((handledResult) => {
          resolve(
            handledResult as Result<
              HandlerOk<OnLeftDone> | HandlerOk<OnRightDone>,
              HandlerErr<OnLeftDone> | HandlerErr<OnRightDone>
            >,
          )
        })
      })

      void rightTask.settled.then(({ result }) => {
        if (settled) {
          return
        }

        settled = true
        const handled = handlers.onRightDone(
          result as Result<ResultAsyncRaceTaskOk<Right>, ResultAsyncRaceTaskErr<Right>>,
          leftHandle,
        )

        void Promise.resolve(toResultAsync(handled)).then((handledResult) => {
          resolve(
            handledResult as Result<
              HandlerOk<OnLeftDone> | HandlerOk<OnRightDone>,
              HandlerErr<OnLeftDone> | HandlerErr<OnRightDone>
            >,
          )
        })
      })
    })

    return new ResultAsync(promise)
  }

  /**
   * Runs a cooperative ResultAsync task with a typed timeout error.
   * @deprecated Since v4. Use ResultTask.timeout for new workflows.
   */
  public static timeout<Task extends ResultAsyncRaceTask<unknown, unknown>, TimeoutError>(
    this: void,
    task: Task,
    options: ResultAsyncTimeoutOptions<TimeoutError>,
  ): ResultAsync<ResultAsyncRaceTaskOk<Task>, ResultAsyncRaceTaskErr<Task> | TimeoutError> {
    const timeoutTask = (signal: ResultAsyncAbortSignal): ResultAsync<never, TimeoutError> => {
      const promise = new Promise<Result<never, TimeoutError>>((resolve) => {
        const timeout = setTimeout(() => {
          resolve(Result.err(options.onTimeout()))
        }, options.timeoutMs)

        signal.addEventListener('abort', () => {
          clearTimeout(timeout)
        })
      })

      return new ResultAsync(promise)
    }

    return ResultAsync.raceWith(task, timeoutTask, {
      onLeftDone: (result, timeoutHandle) => {
        timeoutHandle.abort(createRaceAbortReason())
        return result
      },
      onRightDone: (result, taskHandle) => {
        taskHandle.abort((result as { readonly error: TimeoutError }).error)
        return result
      },
    })
  }

  /**
   * Runs async candidates until the first Ok and returns the last Err if every candidate fails.
   * @deprecated Since v4. Use ResultTask.firstSuccessOf for new workflows.
   */
  public static firstSuccessOf<Candidates extends Iterable<ResultAsyncCandidate>>(
    this: void,
    candidates: Candidates,
  ): FirstSuccessOfAsync<Candidates> {
    return firstSuccessOfAsyncCandidates(candidates)
  }

  /**
   * Chooses one of two Resultar async branches from a boolean or Resultar boolean condition.
   */
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

  /**
   * Runs `body` only when the condition resolves to `true`; otherwise returns `Ok(undefined)`.
   */
  public static when<Condition extends ResultAsyncCondition, R extends ResultAsyncConditional>(
    this: void,
    condition: Condition,
    body: R | (() => R),
  ): ResultAsyncWhen<R, ResultAsyncConditionError<Condition>>
  public static when<Condition extends ResultAsyncCondition>(
    this: void,
    condition: Condition,
  ): <R extends ResultAsyncConditional>(
    body: R | (() => R),
  ) => ResultAsyncWhen<R, ResultAsyncConditionError<Condition>>
  public static when<Condition extends ResultAsyncCondition, R extends ResultAsyncConditional>(
    this: void,
    condition: Condition,
    body?: R | (() => R),
  ):
    | ResultAsyncWhen<R, ResultAsyncConditionError<Condition>>
    | (<Body extends ResultAsyncConditional>(
        target: Body | (() => Body),
      ) => ResultAsyncWhen<Body, ResultAsyncConditionError<Condition>>) {
    if (body === undefined) {
      return <Body extends ResultAsyncConditional>(target: Body | (() => Body)) =>
        whenResultAsyncByPredicate(condition, target, (value) => value)
    }

    return whenResultAsyncByPredicate(condition, body, (value) => value)
  }

  /**
   * Runs `body` only when a Resultar boolean condition is Ok(true).
   */
  public static whenResult<
    Condition extends ResultAsyncConditionResult,
    R extends ResultAsyncConditional,
  >(
    this: void,
    condition: Condition,
    body: R | (() => R),
  ): ResultAsyncWhenWithCondition<Condition, R> {
    return whenResultAsyncByPredicate(condition, body, (value) => value)
  }

  /**
   * Runs `body` only when the condition resolves to `false`; otherwise returns `Ok(undefined)`.
   */
  public static unless<Condition extends ResultAsyncCondition, R extends ResultAsyncConditional>(
    this: void,
    condition: Condition,
    body: R | (() => R),
  ): ResultAsyncWhen<R, ResultAsyncConditionError<Condition>>
  public static unless<Condition extends ResultAsyncCondition>(
    this: void,
    condition: Condition,
  ): <R extends ResultAsyncConditional>(
    body: R | (() => R),
  ) => ResultAsyncWhen<R, ResultAsyncConditionError<Condition>>
  public static unless<Condition extends ResultAsyncCondition, R extends ResultAsyncConditional>(
    this: void,
    condition: Condition,
    body?: R | (() => R),
  ):
    | ResultAsyncWhen<R, ResultAsyncConditionError<Condition>>
    | (<Body extends ResultAsyncConditional>(
        target: Body | (() => Body),
      ) => ResultAsyncWhen<Body, ResultAsyncConditionError<Condition>>) {
    if (body === undefined) {
      return <Body extends ResultAsyncConditional>(target: Body | (() => Body)) =>
        whenResultAsyncByPredicate(condition, target, (value) => !value)
    }

    return whenResultAsyncByPredicate(condition, body, (value) => !value)
  }

  /**
   * Runs `body` only when a Resultar boolean condition is Ok(false).
   */
  public static unlessResult<
    Condition extends ResultAsyncConditionResult,
    R extends ResultAsyncConditional,
  >(
    this: void,
    condition: Condition,
    body: R | (() => R),
  ): ResultAsyncWhenWithCondition<Condition, R> {
    return whenResultAsyncByPredicate(condition, body, (value) => !value)
  }

  /**
   * Repeats a ResultAsync-producing body while a condition holds.
   *
   * Use `discard: true` when only failure matters and collected Ok values are not needed.
   * @deprecated Since v4. Use ResultTask.loop for new workflows.
   */
  public static loop<State, BodyState extends State, R extends ResultAsync<unknown, unknown>>(
    this: void,
    initial: State,
    options: ResultAsyncLoopOptions<State, BodyState, R>,
  ): ResultAsyncLoopCollected<R>
  /**
   * Repeats a ResultAsync-producing body while a boolean condition holds.
   *
   * @deprecated Since v4. Use ResultTask.loop for new workflows.
   */
  public static loop<State, R extends ResultAsync<unknown, unknown>>(
    this: void,
    initial: State,
    options: ResultAsyncLoopBooleanOptions<State, R>,
  ): ResultAsyncLoopCollected<R>
  /**
   * Repeats a ResultAsync-producing body while a condition holds and discards collected Ok values.
   *
   * @deprecated Since v4. Use ResultTask.loop for new workflows.
   */
  public static loop<State, BodyState extends State, R extends ResultAsync<unknown, unknown>>(
    this: void,
    initial: State,
    options: ResultAsyncLoopDiscardOptions<State, BodyState, R>,
  ): ResultAsyncLoopDiscarded<R>
  /**
   * Repeats a ResultAsync-producing body while a boolean condition holds and discards collected Ok values.
   *
   * @deprecated Since v4. Use ResultTask.loop for new workflows.
   */
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

  /**
   * Repeatedly transforms state with a ResultAsync-producing body until the condition fails.
   * @deprecated Since v4. Use ResultTask.iterate for new workflows.
   */
  public static iterate<
    State,
    BodyState extends WidenLiteral<State>,
    R extends ResultAsync<WidenLiteral<State>, unknown>,
  >(
    this: void,
    initial: State,
    options: ResultAsyncIterateOptions<WidenLiteral<State>, BodyState, R>,
  ): ResultAsyncIterated<WidenLiteral<State>, R>
  /**
   * Repeatedly transforms state with a ResultAsync-producing body while a boolean condition holds.
   *
   * @deprecated Since v4. Use ResultTask.iterate for new workflows.
   */
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

  /**
   * Runs a ResultAsync-producing mapper for each item.
   *
   * Use `discard: true` when only failure matters and collected Ok values are not needed. Use
   * `concurrency` to bound parallel work.
   * @deprecated Since v4. Use ResultTask.forEach for new workflows.
   */
  public static forEach<Item, R extends ResultAsync<unknown, unknown>>(
    this: void,
    items: Iterable<Item>,
    f: (value: Item, index: number) => R,
    options?: ResultAsyncForEachOptions,
  ): ResultAsyncForEachCollected<R>
  /**
   * Runs a ResultAsync-producing mapper for each item and discards collected Ok values.
   *
   * @deprecated Since v4. Use ResultTask.forEach for new workflows.
   */
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
   * Wraps an async function so every later call returns a ResultAsync.
   *
   * Prefer `ResultTask.tryPromise` when building new async workflows.
   * @deprecated Since v4. Build a function returning ResultTask.tryPromise for new workflows.
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
            return resultOk<T, E>(v)
          } catch (error) {
            const e = errorFn ? errorFn(error) : error
            return err<T, E>(e as E)
          }
        })(),
      )
  }

  private readonly innerPromise: Promise<Result<T, E>>

  /**
   * Creates a ResultAsync from a Promise that resolves to a Result.
   *
   * Most application code should obtain a `ResultAsync` from `task.runResult()` or
   * `ResultTask.runResult(task)`.
   */
  public constructor(res: Promise<Result<T, E>>) {
    super()
    this.innerPromise = res
  }

  /**
   * PromiseLike integration. Resolves to the underlying `Result<T, E>`.
   *
   * Prefer ResultAsync combinators for application flow; this exists so ResultAsync can be awaited
   * and used by Promise APIs.
   */
  public then<A = Result<T, E>, B = never>(
    successCallback?: ((res: Result<T, E>) => A | PromiseLike<A>) | null,
    failureCallback?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.innerPromise.then(successCallback, failureCallback)
  }

  /**
   * Maps the Err value while preserving the Ok value.
   */
  public mapErr<U>(f: (t: E) => U | Promise<U>): ResultAsync<T, U> {
    return new ResultAsync<T, U>(
      this.innerPromise.then(async (res) =>
        res.isOk() ? (res as unknown as Result<T, U>) : err<T, U>(await f(res.error)),
      ),
    )
  }

  /**
   * Maps the Ok value while preserving the error channel.
   */
  public map<X>(f: (t: T) => X | Promise<X>): ResultAsync<X, E> {
    return new ResultAsync<X, E>(
      this.innerPromise.then(async (res: Result<T, E>) =>
        res.isErr() ? (res as unknown as Result<X, E>) : resultOk<X, E>(await f(res.value)),
      ),
    )
  }

  /**
   * Replaces the Ok value with a constant while preserving the error channel.
   */
  public as<X>(value: X): ResultAsync<X, E> {
    return new ResultAsync<X, E>(this.innerPromise.then((res: Result<T, E>) => res.as(value)))
  }

  /**
   * Replaces the Ok value with `undefined` (`void`) while preserving the error channel.
   */
  public asVoid(): ResultAsync<void, E> {
    return this.as(undefined)
  }

  /**
   * Keeps the Ok value only when the predicate passes; otherwise returns an Err from `onFalse`.
   */
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
        if (res.isErr() || (await predicate(res.value))) {
          return res as Result<T, E | F>
        }

        return err<T, E | F>(await onFalse(res.value))
      }),
    )
  }

  /**
   * Chains another fallible sync or async operation from the Ok value.
   *
   * Use this instead of `map` when the callback returns `Result` or `ResultAsync`.
   */
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
        const next = res.andThen(f as (t: T) => Result<U, F>) as
          | Result<U, E | F>
          | ResultAsync<U, E | F>
        return next instanceof ResultAsync ? next.innerPromise : next
      }),
    )
  }

  /**
   * Branches from the Ok value into one of two async fallible Result branches.
   */
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
            this.innerPromise.then((res) => {
              if (res.isOk()) {
                return (fCondition(res.value) ? fTrue(res.value) : fFalse(res.value)).innerPromise
              }

              return res as unknown as Result<X1 | X2, Y1 | Y2 | E>
            }),
          ),
      }),
    }
  }

  /**
   * Keeps this ResultAsync only when `condition` resolves to `true`; otherwise returns `Ok(undefined)`.
   */
  public when<Condition extends ResultAsyncCondition>(
    condition: Condition,
  ): ResultAsync<T | undefined, E | ResultAsyncConditionError<Condition>> {
    return ResultAsync.when(condition, this as ResultAsync<T, E>)
  }

  /**
   * Keeps this ResultAsync only when `condition` resolves to `false`; otherwise returns `Ok(undefined)`.
   */
  public unless<Condition extends ResultAsyncCondition>(
    condition: Condition,
  ): ResultAsync<T | undefined, E | ResultAsyncConditionError<Condition>> {
    return ResultAsync.unless(condition, this as ResultAsync<T, E>)
  }

  /**
   * Recovers from Err with another Result or ResultAsync.
   */
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
        const next = res.orElse(f as (e: E) => Result<U, A>) as
          | Result<U | T, A>
          | ResultAsync<U | T, A>
        return next instanceof ResultAsync ? next.innerPromise : next
      }),
    )
  }

  /**
   * Recovers from Err with a plain or async success value.
   */
  public orElseSucceed<A>(f: (e: E) => A | Promise<A>): ResultAsync<T | A, never> {
    return new ResultAsync<T | A, never>(
      this.innerPromise.then(async (res) =>
        res.isErr() ? resultOk<T | A, never>(await f(res.error)) : (res as Result<T | A, never>),
      ),
    )
  }

  /**
   * Recovers from a specific tagged error by `_tag`.
   */
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
        const next = res.catchTag(tag, f as (error: ErrorForTag<E, Tag>) => Result<U, F>) as
          | Result<T | U, ExcludeTag<E, Tag> | F>
          | ResultAsync<T | U, ExcludeTag<E, Tag> | F>
        return next instanceof ResultAsync ? next.innerPromise : next
      }),
    )
  }

  /**
   * Recovers from multiple tagged errors by `_tag`.
   */
  public catchTags<const Handlers extends object>(
    handlers: Handlers & CatchTagHandlers<E, Handlers>,
  ): ResultAsync<
    T | HandlerOk<CatchTagHandlerResult<Handlers>>,
    | ExcludeTag<E, CoveredHandlerKeys<Handlers> & string>
    | HandlerErr<CatchTagHandlerResult<Handlers>>
  > {
    return new ResultAsync<
      T | HandlerOk<CatchTagHandlerResult<Handlers>>,
      | ExcludeTag<E, CoveredHandlerKeys<Handlers> & string>
      | HandlerErr<CatchTagHandlerResult<Handlers>>
    >(
      this.innerPromise.then((res) => {
        const next = res.catchTags(handlers as never) as
          | Result<
              T | HandlerOk<CatchTagHandlerResult<Handlers>>,
              | ExcludeTag<E, CoveredHandlerKeys<Handlers> & string>
              | HandlerErr<CatchTagHandlerResult<Handlers>>
            >
          | ResultAsync<
              T | HandlerOk<CatchTagHandlerResult<Handlers>>,
              | ExcludeTag<E, CoveredHandlerKeys<Handlers> & string>
              | HandlerErr<CatchTagHandlerResult<Handlers>>
            >
        return next instanceof ResultAsync ? next.innerPromise : next
      }),
    )
  }

  /**
   * Recovers from a nested tagged `reason` on a specific tagged error.
   */
  public catchReason<
    const ErrorTag extends TagsWithReasonOf<E>,
    const ReasonTag extends ReasonTagsOf<E, ErrorTag>,
    R extends Result<unknown, unknown>,
  >(
    errorTag: ErrorTag,
    reasonTag: ReasonTag,
    f: (reason: ReasonForTag<E, ErrorTag, ReasonTag>, error: ErrorForTag<E, ErrorTag>) => R,
  ): ResultAsync<T | InferOkTypes<R>, ExcludeReasonTag<E, ErrorTag, ReasonTag> | InferErrTypes<R>>
  public catchReason<
    const ErrorTag extends TagsWithReasonOf<E>,
    const ReasonTag extends ReasonTagsOf<E, ErrorTag>,
    R extends ResultAsync<unknown, unknown>,
  >(
    errorTag: ErrorTag,
    reasonTag: ReasonTag,
    f: (reason: ReasonForTag<E, ErrorTag, ReasonTag>, error: ErrorForTag<E, ErrorTag>) => R,
  ): ResultAsync<
    T | InferAsyncOkTypes<R>,
    ExcludeReasonTag<E, ErrorTag, ReasonTag> | InferAsyncErrTypes<R>
  >
  public catchReason<
    U,
    F,
    const ErrorTag extends TagsWithReasonOf<E>,
    const ReasonTag extends ReasonTagsOf<E, ErrorTag>,
  >(
    errorTag: ErrorTag,
    reasonTag: ReasonTag,
    f: (
      reason: ReasonForTag<E, ErrorTag, ReasonTag>,
      error: ErrorForTag<E, ErrorTag>,
    ) => Result<U, F> | ResultAsync<U, F>,
  ): ResultAsync<T | U, ExcludeReasonTag<E, ErrorTag, ReasonTag> | F>
  public catchReason<
    const ErrorTag extends TagsWithReasonOf<E>,
    const ReasonTag extends ReasonTagsOf<E, ErrorTag>,
    R extends Result<unknown, unknown> | ResultAsync<unknown, unknown>,
  >(
    errorTag: ErrorTag,
    reasonTag: ReasonTag,
    f: (reason: ReasonForTag<E, ErrorTag, ReasonTag>, error: ErrorForTag<E, ErrorTag>) => R,
  ): ResultAsync<T | HandlerOk<R>, ExcludeReasonTag<E, ErrorTag, ReasonTag> | HandlerErr<R>> {
    return new ResultAsync<
      T | HandlerOk<R>,
      ExcludeReasonTag<E, ErrorTag, ReasonTag> | HandlerErr<R>
    >(
      this.innerPromise.then((res) => {
        const next = res.catchReason(errorTag, reasonTag, f as never) as
          | Result<T | HandlerOk<R>, ExcludeReasonTag<E, ErrorTag, ReasonTag> | HandlerErr<R>>
          | ResultAsync<T | HandlerOk<R>, ExcludeReasonTag<E, ErrorTag, ReasonTag> | HandlerErr<R>>
        return next instanceof ResultAsync ? next.innerPromise : next
      }),
    )
  }

  /**
   * Recovers from multiple nested tagged `reason` variants on a specific tagged error.
   */
  public catchReasons<const ErrorTag extends TagsWithReasonOf<E>, const Handlers extends object>(
    errorTag: ErrorTag,
    handlers: Handlers & CatchReasonHandlers<E, ErrorTag, Handlers>,
  ): ResultAsync<
    T | HandlerOk<CatchReasonHandlerResult<Handlers>>,
    | ExcludeReasonTag<E, ErrorTag, CoveredHandlerKeys<Handlers> & string>
    | HandlerErr<CatchReasonHandlerResult<Handlers>>
  > {
    return new ResultAsync<
      T | HandlerOk<CatchReasonHandlerResult<Handlers>>,
      | ExcludeReasonTag<E, ErrorTag, CoveredHandlerKeys<Handlers> & string>
      | HandlerErr<CatchReasonHandlerResult<Handlers>>
    >(
      this.innerPromise.then((res) => {
        const next = res.catchReasons(errorTag, handlers as never) as
          | Result<
              T | HandlerOk<CatchReasonHandlerResult<Handlers>>,
              | ExcludeReasonTag<E, ErrorTag, CoveredHandlerKeys<Handlers> & string>
              | HandlerErr<CatchReasonHandlerResult<Handlers>>
            >
          | ResultAsync<
              T | HandlerOk<CatchReasonHandlerResult<Handlers>>,
              | ExcludeReasonTag<E, ErrorTag, CoveredHandlerKeys<Handlers> & string>
              | HandlerErr<CatchReasonHandlerResult<Handlers>>
            >
        return next instanceof ResultAsync ? next.innerPromise : next
      }),
    )
  }

  /**
   * Moves the nested `reason` of a tagged error into the ResultAsync error channel.
   */
  public unwrapReason<const ErrorTag extends TagsWithReasonOf<E>>(
    errorTag: ErrorTag,
  ): ResultAsync<T, ExcludeTag<E, ErrorTag> | ReasonsOf<E, ErrorTag>> {
    return new ResultAsync(this.innerPromise.then((res) => res.unwrapReason(errorTag)))
  }

  /**
   * Converts this ResultAsync into a Promise of a plain value by handling both Ok and Err.
   */
  public async match<A, B = A>(handlers: MatchHandlers<T, E, A, B>): Promise<Awaited<A | B>>
  public async match<A, B = A>(ok: (t: T) => A, fnErr: (e: E) => B): Promise<Awaited<A | B>>
  public async match<A, B = A>(
    input: MatchHandlers<T, E, A, B> | ((t: T) => A),
    fnErr?: (e: E) => B,
  ): Promise<Awaited<A | B>> {
    const result = await this.innerPromise
    return result.match(input as (t: T) => A, fnErr as (e: E) => B) as Awaited<A | B>
  }

  /** Converts this ResultAsync into a Promise with exhaustive tagged-error handlers. */
  public async matchTags<A, const Handlers extends object>(
    ok: (value: T) => A,
    handlers: Handlers & MatchTagHandlers<E, Handlers>,
  ): Promise<Awaited<A | MatchTagHandlerResult<Handlers>>> {
    const result = await this.innerPromise
    return result.matchTags(ok, handlers) as Awaited<A | MatchTagHandlerResult<Handlers>>
  }

  /** Converts this ResultAsync into a Promise with partial handlers and a fallback. */
  public async matchTagsPartial<A, B, const Handlers extends object>(
    ok: (value: T) => A,
    handlers: Handlers & PartialMatchTagHandlers<E, Handlers>,
    fallback: (error: E) => B,
  ): Promise<Awaited<A | MatchTagHandlerResult<Handlers> | B>> {
    const result = await this.innerPromise
    return result.matchTagsPartial(ok, handlers, fallback) as Awaited<
      A | MatchTagHandlerResult<Handlers> | B
    >
  }

  /**
   * Resolves to the Ok value, or `t` when this ResultAsync is Err.
   */
  public async unwrapOr<A>(t: A): Promise<T | A> {
    return this.innerPromise.then((res) => res.unwrapOr(t))
  }

  /**
   * Resolves to the Ok value or rejects with the Err value.
   *
   * Use this at final application boundaries after the error channel has been modeled.
   */
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
        await callAsyncSideEffect(res.isOk() ? () => f(res.value) : () => f(undefined, res.error))

        return res
      }),
    )
  }

  /**
   * Runs a side effect only for the `Ok` variant and preserves the original async result.
   *
   * Callback errors and rejected callback promises are intentionally ignored.
   * Use `map` or `andThen` when the callback should transform the value.
   */
  public inspect(f: (t: T) => unknown): ResultAsync<T, E> {
    return new ResultAsync(
      this.innerPromise.then(async (res) => {
        if (res.isOk()) {
          await callAsyncSideEffect(() => f(res.value))
        }

        return res
      }),
    )
  }

  /**
   * Runs a side effect only for the `Err` variant and preserves the original async result.
   *
   * Callback errors and rejected callback promises are intentionally ignored.
   * Use `mapErr` or `orElse` when the callback should transform the error.
   */
  public inspectError(f: (e: E) => unknown): ResultAsync<T, E> {
    return new ResultAsync(
      this.innerPromise.then(async (res) => {
        if (res.isErr()) {
          await callAsyncSideEffect(() => f(res.error))
        }

        return res
      }),
    )
  }

  /**
   * Runs a side effect for either variant and preserves the original async result.
   *
   * Callback errors and rejected callback promises are intentionally ignored.
   */
  public inspectBoth(handlers: MatchHandlers<T, E, unknown, unknown>): ResultAsync<T, E>
  public inspectBoth(onOk: (t: T) => unknown, onErr: (e: E) => unknown): ResultAsync<T, E>
  public inspectBoth(
    input: MatchHandlers<T, E, unknown, unknown> | ((t: T) => unknown),
    onErr?: (e: E) => unknown,
  ): ResultAsync<T, E> {
    if (typeof input === 'function' && typeof onErr !== 'function') {
      // Preserve the diagnostic from the original shared implementation.
      throw new TypeError('ResultTask.inspectBoth requires an error handler')
    }
    const fnOk = typeof input === 'function' ? input : input.ok
    const fnErr = getMatchErrorHandler(input, onErr)

    return new ResultAsync(
      this.innerPromise.then(async (res) => {
        await callAsyncSideEffect(res.isOk() ? () => fnOk(res.value) : () => fnErr(res.error))

        return res
      }),
    )
  }

  /** @deprecated Use inspect; the original best-effort behavior is preserved. */
  public tap(f: (value: T) => void | Promise<void>): ResultAsync<T, E> {
    return this.inspect(f)
  }

  /** @deprecated Use inspectError; the original best-effort behavior is preserved. */
  public tapError(f: (error: E) => void | Promise<void>): ResultAsync<T, E> {
    return this.inspectError(f)
  }

  /**
   * Attaches an async disposal finalizer to this ResultAsync.
   */
  public toAsyncDisposable(f: ResultAsyncFinalizer<T, E>): DisposableResultAsync<T, E> {
    return new DisposableResultAsync(this.innerPromise, f)
  }

  /**
   * Enables `yield* resultAsync` inside async `safeTry` generators.
   */
  public async *[Symbol.asyncIterator](): AsyncGenerator<Result<never, E>, T> {
    const result = await this.innerPromise

    if (result.isOk()) {
      return result.value
    }

    yield result as unknown as Result<never, E>

    return undefined as T
  }
}

registerResultAsyncFactory(
  (promise) => new ResultAsync(promise as Promise<Result<unknown, unknown>>),
)

/**
 * `ResultAsync` convention that restricts the error channel to real `Error` instances.
 */
export type StrictResultAsync<T, E extends Error = Error> = ResultAsync<T, E>

/**
 * Creates an Ok ResultAsync.
 */
export const okAsync: typeof ResultAsync.okAsync = ResultAsync.okAsync
/**
 * Creates an Err ResultAsync.
 */
export const errAsync: typeof ResultAsync.errAsync = ResultAsync.errAsync
/**
 * Adapts a callback or subscription API into a cancellable ResultAsync.
 * @deprecated Since v4. Use ResultTask for new workflows; keep this adapter for legacy callbacks.
 */
export const fromCallback: typeof ResultAsync.fromCallback = ResultAsync.fromCallback
/**
 * Converts an existing promise into a ResultAsync and maps rejection into a typed Err.
 */
export const fromPromise: typeof ResultAsync.fromPromise = ResultAsync.fromPromise
/**
 * Converts an existing promise that is expected not to reject into a ResultAsync.
 *
 * Use `fromPromise` or `tryResultAsync` when rejection should become a typed Err.
 */
export const fromSafePromise: typeof ResultAsync.fromSafePromise = ResultAsync.fromSafePromise
/**
 * Creates an Ok ResultAsync with `undefined`.
 */
export const unitAsync: typeof ResultAsync.unitAsync = ResultAsync.unitAsync
/**
 * Wraps an async function so every later call returns a ResultAsync.
 * @deprecated Since v4. Build a function returning ResultTask.tryPromise for new workflows.
 */
export const fromThrowableAsync: typeof ResultAsync.fromThrowable = ResultAsync.fromThrowable

/**
 * Captures a promise or async factory into `ResultAsync<T, E>`.
 *
 * Use `tryResultAsync` (or `ResultAsync.try`) at the edge of uncontrolled async code: network calls, file I/O,
 * third-party SDKs, JSON parsing promises, and framework APIs that can reject. The mapper receives
 * the rejected or thrown `unknown` cause and returns the typed error for the Resultar channel.
 *
 * Passing a factory is preferred when creating the promise can throw synchronously.
 *
 * @example
 * ```ts
 * const user = tryResultAsync(
 *   () => fetchUser(id),
 *   (cause) => new FetchUserError({ cause, id }),
 * )
 * ```
 */
export function tryResultAsync<T, E>(
  fn: Promise<T> | (() => Promise<T>),
  errorFn: (e: unknown) => E,
): ResultAsync<T, E>
/**
 * Captures an async boundary with named `try` and `catch` fields.
 *
 * This is equivalent to `tryResultAsync(() => ..., toError)`, but it reads better for reusable
 * infrastructure helpers where the label, task, and mapper live together.
 *
 * @example
 * ```ts
 * const startup = tryResultAsync({
 *   try: () => fastify.register(plugin),
 *   catch: (cause) => new StartupTaskError({ cause, label: "register plugin" }),
 * })
 * ```
 */
export function tryResultAsync<T, E>(
  options: TryResultAsyncOptions<T, E> & { readonly catch: (e: unknown) => E },
): ResultAsync<T, E>
/**
 * Captures a promise or async factory into `ResultAsync<T, unknown>`.
 *
 * Prefer the overload with a catch mapper in application code so the error channel stays documented.
 * This overload is useful while adapting unknown external failures or during migration.
 */
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

/**
 * Runs a `ResultAsync` at an application boundary and returns the success value.
 *
 * If the result is `Err`, this rejects with the error. Use it at final framework, CLI, test, or
 * bootstrap boundaries after the error channel has already been modeled with Resultar.
 * @deprecated Since v4. Use ResultTask.runPromise at new Task boundaries.
 */
export const runPromise = <T, E>(result: ResultAsync<T, E>): Promise<T> => result.unwrapOrThrow()

/** @deprecated Use ResultAsync.try or tryResultAsync; this alias retains its existing behavior. */
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
