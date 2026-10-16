import type { Fiber, FiberHandle, FiberJoinOptions, FiberObserver } from './fiber.js'
import type { Exit, ResultTask } from './result-task.js'
import type { ScopeChild } from './scope.js'
import { TaskScope } from './scope.js'
import {
  combineExits,
  died,
  failure,
  FiberSignal,
  interruptSuccess,
  SUCCESS_UNDEFINED,
  success,
} from './exit.js'
import { transformCause, withoutInterruptions } from './cause-transform.js'
import { detachedPromise } from './promise-interruption.js'
import { isCleanupCause } from './cleanup-cause.js'

/** Supplies task execution without importing ResultTask at runtime. */
export interface FiberTaskContext {
  readonly signal: AbortSignal
}

export type FiberTaskFactory = <A, E>(
  execute: (context: FiberTaskContext) => Exit<A, E> | Promise<Exit<A, E>>,
) => ResultTask<A, E>

export type FiberJoinRunner = (
  fiber: Fiber<unknown, unknown>,
  context: FiberTaskContext,
) => Promise<Exit<unknown, unknown>>

let taskFactory: FiberTaskFactory | undefined = undefined
let joinRunner: FiberJoinRunner | undefined = undefined

export const registerFiberTaskFactory = (
  factory: FiberTaskFactory | undefined,
  runJoin?: FiberJoinRunner,
): FiberTaskFactory | undefined => {
  const previous = taskFactory
  taskFactory = factory
  if (runJoin !== undefined) {
    joinRunner = runJoin
  }
  return previous
}

const createTask: FiberTaskFactory = (execute) => {
  if (taskFactory === undefined) throw new TypeError('ResultTask has not initialized')
  return taskFactory(execute)
}

const executeStructuralJoin = (
  fiber: Fiber<unknown, unknown>,
  context: FiberTaskContext,
): Promise<Exit<unknown, unknown>> => {
  if (taskFactory === undefined || joinRunner === undefined)
    throw new TypeError('ResultTask has not initialized')
  return joinRunner(fiber, context)
}

const FIBER_META = Symbol.for('resultar.fiber.meta')

interface FiberMeta {
  readonly outcome: Promise<Exit<unknown, unknown>>
  readonly observe: () => void
  readonly poll: () => Exit<unknown, unknown> | undefined
  readonly getWaitJoinTask: () => ResultTask<unknown, unknown>
}

