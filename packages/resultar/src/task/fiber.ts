import type { Exit, ResultTask } from './result-task.js'
import { awaitFiber, joinFiber } from './fiber-runtime.js'

/** Options controlling how a joining fiber reacts when the joiner itself is interrupted. */
export interface FiberJoinOptions {
  /**
   * `'wait'` (default) interrupts the joined child fiber and awaits its cleanup before exiting;
   * `'detach'` cancels only the current waiter without interrupting the target fiber.
   */
  readonly interruption?: 'wait' | 'detach'
}

/** Callback invoked with a fiber's terminal {@link Exit} once all of its finalizers have completed. */
export type FiberObserver<A, E> = (exit: Exit<A, E>) => unknown

/**
 * A running child or root `ResultTask` fiber that can be joined or interrupted.
 *
 * Joining a child fiber transfers ownership of its failure so parent supervision does not
 * redundantly abort siblings when you handle the child's error yourself.
 */
export interface Fiber<out A, out E = never> {
  /** Waits for the fiber to finish and replays its outcome (`Ok`, `Err`, defect, or interruption). */
  readonly join: (options?: FiberJoinOptions) => ResultTask<A, E>
  /** Signals interruption, waits for all finalizers to settle, and returns the terminal {@link Exit}. */
  readonly interrupt: (reason?: unknown) => ResultTask<Exit<A, E>>
}

/**
 * Native fiber handle returned by `ResultTask.forkChild` and `ResultTask.runFork`,
 * providing synchronous diagnostics (`id`, `poll`, `addObserver`) alongside `join` and `interrupt`.
 */
export interface FiberHandle<out A, out E = never> extends Fiber<A, E> {
  /** Monotonically increasing numeric identifier unique to this fiber. */
  readonly id: number
  /** Synchronously returns the terminal {@link Exit} after cleanup, or `undefined` while still running. */
  readonly poll: () => Exit<A, E> | undefined
  /** Registers a best-effort completion observer and returns an unsubscribe function. */
  readonly addObserver: (observer: FiberObserver<A, E>) => () => void
}

/**
 * Companion operations for inspecting, joining, and interrupting {@link Fiber} and {@link FiberHandle} instances.
 *
 * @example
 * ```ts
 * import { Fiber, ResultTask } from 'resultar'
 *
 * const workflow = ResultTask.gen(function* () {
 *   const child = yield* ResultTask.of(() => 'computed').forkChild()
 *   const value = yield* Fiber.join(child)
 *   return value
 * })
 * ```
 */
export const Fiber: {
  /** Waits for `fiber` to settle and returns its terminal {@link Exit} as `Ok(exit)` without replaying failures. */
  readonly await: <A, E>(fiber: Fiber<A, E>) => ResultTask<Exit<A, E>>
  /** Joins `fiber` and replays its outcome in the caller task. */
  readonly join: <A, E>(fiber: Fiber<A, E>, options?: FiberJoinOptions) => ResultTask<A, E>
  /** Interrupts `fiber`, waits for all finalizers to complete, and returns its terminal {@link Exit}. */
  readonly interrupt: <A, E>(fiber: Fiber<A, E>, reason?: unknown) => ResultTask<Exit<A, E>>
  /** Synchronously polls `fiber` for its completed {@link Exit} without consuming failure ownership. */
  readonly poll: <A, E>(fiber: FiberHandle<A, E>) => Exit<A, E> | undefined
  /** Subscribes `observer` to `fiber`'s terminal {@link Exit} and returns an unsubscribe function. */
  readonly addObserver: <A, E>(
    fiber: FiberHandle<A, E>,
    observer: FiberObserver<A, E>,
  ) => () => void
} = Object.freeze({
  await: <A, E>(fiber: Fiber<A, E>): ResultTask<Exit<A, E>> => awaitFiber(fiber),
  join: <A, E>(fiber: Fiber<A, E>, options?: FiberJoinOptions): ResultTask<A, E> =>
    joinFiber(fiber, options),
  interrupt: <A, E>(fiber: Fiber<A, E>, reason?: unknown): ResultTask<Exit<A, E>> =>
    fiber.interrupt(reason),
  poll: <A, E>(fiber: FiberHandle<A, E>): Exit<A, E> | undefined => fiber.poll(),
  addObserver: <A, E>(fiber: FiberHandle<A, E>, observer: FiberObserver<A, E>): (() => void) =>
    fiber.addObserver(observer),
})
