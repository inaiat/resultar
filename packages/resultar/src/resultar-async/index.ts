/**
 * Deprecated eager asynchronous compatibility at the resultar/async subpath.
 * Prefer ResultTask from resultar for new asynchronous workflows.
 * @module
 */
export * from './result-async.js'
export { DisposableResultAsync } from './disposable-result-async.js'
export type { ResultAsyncFinalizer } from './disposable-result-async.js'
export type {
  ExtractErrAsyncTypes,
  ExtractOkAsyncTypes,
  InferAsyncErrTypes,
  InferAsyncOkTypes,
} from './async-types.js'
export type {
  AsyncResultGenOptions,
  ResultAsyncAndThen,
  ResultAsyncGenerator,
  ResultAsyncMap,
  ResultGenerator,
  ResultGenOptions,
  SafeTryAsyncOptions,
  SafeTryOptions,
} from './generator-types.js'
export { asyncAndThen, asyncMap } from './async-composition.js'
export { fn, gen, safeTry } from './generators.js'
/** @deprecated Import tryResultAsync instead. */
export { tryCatchAsync as tryAsync } from './result-async.js'
