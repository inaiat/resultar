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

import { AbortError } from './abort-error.js'
import { Pipeable } from './pipe.js'
import { registerResultAsyncFactory } from './result-async-adapter.js'
import {
  Result,
  createEmptyResultsCollectionError,
  err,
  getMatchErrorHandler,
  ok as resultOk,
} from './result.js'
import { isError } from './tagged-error.js'
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
  ResultAsyncCatchReasonHandlers as CatchReasonHandlers,
  ResultAsyncCatchTagHandlers as CatchTagHandlers,
  TagsOf,
  TagsWithReasonOf,
} from './tagged-types.js'

type ResultAsyncFinalizer<T, E> = (
  value: T | undefined,
  error: E | undefined,
) => void | Promise<void>

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
export interface ResultAsyncRetryContext {
  /**
   * Current attempt number, starting at 1.
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
type ResultAsyncRetryTaskOk<Task> = Task extends ResultAsyncRetryTask<infer T, unknown> ? T : never
type ResultAsyncRetryTaskErr<Task> = Task extends ResultAsyncRetryTask<unknown, infer E> ? E : never
type ResultAsyncRetryDelay = number | ((context: ResultAsyncRetryContext) => number)
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
  const entries = Object.entries(asyncResultRecord)
  const resultList = await Promise.all(entries.map((entry) => entry[1]))
  const resultRecord: Record<string, Result<unknown, unknown>> = {}

  for (const [index, [key]] of entries.entries()) {
    const result = resultList[index]

    // Stryker disable next-line all: Promise.all preserves one result for each Object.entries item.
    if (result !== undefined) {
      resultRecord[key] = result
    }
  }

  return resultRecord
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
  // Stryker disable next-line all: iterable functions are valid iterables, but normal collection tests cover object iterables.
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
        // Stryker disable next-line all: idempotent Promise rejection guard; repeated reject calls are ignored.
        if (!settled) {
          // Stryker disable next-line all: setting the guard prevents later state updates after rejection.
          settled = true
          reject(toResultAsyncRejectionError(error))
        }
      }

      const resolveOnce = (result: Result<Output, Failure>): void => {
        // Stryker disable next-line all: idempotent Promise resolution guard; repeated resolve calls are ignored.
        if (!settled) {
          // Stryker disable next-line all: setting the guard prevents later state updates after resolution.
          settled = true
          resolve(result)
        }
      }

      const finishIfDone = (): void => {
        const result = options.finish(state)

        if (result !== undefined) {
          resolveOnce(result)
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
        // Stryker disable next-line all: avoid rescheduling after rejectOnce/resolveOnce settled the traversal.
        if (settled) {
          return
        }

        if (state.stopScheduling) {
          finishIfDone()
          return
        }

        while (!state.iteratorDone && state.activeCount < concurrency) {
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
              finishIfDone()
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
    /* Cleanup is best-effort; use withResource when cleanup failures affect control flow. */
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

// Retry keeps branches inline to avoid helper calls in the retry loop.
// fallow-ignore-next-line complexity
const runResultAsyncRetryAttempts = async <T, E, U, F>(
  task: ResultAsyncRetryTask<T, E>,
  options: ResultAsyncRetryOptions<E>,
  recover: (error: E, context: ResultAsyncRetryContext) => Result<U, F> | ResultAsync<U, F>,
): Promise<Result<T | U, F | AbortError>> => {
  validateResultAsyncRetryTimes(options.times)
  validateResultAsyncRetryStaticDelay(options.delayMs)
  validateResultAsyncRetryStaticJittered(options.jittered)

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

    const context: ResultAsyncRetryContext = {
      attempt,
      nextAttempt: attempt + 1,
      retriesRemaining: Math.max(0, options.times - attempt),
    }

    const shouldRetry = options.while
    const canRetryError =
      shouldRetry === undefined
        ? true
        : // eslint-disable-next-line no-await-in-loop
          await shouldRetry(result.error, context)

    if (!canRetryError || attempt >= options.times) {
      const recovered = recover(result.error, context)
      return recovered instanceof ResultAsync ? recovered : recovered
    }

    const onRetry = options.onRetry

    // Stryker disable next-line all: skip a needless function call and await when no retry hook exists.
    if (onRetry !== undefined) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await onRetry(result.error, context)
      } catch {
        /* empty */
      }
    }

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
  options: ResultAsyncRetryOptions<E>,
): ResultAsync<T, E | AbortError> =>
  new ResultAsync(
    runResultAsyncRetryAttempts<T, E, never, E>(task, options, (error) => Result.err(error)),
  )

