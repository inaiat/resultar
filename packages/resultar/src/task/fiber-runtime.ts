import type { Fiber, FiberHandle, FiberJoinOptions, FiberObserver } from './fiber.js'
import type { Exit, ResultTask } from './result-task.js'
import { TaskScope } from './scope.js'
import { combineExits, died, failure, interruptSuccess, success } from './exit.js'
import { transformCause, withoutInterruptions } from './cause-transform.js'
import { detachedPromise } from './promise-interruption.js'
import { isCleanupCause } from './cleanup-cause.js'

/** Supplies task execution without importing ResultTask at runtime. */
export interface FiberTaskContext {
  readonly signal: AbortSignal
  readonly join: (fiber: Fiber<unknown, unknown>) => Promise<Exit<unknown, unknown>>
}

export type FiberTaskFactory = <A, E>(
  execute: (context: FiberTaskContext) => Promise<Exit<A, E>>,
) => ResultTask<A, E>

let taskFactory: FiberTaskFactory | undefined = undefined

export const registerFiberTaskFactory = (
  factory: FiberTaskFactory | undefined,
): FiberTaskFactory | undefined => {
  const previous = taskFactory
  taskFactory = factory
  return previous
}

const createTask: FiberTaskFactory = (execute) => {
  if (taskFactory === undefined) throw new TypeError('ResultTask has not initialized')
  return taskFactory(execute)
}

const fiberOutcomes = new WeakMap<
  object,
  { readonly outcome: Promise<Exit<unknown, unknown>>; readonly observe: () => void }
>()

const throwDefect = (defect: unknown): never => {
  throw defect
}

const validateJoinOptions = (options: FiberJoinOptions | undefined): void => {
  if (options !== undefined && (options === null || typeof options !== 'object'))
    throw new TypeError('Fiber.join options must be an object')
  const interruption = options?.interruption
  if (interruption !== undefined && interruption !== 'wait' && interruption !== 'detach')
    throw new TypeError('Fiber.join interruption must be wait or detach')
}

/** Joining waits by default; detached cancellation never consumes a child's failure. */
export const joinFiber = <A, E>(
  fiber: Fiber<A, E>,
  options?: FiberJoinOptions,
): ResultTask<A, E> => {
  validateJoinOptions(options)
  const registered = fiberOutcomes.get(fiber)
  if (options?.interruption !== 'detach') {
    // Preserve structural handles' original construction and execution behavior.
    // eslint-disable-next-line unicorn/require-array-join-separator -- Fiber.join is not Array.join.
    if (registered === undefined) return fiber.join()
    return createTask(async () => {
      registered.observe()
      return (await registered.outcome) as Exit<A, E>
    })
  }
  return createTask(async (context) => {
    const waited = await detachedPromise(
      context.signal,
      async () => (registered === undefined ? context.join(fiber) : registered.outcome),
      throwDefect,
    )
    if (waited._tag === 'Failure') return waited
    registered?.observe()
    return waited.value as Exit<A, E>
  })
}

export interface CreateFiberHandleOptions<A, E> {
  readonly outcome: Promise<Exit<A, E>>
  readonly interrupt: (reason: unknown) => void
  readonly observe: () => void
}

let nextFiberId = 1

const notifyObserver = <A, E>(observer: FiberObserver<A, E>, exit: Exit<A, E>): void => {
  void (async (): Promise<void> => {
    try {
      await observer(exit)
    } catch {
      // Diagnostics never change the fiber's outcome.
    }
  })()
}

/** Shared native handle construction for root and owned child fibers. */
export const createFiberHandle = <A, E>(
  options: CreateFiberHandleOptions<A, E>,
): FiberHandle<A, E> => {
  let snapshot: Exit<A, E> | undefined = undefined
  const observers = new Set<FiberObserver<A, E>>()
  const complete = (exit: Exit<A, E>): Exit<A, E> => {
    snapshot = exit
    for (const observer of observers) {
      observers.delete(observer)
      notifyObserver(observer, exit)
    }
    return exit
  }
  const outcome = options.outcome.then(complete, (error: unknown) => complete(died(error)))
  const id = nextFiberId
  nextFiberId += 1
  const handle: FiberHandle<A, E> = {
    id,
    join: (joinOptions) => joinFiber(handle, joinOptions),
    interrupt: (reason = 'ResultTask fiber interrupted') =>
      createTask(async () => {
        options.observe()
        options.interrupt(reason)
        return success(await outcome)
      }),
    poll: () => snapshot,
    addObserver: (observer) => {
      if (snapshot !== undefined) {
        notifyObserver(observer, snapshot)
        return () => undefined
      }
      const registration: FiberObserver<A, E> = (exit) => observer(exit)
      observers.add(registration)
      return () => {
        observers.delete(registration)
      }
    },
  }
  fiberOutcomes.set(handle, { outcome, observe: options.observe })
  return handle
}

