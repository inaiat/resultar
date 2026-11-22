/**
 * Opt-in eager `ResultAsync<T, E>` compatibility layer (`PromiseLike<Result<T, E>>`).
 *
 * Maintained strictly for backwards compatibility and incremental v4 → v5 migration.
 * Prefer `ResultTask<T, E, R>` from `resultar` (or `resultar/task`) for all new asynchronous workflows.
 *
 * @deprecated Compatibility-only subpath in v5.x, slated for removal in a future major release. Migrate new asynchronous workflows to `ResultTask` from `resultar`.
 * @module
 */

export { DisposableResultAsync } from '../result-async/disposable-result-async.js'
export {
  asyncAndThen,
  asyncMap,
  errAsync,
  fromCallback,
  fromPromise,
  fromSafePromise,
  fromThrowableAsync,
  okAsync,
  ResultAsync,
  runPromise,
  safeTry,
  tryCatchAsync as tryAsync,
  tryCatchAsync,
  tryResultAsync,
  unitAsync,
} from '../result-async/result-async.js'
export type {
  AsyncResultGenOptions,
  ResultAsyncGenerator,
  SafeTryAsyncOptions,
  SafeTryOptions,
} from '../result-async/generator-types.js'
export type {
  ResultAsyncAbortSignal,
  ResultAsyncCallbackCleanup,
  ResultAsyncCallbackContext,
  ResultAsyncConcurrency,
  ResultAsyncFromCallbackOptions,
  ResultAsyncRaceHandle,
  ResultAsyncRaceTask,
  ResultAsyncResourceAcquire,
  ResultAsyncResourceEffect,
  ResultAsyncResourceRelease,
  ResultAsyncResourceReleaseContext,
  ResultAsyncResourceUse,
  ResultAsyncRetryContext,
  ResultAsyncRetryOptions,
  ResultAsyncRetryOrElseOptions,
  ResultAsyncRetryTask,
  ResultAsyncTimeoutOptions,
  ResultAsyncWithResourceOptions,
  StrictResultAsync,
  TryResultAsyncOptions,
} from '../result-async/result-async.js'