const retryOrElseResultAsyncTask = <T, E, U, F>(
  task: ResultAsyncRetryTask<T, E>,
  options: ResultAsyncRetryOrElseOptions<E, F, U>,
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

const getReason = (value: unknown): unknown => (value as { readonly reason?: unknown }).reason

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

    // Stryker disable next-line all: `<= length` only adds one guarded undefined iteration for noUncheckedIndexedAccess.
    for (let loserIndex = 0; loserIndex < startedTasks.length; loserIndex += 1) {
      const loser = startedTasks[loserIndex]

      // Stryker disable next-line all: loop bounds guarantee the task; guard satisfies noUncheckedIndexedAccess without tuple allocation.
      if (loser === undefined) {
        /* empty */
      } else if (loserIndex !== index) {
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

      // Stryker disable next-line all: `<= length` only adds one guarded undefined iteration for noUncheckedIndexedAccess.
      for (let loserIndex = 0; loserIndex < startedTasks.length; loserIndex += 1) {
        const loser = startedTasks[loserIndex]

        // Stryker disable next-line all: loop bounds guarantee the task; guard satisfies noUncheckedIndexedAccess without tuple allocation.
        if (loser === undefined) {
          /* empty */
        } else if (!context.state.completedIndexes.has(loserIndex)) {
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

  /**
   * Creates an async disposable wrapper around a ResultAsync promise.
   */
  public constructor(res: Promise<Result<T, E>>, finalizer: ResultAsyncFinalizer<T, E>) {
    this.innerPromise = res
    this.finalizer = finalizer as (value: unknown, error: unknown) => void | Promise<void>
  }

  /**
   * PromiseLike integration. Resolves to the wrapped Result.
   */
  public then<A, B>(
    successCallback?: (res: Result<T, E>) => A | PromiseLike<A>,
    failureCallback?: (reason: unknown) => B | PromiseLike<B>,
  ): PromiseLike<A | B> {
    return this.innerPromise.then(successCallback, failureCallback)
  }

  /**
   * Runs the finalizer once after the wrapped Result resolves.
   *
   * Finalizer exceptions and rejections are intentionally swallowed.
   */
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
 * - Creating ResultAsync instances (okAsync, errAsync, fromPromise, fromCallback)
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
    return new ResultAsync<T, E>(Promise.resolve(resultOk<T, E>(value)))
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
    return new ResultAsync<T, E>(Promise.resolve(err<T, E>(error)))
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
  public static fromSafePromise<T, E = never>(this: void, promise: Promise<T>): ResultAsync<T, E> {
    const newPromise = promise.then((value: T) => resultOk<T, E>(value))

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
      .then((value: T) => resultOk<T, E>(value))
      .catch((error: unknown) => err<T, E>(errorFn(error)))

    return new ResultAsync<T, E>(newPromise)
  }

  /**
   * Adapts a callback or subscription API into a cancellable ResultAsync.
   *
   * The returned cleanup function runs once after resolve, reject, cancellation, or synchronous
   * subscription failure. Cleanup errors are ignored.
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
   */
  public static combine<
    T extends readonly [ResultAsync<unknown, unknown>, ...ResultAsync<unknown, unknown>[]],
  >(this: void, asyncResultList: T): CombineResultAsyncs<T>
  public static combine<T extends readonly ResultAsync<unknown, unknown>[]>(
    this: void,
    asyncResultList: T,
  ): CombineResultAsyncs<T>
  public static combine<T extends ResultAsyncRecord>(
    this: void,
    asyncResultRecord: T,
  ): CombineResultAsyncsRecord<T>
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
   * Combines many ResultAsync values and collects every Err instead of stopping at the first one.
   */
  public static combineWithAllErrors<
    T extends readonly [ResultAsync<unknown, unknown>, ...ResultAsync<unknown, unknown>[]],
  >(this: void, asyncResultList: T): CombineResultsWithAllErrorsArrayAsync<T>
  public static combineWithAllErrors<T extends readonly ResultAsync<unknown, unknown>[]>(
    this: void,
    asyncResultList: T,
  ): CombineResultsWithAllErrorsArrayAsync<T>
  public static combineWithAllErrors<T extends ResultAsyncRecord>(
    this: void,
    asyncResultRecord: T,
  ): CombineResultAsyncsRecordWithAllErrors<T>
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
   */
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
   */
  public static retry<Task extends ResultAsyncRetryTask<unknown, unknown>>(
    this: void,
    task: Task,
    options: ResultAsyncRetryOptions<ResultAsyncRetryTaskErr<Task>>,
  ): ResultAsync<ResultAsyncRetryTaskOk<Task>, ResultAsyncRetryTaskErr<Task> | AbortError> {
    return retryResultAsyncTask(
      task as ResultAsyncRetryTask<ResultAsyncRetryTaskOk<Task>, ResultAsyncRetryTaskErr<Task>>,
      options,
    )
  }

  /**
   * Retries a ResultAsync task and falls back to another Resultar operation after retry exhaustion.
   */
  public static retryOrElse<Task extends ResultAsyncRetryTask<unknown, unknown>, U, F>(
    this: void,
    task: Task,
    options: ResultAsyncRetryOrElseOptions<ResultAsyncRetryTaskErr<Task>, F, U>,
  ): ResultAsync<ResultAsyncRetryTaskOk<Task> | U, F | AbortError> {
    return retryOrElseResultAsyncTask(
      task as ResultAsyncRetryTask<ResultAsyncRetryTaskOk<Task>, ResultAsyncRetryTaskErr<Task>>,
      options,
    )
  }

  /**
   * Acquires, uses, and releases a resource with cleanup on every path.
   *
   * Release errors are intentionally not part of the success/error channel; model cleanup failures
   * in `use` when they should affect control flow.
   */
  public static withResource<Resource, AcquireError, T, UseError>(
    this: void,
    options: ResultAsyncWithResourceOptions<Resource, AcquireError, T, UseError>,
  ): ResultAsync<T, AcquireError | UseError | AbortError> {
    return withResultAsyncResource(options)
  }

  /**
   * Races two cooperative ResultAsync tasks and returns the first settled Result.
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
   * Races multiple cooperative ResultAsync tasks and returns the first settled Result.
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
   * Races two cooperative ResultAsync tasks and returns the first successful Ok.
   *
   * If both fail, the returned error is the final observed Err.
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
        // Stryker disable next-line all: timeoutTask has Ok type never and only resolves Err.
        if (result.isErr()) {
          taskHandle.abort(result.error)
        }

        return result
      },
    })
  }

  /**
   * Runs async candidates until the first Ok and returns the last Err if every candidate fails.
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
   * Runs `body` only when the condition is true; otherwise returns Ok(undefined).
   */
  public static when<R extends ResultAsyncConditional>(
    this: void,
    condition: ResultAsyncBooleanCondition,
    body: () => R,
  ): ResultAsyncWhen<R> {
    return whenResultAsync(condition, body)
  }

  /**
   * Runs `body` only when a Resultar boolean condition is Ok(true).
   */
  public static whenResult<
    Condition extends ResultAsyncConditionResult,
    R extends ResultAsyncConditional,
  >(this: void, condition: Condition, body: () => R): ResultAsyncWhenWithCondition<Condition, R> {
    return whenResultAsyncWithCondition(condition, body)
  }

  /**
   * Runs `body` only when the condition is false; otherwise returns Ok(undefined).
   */
  public static unless<R extends ResultAsyncConditional>(
    this: void,
    condition: ResultAsyncBooleanCondition,
    body: () => R,
  ): ResultAsyncWhen<R> {
    return unlessResultAsync(condition, body)
  }

  /**
   * Runs `body` only when a Resultar boolean condition is Ok(false).
   */
  public static unlessResult<
    Condition extends ResultAsyncConditionResult,
    R extends ResultAsyncConditional,
  >(this: void, condition: Condition, body: () => R): ResultAsyncWhenWithCondition<Condition, R> {
    return unlessResultAsyncWithCondition(condition, body)
  }

  /**
   * Repeats a ResultAsync-producing body while a condition holds.
   *
   * Use `discard: true` when only failure matters and collected Ok values are not needed.
   */
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

  /**
   * Repeatedly transforms state with a ResultAsync-producing body until the condition fails.
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
   */
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
   * Wraps an async function so every later call returns a ResultAsync.
   *
   * Prefer `tryResultAsync` when you want to run the operation immediately.
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
   * Most application code should prefer `tryResultAsync`, `fromPromise`, `okAsync`, or `errAsync`.
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
  public then<A, B>(
    successCallback?: (res: Result<T, E>) => A | PromiseLike<A>,
    failureCallback?: (reason: unknown) => B | PromiseLike<B>,
  ): PromiseLike<A | B> {
    return this.innerPromise.then(successCallback, failureCallback)
  }

  /**
   * Maps the Err value while preserving the Ok value.
   */
  public mapErr<U>(f: (t: E) => U | Promise<U>): ResultAsync<T, U> {
    return new ResultAsync<T, U>(
      this.innerPromise.then(async (res) => {
        if (res.isOk()) {
          return resultOk<T, U>(res.value)
        }

        return err<T, U>(await f(res.error))
      }),
    )
  }

  /**
   * Maps the Ok value while preserving the error channel.
   */
  public map<X>(f: (t: T) => X | Promise<X>): ResultAsync<X, E> {
    return new ResultAsync<X, E>(
      this.innerPromise.then(async (res: Result<T, E>) => {
        if (res.isErr()) {
          return err<X, E>(res.error)
        }

        return resultOk<X, E>(await f(res.value))
      }),
    )
  }

  /**
   * Replaces the Ok value with a constant while preserving the error channel.
   */
  public as<X>(value: X): ResultAsync<X, E> {
    return new ResultAsync<X, E>(
      this.innerPromise.then((res: Result<T, E>) => {
        if (res.isErr()) {
          return err<X, E>(res.error)
        }

        return resultOk<X, E>(value)
      }),
    )
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
        if (res.isErr()) {
          return err<T, E | F>(res.error)
        }

        if (await predicate(res.value)) {
          return resultOk<T, E | F>(res.value)
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
        if (res.isErr()) {
          return err<U, E | F>(res.error)
        }

        const next = f(res.value)
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
        if (res.isErr()) {
          const next = f(res.error)
          return next instanceof ResultAsync ? next.innerPromise : next
        }

        return resultOk<U | T, A>(res.value)
      }),
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

  /**
   * Recovers from multiple tagged errors by `_tag`.
   */
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

        if (isTaggedHandlerMatch(handled)) {
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
        if (res.isOk()) {
          return Result.ok(res.value)
        }

        if (hasTag(res.error, errorTag)) {
          const reason = getReason(res.error)

          if (hasTag(reason, reasonTag)) {
            const next = f(
              reason as ReasonForTag<E, ErrorTag, ReasonTag>,
              res.error as ErrorForTag<E, ErrorTag>,
            )
            return next instanceof ResultAsync ? next.innerPromise : next
          }
        }

        return Result.err(res.error as ExcludeReasonTag<E, ErrorTag, ReasonTag>)
      }) as Promise<
        Result<T | HandlerOk<R>, ExcludeReasonTag<E, ErrorTag, ReasonTag> | HandlerErr<R>>
      >,
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
    | ExcludeReasonTag<E, ErrorTag, keyof Handlers & string>
    | HandlerErr<CatchReasonHandlerResult<Handlers>>
  > {
    return new ResultAsync<
      T | HandlerOk<CatchReasonHandlerResult<Handlers>>,
      | ExcludeReasonTag<E, ErrorTag, keyof Handlers & string>
      | HandlerErr<CatchReasonHandlerResult<Handlers>>
    >(
      this.innerPromise.then((res) => {
        if (res.isOk()) {
          return Result.ok(res.value)
        }

        if (hasTag(res.error, errorTag)) {
          const reason = getReason(res.error)

          if (typeof reason === 'object' && reason !== null && '_tag' in reason) {
            const handler = (handlers as Record<string, unknown>)[
              (reason as { readonly _tag: string })._tag
            ]

            if (handler !== undefined) {
              const next = (
                handler as (
                  reason: unknown,
                  error: unknown,
                ) => Result<unknown, unknown> | ResultAsync<unknown, unknown>
              )(reason, res.error)
              return next instanceof ResultAsync ? next.innerPromise : next
            }
          }
        }

        return Result.err(res.error as ExcludeReasonTag<E, ErrorTag, keyof Handlers & string>)
      }) as Promise<
        Result<
          T | HandlerOk<CatchReasonHandlerResult<Handlers>>,
          | ExcludeReasonTag<E, ErrorTag, keyof Handlers & string>
          | HandlerErr<CatchReasonHandlerResult<Handlers>>
        >
      >,
    )
  }

  /**
   * Moves the nested `reason` of a tagged error into the ResultAsync error channel.
   */
  public unwrapReason<const ErrorTag extends TagsWithReasonOf<E>>(
    errorTag: ErrorTag,
  ): ResultAsync<T, ExcludeTag<E, ErrorTag> | ReasonsOf<E, ErrorTag>> {
    return new ResultAsync(
      this.innerPromise.then((res) => {
        if (res.isOk()) {
          return Result.ok(res.value)
        }

        if (hasTag(res.error, errorTag)) {
          return Result.err(getReason(res.error) as ReasonsOf<E, ErrorTag>)
        }

        return Result.err(res.error as ExcludeTag<E, ErrorTag>)
      }),
    )
  }

  /**
   * Converts this ResultAsync into a Promise of a plain value by handling both Ok and Err.
   */
  public async match<A, B = A>(handlers: MatchHandlers<T, E, A, B>): Promise<A | B>
  public async match<A, B = A>(ok: (t: T) => A, fnErr: (e: E) => B): Promise<A | B>
  public async match<A, B = A>(
    input: MatchHandlers<T, E, A, B> | ((t: T) => A),
    fnErr?: (e: E) => B,
  ): Promise<A | B> {
    return this.innerPromise.then((res) =>
      // Stryker disable next-line all: positional match avoids allocating a handlers object.
      typeof input === 'function'
        ? res.match(input, getMatchErrorHandler(input, fnErr))
        : res.match(input),
    )
  }

  /**
   * Converts this ResultAsync into a Promise of a plain value with exhaustive tagged-error handlers.
   */
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

  /**
   * Converts this ResultAsync into a Promise of a plain value with partial tagged-error handlers and
   * a fallback.
   */
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

    yield err(result.error)

    return undefined as T
  }
}

registerResultAsyncFactory(
  (promise) => new ResultAsync(promise as Promise<Result<unknown, unknown>>),
)

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
 */
export const fromThrowableAsync: typeof ResultAsync.fromThrowable = ResultAsync.fromThrowable

/**
 * Captures a promise or async factory into `ResultAsync<T, E>`.
 *
 * Use `tryResultAsync` at the edge of uncontrolled async code: network calls, file I/O,
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
 */
export const runPromise = <T, E>(result: ResultAsync<T, E>): Promise<T> => result.unwrapOrThrow()

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
