/**
 * Synchronous `Result<T, E>` primitives and constructors without async/task runtime code.
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
} from '../result/result.js'
export type {
  ErrResult,
  OkResult,
  ResultGenerator,
  ResultGenOptions,
  ResultOperations,
  StrictResult,
  TryResultOptions,
} from '../result/result.js'
