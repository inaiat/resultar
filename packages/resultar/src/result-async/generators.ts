import { Result } from '../result/result.js'

/**
 * Evaluates a synchronous or asynchronous generator and returns the first yielded Err or wraps the
 * returned value in Ok(value).
 *
 * Inside the generator, use `yield* result` (or `yield* resultAsync` in async generators) to unwrap
 * Ok values and short-circuit on Err. The object form can map thrown or rejected setup errors into
 * the error channel.
 * @deprecated Use Result.gen for synchronous values or ResultTask.gen for new lazy workflows.
 */
export const gen: typeof Result.gen = Result.gen

/** @deprecated Use Result.fn or ResultTask.fn for new workflows. */
export const fn: typeof Result.fn = Result.fn

/** @deprecated Use Result.gen or ResultTask.gen with plain success returns; this helper retains its returned Result contract. */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- Re-export deprecated helper on the async subpath.
export { safeTry } from '../result/result.js'
