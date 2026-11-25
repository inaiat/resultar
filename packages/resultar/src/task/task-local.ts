import { success } from './exit.js'
import { ResultTask } from './result-task.js'
import { isResultTask } from './task-helpers.js'
import { createRuntimeTask, runRuntimeTask } from './task-runtime-bridge.js'
import { withLocals } from './task-service.js'
import type { ResultTaskRuntimeContext } from './task-service.js'

/**
 * Fiber-local contextual value automatically inherited by child fibers (`forkChild`, `all`, `race`)
 * and isolated across sibling fibers and `locally` scopes.
 *
 * Unlike `ServiceTag` (which tracks compile-time dependency requirements `R`), `TaskLocal` carries
 * implicit ambient context (such as correlation IDs, tenant IDs, or log bindings) with a default
 * value and zero runtime overhead when unused.
 *
 * @example
 * ```ts
 * import { ResultTask, TaskLocal } from 'resultar'
 *
 * const RequestId = TaskLocal.make<string>('none')
 *
 * const readId = RequestId.get()
 * const scoped = RequestId.locally('req-42', readId)
 * // scoped.runSync() -> Ok('req-42')
 * // readId.runSync() -> Ok('none')
 * ```
 */
export interface TaskLocal<A> {
  /** Fallback value returned when this local has not been bound in the current fiber. */
  readonly defaultValue: A
  /** Lazily reads this local's current value for the executing fiber. */
  readonly get: () => ResultTask<A>
  /** Lazily updates this local's value for the remainder of the current fiber (or `locally` scope). */
  readonly set: (value: A) => ResultTask<void>
  /** Lazily transforms this local's current value using `fn`. */
  readonly update: (fn: (current: A) => A) => ResultTask<void>
  /**
   * Runs `task` with this local bound to `value`, restoring the previous value once `task` settles.
   * Supports both data-first (`local.locally(value, task)`) and curried (`local.locally(value)(task)`).
   */
  readonly locally: {
    <B, E, R>(value: A, task: ResultTask<B, E, R>): ResultTask<B, E, R>
    (value: A): <B, E, R>(task: ResultTask<B, E, R>) => ResultTask<B, E, R>
  }
  /**
   * Runs `task` with this local transformed by `fn`, restoring the previous value once `task` settles.
   * Supports both data-first and curried forms.
   */
  readonly locallyWith: {
    <B, E, R>(fn: (current: A) => A, task: ResultTask<B, E, R>): ResultTask<B, E, R>
    (fn: (current: A) => A): <B, E, R>(task: ResultTask<B, E, R>) => ResultTask<B, E, R>
  }
}

const readLocal = <A>(context: ResultTaskRuntimeContext, key: symbol, fallback: A): A => {
  const map = context.locals?.map
  if (map === undefined || !map.has(key)) return fallback
  return map.get(key) as A
}

const make = <A>(defaultValue: A, name?: string): TaskLocal<A> => {
  const key = Symbol(name ?? 'TaskLocal')

  const runLocally = <B, E, R>(
    computeValue: (current: A) => A,
    task: ResultTask<B, E, R>,
  ): ResultTask<B, E, R> =>
    createRuntimeTask<B, E, R>(ResultTask, (context) => {
      const current = readLocal(context, key, defaultValue)
      const entries: [symbol, unknown][] =
        context.locals?.map === undefined ? [] : [...context.locals.map.entries()]
      entries.push([key, computeValue(current)])
      return runRuntimeTask(ResultTask, task, withLocals(context, { map: new Map(entries) }))
    })

  const locally = ((...args: readonly unknown[]): unknown => {
    const value = args[0] as A
    if (args.length === 1) {
      return <B, E, R>(task: ResultTask<B, E, R>) => {
        if (!isResultTask(task)) {
          throw new TypeError('TaskLocal.locally requires a ResultTask')
        }
        return runLocally(() => value, task)
      }
    }
    const task = args[1]
    if (!isResultTask(task)) {
      throw new TypeError('TaskLocal.locally requires a ResultTask')
    }
    return runLocally(() => value, task)
  }) as TaskLocal<A>['locally']

  const locallyWith = ((...args: readonly unknown[]): unknown => {
    const fn = args[0] as (current: A) => A
    if (args.length === 1) {
      return <B, E, R>(task: ResultTask<B, E, R>) => {
        if (!isResultTask(task)) {
          throw new TypeError('TaskLocal.locallyWith requires a ResultTask')
        }
        return runLocally(fn, task)
      }
    }
    const task = args[1]
    if (!isResultTask(task)) {
      throw new TypeError('TaskLocal.locallyWith requires a ResultTask')
    }
    return runLocally(fn, task)
  }) as TaskLocal<A>['locallyWith']

  return {
    defaultValue,
    get: () =>
      createRuntimeTask<A>(ResultTask, (context) => success(readLocal(context, key, defaultValue))),
    set: (value) =>
      createRuntimeTask<void>(ResultTask, (context) => {
        if (context.locals !== undefined) {
          context.locals.map ??= new Map()
          context.locals.map.set(key, value)
        }
        return success(undefined)
      }),
    update: (fn) =>
      createRuntimeTask<void>(ResultTask, (context) => {
        if (context.locals !== undefined) {
          const next = fn(readLocal(context, key, defaultValue))
          context.locals.map ??= new Map()
          context.locals.map.set(key, next)
        }
        return success(undefined)
      }),
    locally,
    locallyWith,
  }
}

/**
 * Factory namespace for constructing fiber-inherited {@link TaskLocal} ambient context variables.
 *
 * @example
 * ```ts
 * import { ResultTask, TaskLocal } from 'resultar'
 *
 * const TenantId = TaskLocal.make<string | undefined>(undefined, 'TenantId')
 * const work = TenantId.locally('acme', TenantId.get())
 * // work.runSync() -> Ok('acme')
 * ```
 */
export const TaskLocal: {
  /** Creates a new {@link TaskLocal} with the given `defaultValue` and optional debug `name`. */
  readonly make: <A>(defaultValue: A, name?: string) => TaskLocal<A>
} = Object.freeze({ make })
