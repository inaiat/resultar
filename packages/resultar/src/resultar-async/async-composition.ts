import { Result } from '../result/result.js'
import type { ResultAsyncAndThen, ResultAsyncMap } from './generator-types.js'

/**
 * Eagerly maps a synchronous Result through a Promise-returning callback.
 * @deprecated Since v4. Compose ResultTask.tryPromise with ResultTask.fromResult for new workflows.
 */
export const asyncMap: ResultAsyncMap = Result.asyncMap

/**
 * Eagerly continues a synchronous Result into the separate Async facade.
 * @deprecated Since v4. Compose ResultTask.fromResult with andThen for new workflows.
 */
export const asyncAndThen: ResultAsyncAndThen = Result.asyncAndThen
