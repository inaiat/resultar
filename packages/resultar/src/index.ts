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
  tryCatchAsync,
  tryResultAsync,
  unitAsync,
} from './result-async.js'

/** Compatibility alias for `tryResultAsync`. */
export { tryResultAsync as tryAsync } from './result-async.js'

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
} from './result-async.js'
export {
  DisposableResult,
  err,
  fromThrowable,
  ok,
  Result,
  runSync,
  safeTry,
  tryCatch,
  tryResult,
  unit,
} from './result.js'

/** Default compatibility export for `tryResult`. */
export { tryResult as default } from './result.js'

/** Compatibility alias for `tryResult`. */
export { tryResult as try } from './result.js'

export type {
  ErrResult,
  OkResult,
  ResultOperations,
  SafeTryAsyncOptions,
  SafeTryOptions,
  StrictResult,
  TryResultOptions,
} from './result.js'
export { AbortError, isAbortError } from './abort-error.js'
export { isRedacted, redact, revealRedacted } from './redacted.js'
export type { Redacted } from './redacted.js'
export { ResultTask } from './result-task.js'
export type {
  Cause,
  Exit,
  ResultTaskRunOptions,
  ResultTaskServices,
  ResultTaskTryOptions,
  ResultTaskTryPromiseOptions,
  ServiceTag,
} from './result-task.js'
export {
  createTaggedError,
  findCause,
  isError,
  matchError,
  matchErrorPartial,
  taggedEnum,
} from './tagged-error.js'
export type {
  TaggedEnum,
  TaggedEnumFactory,
  TaggedErrorClass,
  TaggedErrorInstance,
  TaggedErrorOptions,
} from './tagged-error.js'
