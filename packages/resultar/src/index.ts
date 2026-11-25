/**
 * Typed error workflows built around synchronous `Result<T, E>` and lazy `ResultTask<T, E, R>`.
 *
 * @module
 */

export {
  DisposableResult,
  err,
  fromThrowable,
  ok,
  Result,
  runSync,
  tryResult,
  unit,
} from './result/result.js'
export type {
  ErrResult,
  OkResult,
  ResultGenerator,
  ResultGenOptions,
  ResultOperations,
  StrictResult,
  TryResultOptions,
} from './result/result.js'
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
export { Deferred } from './task/deferred.js'
export { Queue } from './task/queue.js'
export { Ref } from './task/ref.js'
export { TaskLocal } from './task/task-local.js'
export { Tracer } from './task/tracer.js'
export type {
  MemoryTracer,
  RecordedSpan,
  SpanAttributes,
  SpanAttributeValue,
  SpanTraceFrame,
  TaskSpan,
  TaskTracer,
  TaskTracerStartOptions,
} from './task/tracer.js'
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
  ResultTaskCallbackContext,
  ResultTaskConcurrencyOptions,
  ResultTaskFromCallbackOptions,
  ResultTaskGenerator,
  ResultTaskIfBranches,
  ResultTaskIterateBooleanOptions,
  ResultTaskIterateOptions,
  ResultTaskLoopBooleanDiscardOptions,
  ResultTaskLoopBooleanOptions,
  ResultTaskLoopDiscardOptions,
  ResultTaskLoopOptions,
  ResultTaskMatchOptions,
  ResultTaskRepeatInput,
  ResultTaskRepeatOptions,
  ResultTaskRunOptions,
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
  StrictResultTask,
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