const getFiberMeta = (fiber: unknown): FiberMeta | undefined =>
  typeof fiber === 'object' && fiber !== null
    ? (fiber as { readonly [FIBER_META]?: FiberMeta })[FIBER_META]
    : undefined

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
  if (options !== undefined) validateJoinOptions(options)
  const registered = getFiberMeta(fiber)
  if (options === undefined || options.interruption !== 'detach') {
    // Preserve structural handles' original construction and execution behavior.
    // eslint-disable-next-line unicorn/require-array-join-separator -- Fiber.join is not Array.join.
    if (registered === undefined) return fiber.join()
    return registered.getWaitJoinTask() as ResultTask<A, E>
  }
  return createTask(async (context) => {
    const waited = await detachedPromise(
      context.signal,
      () => (registered === undefined ? executeStructuralJoin(fiber, context) : registered.outcome),
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

const NOOP_DISPOSE = (): void => undefined

const notifyObserver = <A, E>(observer: FiberObserver<A, E>, exit: Exit<A, E>): void => {
  void (async (): Promise<void> => {
    try {
      const observed: unknown = observer(exit)
      if (
        typeof observed === 'object' &&
        observed !== null &&
        typeof (observed as PromiseLike<unknown>).then === 'function' &&
        !(Symbol.iterator in observed)
      ) {
        await (observed as PromiseLike<unknown>)
      }
    } catch {
      // Diagnostics never change the fiber's outcome.
    }
  })()
}

class NativeFiberHandle<A, E> implements FiberHandle<A, E>, FiberMeta {
  public readonly id: number
  public readonly outcome: Promise<Exit<A, E>>
  public readonly [FIBER_META]: FiberMeta
  private snapshot: Exit<A, E> | undefined = undefined
  private observers: Set<FiberObserver<A, E>> | undefined = undefined
  private waitJoinTask: ResultTask<A, E> | undefined = undefined
  private readonly backing: ManagedFiber | CreateFiberHandleOptions<A, E>

  public constructor(backing: ManagedFiber | CreateFiberHandleOptions<A, E>, isManaged: boolean) {
    this.id = nextFiberId
    nextFiberId += 1
    this.backing = backing
    this[FIBER_META] = this
    if (isManaged) {
      this.outcome = (backing as ManagedFiber).outcome as Promise<Exit<A, E>>
    } else {
      const options = backing as CreateFiberHandleOptions<A, E>
      this.outcome = options.outcome.then(
        (exit) => this.complete(exit),
        (error: unknown) => this.complete(died(error)),
      )
    }
  }

  public complete(exit: Exit<A, E>): Exit<A, E> {
    this.snapshot = exit
    const observers = this.observers
    if (observers !== undefined) {
      for (const observer of observers) {
        observers.delete(observer)
        notifyObserver(observer, exit)
      }
    }
    return exit
  }

  public observe(): void {
    this.backing.observe()
  }

  public poll(): Exit<A, E> | undefined {
    return this.snapshot
  }

  public getWaitJoinTask(): ResultTask<A, E> {
    this.waitJoinTask ??= createTask(() => {
      this.backing.observe()
      if (this.snapshot !== undefined) return this.snapshot
      return this.outcome
    })
    return this.waitJoinTask
  }

  public join(joinOptions?: FiberJoinOptions): ResultTask<A, E> {
    if (joinOptions === undefined) return this.getWaitJoinTask()
    return joinFiber(this, joinOptions)
  }

  public interrupt(reason: unknown = 'ResultTask fiber interrupted'): ResultTask<Exit<A, E>> {
    return createTask<Exit<A, E>, never>(() => {
      this.backing.observe()
      this.backing.interrupt(reason)
      if (this.snapshot !== undefined) return success<Exit<A, E>, never>(this.snapshot)
      return this.outcome.then((exit) => success<Exit<A, E>, never>(exit))
    })
  }

  public addObserver(observer: FiberObserver<A, E>): () => void {
    if (this.snapshot !== undefined) {
      notifyObserver(observer, this.snapshot)
      return NOOP_DISPOSE
    }
    const registration: FiberObserver<A, E> = (exit) => observer(exit)
    this.observers ??= new Set()
    this.observers.add(registration)
    return () => {
      this.observers?.delete(registration)
    }
  }
}

/** Shared native handle construction for root and owned child fibers. */
export const createFiberHandle = <A, E>(
  options: CreateFiberHandleOptions<A, E>,
): FiberHandle<A, E> => new NativeFiberHandle<A, E>(options, false)

/** Waiter cancellation does not interrupt the observed child or consume its failure. */
export const awaitFiber = <A, E>(fiber: Fiber<A, E>): ResultTask<Exit<A, E>> =>
  createTask<Exit<A, E>, never>(async (context) => {
    const registered = getFiberMeta(fiber)
    const result = await detachedPromise(
      context.signal,
      async () => {
        let exit: Exit<unknown, unknown> = SUCCESS_UNDEFINED
        try {
          exit =
            registered === undefined
              ? await executeStructuralJoin(fiber, context)
              : await registered.outcome
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

export interface SupervisedFiber {
  readonly outcome: Promise<Exit<unknown, unknown>>
  readonly interrupt: (reason: unknown) => void
  readonly observe: () => void
  readonly cleanup: () => Exit<unknown, unknown>
}

export interface RuntimeFiber extends SupervisedFiber {
  readonly handle: FiberHandle<unknown, unknown>
}

interface PreparedFiber {
  readonly execute: () => Exit<unknown, unknown> | Promise<Exit<unknown, unknown>>
  readonly complete: (exit: Exit<unknown, unknown>) => Exit<unknown, unknown>
}

export interface StartFiberOptions {
  readonly signal: AbortSignal
  readonly scope: TaskScope
  readonly prepare: (scope: TaskScope, signal: AbortSignal) => PreparedFiber
  readonly onSettled?: (exit: Exit<unknown, unknown>) => void
}

const RESOLVED_PROMISE = Promise.resolve()

/* eslint-disable max-params */
class ManagedFiber implements RuntimeFiber, ScopeChild {
  public readonly outcome: Promise<Exit<unknown, unknown>>
  public readonly handle!: FiberHandle<unknown, unknown>
  public owner?: TaskScope | undefined = undefined
  private readonly scope: TaskScope
  private readonly fiberSignal: FiberSignal
  private readonly executeFn: () => Exit<unknown, unknown> | Promise<Exit<unknown, unknown>>
  private readonly completeFn:
    | ((exit: Exit<unknown, unknown>) => Exit<unknown, unknown>)
    | undefined
  private readonly onSettled: ((exit: Exit<unknown, unknown>) => void) | undefined
  private readonly nativeHandle: NativeFiberHandle<unknown, unknown> | undefined
  private observed = false
  private settled = false
  private bodyExit: Exit<unknown, unknown> = SUCCESS_UNDEFINED

  public constructor(
    parentScope: TaskScope,
    scope: TaskScope,
    fiberSignal: FiberSignal,
    executeFn: () => Exit<unknown, unknown> | Promise<Exit<unknown, unknown>>,
    completeFn: ((exit: Exit<unknown, unknown>) => Exit<unknown, unknown>) | undefined,
    onSettled: ((exit: Exit<unknown, unknown>) => void) | undefined,
    withHandle: boolean,
  ) {
    this.scope = scope
    this.fiberSignal = fiberSignal
    this.executeFn = executeFn
    this.completeFn = completeFn
    this.onSettled = onSettled
    parentScope.registerChild(this)
    this.outcome = RESOLVED_PROMISE.then(() => this.run())
    if (withHandle) {
      const handle = new NativeFiberHandle<unknown, unknown>(this, true)
      this.nativeHandle = handle
      this.handle = handle
    } else {
      this.nativeHandle = undefined
    }
  }

  public interrupt(reason: unknown): void {
    this.fiberSignal.abort(reason)
  }

  public observe(): void {
    this.observed = true
    if (this.settled) {
      this.owner?.unregisterChild(this)
    }
  }

  public async close(): Promise<Exit<unknown, unknown>> {
    const exit = await this.outcome
    if (this.observed || exit._tag === 'Success') return SUCCESS_UNDEFINED
    const cause = withoutInterruptions(exit.cause)
    return cause === undefined ? SUCCESS_UNDEFINED : failure(cause)
  }

  public cleanup(): Exit<unknown, unknown> {
    const nested =
      this.bodyExit._tag === 'Failure'
        ? transformCause(
            this.bodyExit.cause,
            (cause) => (isCleanupCause(cause) ? cause : undefined),
            isCleanupCause,
          )
        : undefined
    const combined = combineExits(
      nested === undefined ? SUCCESS_UNDEFINED : failure(nested),
      this.scope.cleanupExit,
      'Sequential',
    )
    return this.completeFn === undefined ? combined : this.completeFn(combined)
  }

  private run(): Exit<unknown, unknown> | Promise<Exit<unknown, unknown>> {
    try {
      const exitOrPromise = this.executeFn()
      if ('_tag' in exitOrPromise) {
        return this.handleBodyExit(exitOrPromise)
      }
      return exitOrPromise.then(
        (exit) => this.handleBodyExit(exit),
        (error: unknown) => this.handleError(error),
      )
    } catch (error) {
      return this.handleError(error)
    }
  }

  private finalize(exit: Exit<unknown, unknown>): Exit<unknown, unknown> {
    this.fiberSignal.dispose()
    this.settled = true
    if (this.observed) {
      this.owner?.unregisterChild(this)
    }
    const completed = this.completeFn === undefined ? exit : this.completeFn(exit)
    this.nativeHandle?.complete(completed)
    this.onSettled?.(completed)
    return completed
  }

  private handleError(error: unknown): Exit<unknown, unknown> | Promise<Exit<unknown, unknown>> {
    const closed = this.scope.closeSyncOrAsync(died(error))
    if ('_tag' in closed) {
      return this.finalize(closed)
    }
    return closed.then((exit) => this.finalize(exit))
  }

  private handleBodyExit(
    exit: Exit<unknown, unknown>,
  ): Exit<unknown, unknown> | Promise<Exit<unknown, unknown>> {
    this.bodyExit = exit
    const closed = this.scope.closeSyncOrAsync(
      interruptSuccess(exit, this.fiberSignal.asAbortSignal()),
    )
    if ('_tag' in closed) {
      return this.finalize(closed)
    }
    return closed.then((closedExit) => this.finalize(closedExit))
  }
}

export const startDirectFiber = (
  parentScope: TaskScope,
  scope: TaskScope,
  fiberSignal: FiberSignal,
  executeFn: () => Exit<unknown, unknown> | Promise<Exit<unknown, unknown>>,
  completeFn: ((exit: Exit<unknown, unknown>) => Exit<unknown, unknown>) | undefined,
  withHandle: boolean,
): ManagedFiber =>
  new ManagedFiber(parentScope, scope, fiberSignal, executeFn, completeFn, undefined, withHandle)
/* eslint-enable max-params */

/** Owns child registration, observation, interruption and finalization. */
export const startFiber = (options: StartFiberOptions): RuntimeFiber => {
  const fiberSignal = new FiberSignal(options.signal)
  const scope = new TaskScope()
  const child = options.prepare(scope, fiberSignal.asAbortSignal())
  return new ManagedFiber(
    options.scope,
    scope,
    fiberSignal,
    child.execute,
    child.complete,
    options.onSettled,
    true,
  )
}
