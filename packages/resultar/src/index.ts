/**
 * Typed synchronous and asynchronous error workflows built around `Result<T, E>` and
 * `ResultAsync<T, E>`.
 *
 * @module
 */

export {
  DisposableResultAsync,
  errAsync,
  fromCallback,
  fromPromise,
  fromSafePromise,
  fromThrowableAsync,
  okAsync,
  ResultAsync,
  runPromise,
  // eslint-disable-next-line typescript/no-deprecated -- Keep the supported deprecated export.
  tryCatchAsync,
  tryResultAsync,
  unitAsync,
} from './task/result-async.js'

/** @deprecated Import `tryResultAsync` instead. */
// eslint-disable-next-line typescript/no-deprecated -- Keep the supported deprecated export.
export { tryCatchAsync as tryAsync } from './task/result-async.js'

export type {
  ResultAsyncAbortSignal,
  ResultAsyncCallbackCleanup,
  ResultAsyncCallbackContext,
  ResultAsyncConcurrency,
  ResultAsyncFromCallbackOptions,
  ResultAsyncRaceHandle,
  ResultAsyncRaceTask,
  ResultAsyncRetryContext,
  ResultAsyncRetryOptions,
  ResultAsyncRetryOrElseOptions,
  ResultAsyncRetryTask,
  ResultAsyncResourceAcquire,
  ResultAsyncResourceEffect,
  ResultAsyncResourceRelease,
  ResultAsyncResourceReleaseContext,
  ResultAsyncResourceUse,
  ResultAsyncTimeoutOptions,
  ResultAsyncWithResourceOptions,
  StrictResultAsync,
  TryResultAsyncOptions,
} from './task/result-async.js'
export {
  DisposableResult,
  err,
  fromThrowable,
  ok,
  Result,
  runSync,
  // eslint-disable-next-line typescript/no-deprecated -- Keep the supported deprecated export.
  safeTry,
  // eslint-disable-next-line typescript/no-deprecated -- Keep the supported deprecated export.
  tryCatch,
  tryResult,
  unit,
} from './result.js'

/** @deprecated Import the named `tryResult` export instead. */
// eslint-disable-next-line typescript/no-deprecated -- Keep the supported deprecated exports.
export { tryCatch as default, tryCatch as try } from './result.js'

export type {
  AsyncResultGenOptions,
  ErrResult,
  OkResult,
  ResultAsyncGenerator,
  ResultGenerator,
  ResultGenOptions,
  ResultOperations,
  SafeTryAsyncOptions,
  SafeTryOptions,
  StrictResult,
  TryResultOptions,
} from './result.js'
export { AbortError, isAbortError } from './core/abort-error.js'
export { Cause } from './task/cause.js'
export { Fiber } from './task/fiber.js'
export type { FiberHandle, FiberJoinOptions, FiberObserver } from './task/fiber.js'
export { Clock, VirtualClock } from './task/task-clock.js'
export type { TaskClock } from './task/task-clock.js'
export { Scheduler } from './task/task-scheduler.js'
export type { TaskScheduler } from './task/task-scheduler.js'
export { Retry } from './core/retry.js'
export type { RetryContext, RetryPolicy, RetryPolicyOptions } from './core/retry.js'
export { isRedacted, redact, revealRedacted } from './core/redacted.js'
export type { Redacted } from './core/redacted.js'
export {
  isResultTask,
  isServiceTag,
  MissingServiceError,
  ResultTask,
  ResultTaskCauseError,
  ResultTaskTypeId,
  ResultTaskYieldTypeId,
  Semaphore,
  serviceTag,
  ServiceTagTypeId,
} from './task/result-task.js'
export type {
  Exit,
  ResultTaskAcquireReleaseOptions,
  ResultTaskConcurrencyOptions,
  ResultTaskGenerator,
  ResultTaskIfBranches,
  ResultTaskIterateBooleanOptions,
  ResultTaskIterateOptions,
  ResultTaskLoopBooleanDiscardOptions,
  ResultTaskLoopBooleanOptions,
  ResultTaskLoopDiscardOptions,
  ResultTaskLoopOptions,
  ResultTaskMatchOptions,
  ResultTaskRunOptions,
  ResultTaskRetryOptions,
  ResultTaskScope,
  ResultTaskScopeOwner,
  ResultTaskServiceResolver,
  ResultTaskServices,
  ResultTaskTryOptions,
  ResultTaskTryPromiseOptions,
  ResultTaskYieldable,
  ResultTaskYieldOf,
  ResultTaskZipOptions,
  ServiceTag,
} from './task/result-task.js'
export {
  createTaggedError,
  findCause,
  isError,
  matchError,
  matchErrorPartial,
  taggedEnum,
} from './tagged/tagged-error.js'
export type {
  TaggedEnum,
  TaggedEnumFactory,
  TaggedErrorClass,
  TaggedErrorInstance,
  TaggedErrorOptions,
} from './tagged/tagged-error.js'

export { constant, flow, identity, pipe } from './core/function.js'
export { Match } from './match/match.js'
export type {
  MatchMatcher,
  MatchMissingCases,
  MatchOption,
  MatchPattern,
  MatchRefinement,
} from './match/match.js'
