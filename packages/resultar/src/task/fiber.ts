import type { Exit, ResultTask } from './result-task.js'
import { awaitFiber, joinFiber } from './fiber-runtime.js'

export interface FiberJoinOptions {
  /** Wait for the target by default; detach cancels only this waiter. */
  readonly interruption?: 'wait' | 'detach'
}

export type FiberObserver<A, E> = (exit: Exit<A, E>) => unknown

/** A running task that can be joined or interrupted. */
export interface Fiber<out A, out E = never> {
  readonly join: (options?: FiberJoinOptions) => ResultTask<A, E>
  readonly interrupt: (reason?: unknown) => ResultTask<Exit<A, E>>
}

/** A native fiber with synchronous diagnostics that never consume owned failures. */
export interface FiberHandle<out A, out E = never> extends Fiber<A, E> {
  readonly id: number
  /** Returns the completed exit after cleanup, or undefined while running. */
  readonly poll: () => Exit<A, E> | undefined
  /** Registers a best-effort observer and returns its removal function. */
  readonly addObserver: (observer: FiberObserver<A, E>) => () => void
}

/** Operations on child or root fibers. Interrupt waits for all finalizers. */
export const Fiber: {
  /** Observes the complete exit after cleanup without interrupting the child. */
  readonly await: <A, E>(fiber: Fiber<A, E>) => ResultTask<Exit<A, E>>
  readonly join: <A, E>(fiber: Fiber<A, E>, options?: FiberJoinOptions) => ResultTask<A, E>
  readonly interrupt: <A, E>(fiber: Fiber<A, E>, reason?: unknown) => ResultTask<Exit<A, E>>
  readonly poll: <A, E>(fiber: FiberHandle<A, E>) => Exit<A, E> | undefined
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