/** Waiter cancellation does not interrupt the observed child or consume its failure. */
export const awaitFiber = <A, E>(fiber: Fiber<A, E>): ResultTask<Exit<A, E>> =>
  createTask<Exit<A, E>, never>(async (context) => {
    const registered = fiberOutcomes.get(fiber)
    const result = await detachedPromise(
      context.signal,
      async () => {
        let exit: Exit<unknown, unknown> = success(undefined)
        try {
          exit = registered === undefined ? await context.join(fiber) : await registered.outcome
        } catch (error) {
          exit = died(error)
        }
        // The registry associates this exact handle with its own typed outcome.
        return exit as Exit<A, E>
      },
      throwDefect,
    )
    if (result._tag === 'Success' && !context.signal.aborted) registered?.observe()
    return result
  })

export interface RuntimeFiber {
  readonly handle: FiberHandle<unknown, unknown>
  readonly outcome: Promise<Exit<unknown, unknown>>
  readonly interrupt: (reason: unknown) => void
  readonly observe: () => void
  readonly cleanup: () => Exit<unknown, unknown>
}

interface PreparedFiber {
  readonly execute: () => Promise<Exit<unknown, unknown>>
  readonly complete: (exit: Exit<unknown, unknown>) => Exit<unknown, unknown>
}

export interface StartFiberOptions {
  readonly signal: AbortSignal
  readonly scope: TaskScope
  readonly prepare: (scope: TaskScope, signal: AbortSignal) => PreparedFiber
}

/** Owns child registration, observation, interruption and finalization. */
export const startFiber = (options: StartFiberOptions): RuntimeFiber => {
  const controller = new AbortController()
  const scope = new TaskScope()
  const child = options.prepare(scope, controller.signal)
  let observed = false
  let settled = false
  let bodyExit: Exit<unknown, unknown> = success(undefined)
  const onAbort = (): void => {
    controller.abort(options.signal.reason)
  }
  const detach = options.scope.addChild({
    interrupt: (reason) => {
      controller.abort(reason)
    },
    close: async () => {
      const exit = await outcome
      if (observed || exit._tag === 'Success') return success(undefined)
      const cause = withoutInterruptions(exit.cause)
      return cause === undefined ? success(undefined) : failure(cause)
    },
  })
  options.signal.addEventListener('abort', onAbort, { once: true })
  if (options.signal.aborted) onAbort()
  const outcome = Promise.resolve().then(async () => {
    try {
      const exit = await child.execute()
      bodyExit = exit
      return child.complete(await scope.close(interruptSuccess(exit, controller.signal)))
    } catch (error) {
      return child.complete(await scope.close(died(error)))
    } finally {
      options.signal.removeEventListener('abort', onAbort)
      settled = true
      if (observed) detach()
    }
  })
  const observe = (): void => {
    observed = true
    if (settled) detach()
  }
  const handle = createFiberHandle({
    outcome,
    interrupt: (reason) => {
      controller.abort(reason)
    },
    observe,
  })

  return {
    handle,
    outcome,
    interrupt: (reason) => {
      controller.abort(reason)
    },
    observe,
    cleanup: () => {
      const nested =
        bodyExit._tag === 'Failure'
          ? transformCause(
              bodyExit.cause,
              (cause) => (isCleanupCause(cause) ? cause : undefined),
              isCleanupCause,
            )
          : undefined
      return child.complete(
        combineExits(
          nested === undefined ? success(undefined) : failure(nested),
          scope.cleanupExit,
          'Sequential',
        ),
      )
    },
  }
}
