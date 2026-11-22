/**
 * Lazy `ResultTask<A, E, R>` runtime, structured concurrency, retry, virtual clocks, and observability.
 *
 * @module
 */

export { AbortError, isAbortError } from '../core/abort-error.js'
export { Retry } from '../core/retry.js'
export type { RetryContext, RetryPolicy, RetryPolicyOptions } from '../core/retry.js'
export { Cause } from '../task/cause.js'
export { Deferred } from '../task/deferred.js'
export { Fiber } from '../task/fiber.js'
export type { FiberHandle, FiberJoinOptions, FiberObserver } from '../task/fiber.js'
export { Queue } from '../task/queue.js'
export { Ref } from '../task/ref.js'
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
} from '../task/result-task.js'
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
} from '../task/result-task.js'
export { Clock, VirtualClock } from '../task/task-clock.js'
export type { TaskClock } from '../task/task-clock.js'
export { TaskLocal } from '../task/task-local.js'
export { Scheduler } from '../task/task-scheduler.js'
export type { TaskScheduler } from '../task/task-scheduler.js'
export { Tracer } from '../task/tracer.js'
export type {
  MemoryTracer,
  RecordedSpan,
  SpanAttributes,
  SpanAttributeValue,
  SpanTraceFrame,
  TaskSpan,
  TaskTracer,
  TaskTracerStartOptions,
} from '../task/tracer.js'
