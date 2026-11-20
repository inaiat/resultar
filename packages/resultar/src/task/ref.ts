import { ResultTask } from './result-task.js'

/**
 * Lazy mutable state cell whose reads and updates are composed as synchronous `ResultTask` values.
 *
 * All operations execute atomically within a single JavaScript turn and stay synchronous (working
 * seamlessly with `runSync`, `ResultTask.gen`, and concurrent fibers).
 *
 * @example
 * ```ts
 * import { Ref, ResultTask } from 'resultar'
 *
 * const counter = Ref.make(0)
 * const program = ResultTask.gen(function* () {
 *   yield* counter.update((n) => n + 1)
 *   return yield* counter.updateAndGet((n) => n + 41)
 * })
 * // program.runSync() -> Ok(42)
 * ```
 */
export interface Ref<A> {
  /** Lazily reads the current value. */
  readonly get: () => ResultTask<A>
  /** Lazily replaces the current value with `value`. */
  readonly set: (value: A) => ResultTask<void>
  /** Lazily applies `fn` to the current value and stores the result. */
  readonly update: (fn: (current: A) => A) => ResultTask<void>
  /** Lazily updates the value with `fn` and returns the new value. */
  readonly updateAndGet: (fn: (current: A) => A) => ResultTask<A>
  /** Lazily updates the value with `fn` and returns the previous value. */
  readonly getAndUpdate: (fn: (current: A) => A) => ResultTask<A>
  /** Lazily replaces the value with `value` and returns the previous value. */
  readonly getAndSet: (value: A) => ResultTask<A>
  /** Lazily computes `[result, nextState]`, stores `nextState`, and returns `result`. */
  readonly modify: <B>(fn: (current: A) => readonly [B, A]) => ResultTask<B>
}

const make = <A>(initial: A): Ref<A> => {
  let current = initial

  return {
    get: () => ResultTask.sync(() => current),
    set: (value) =>
      ResultTask.sync(() => {
        current = value
      }),
    update: (fn) =>
      ResultTask.sync(() => {
        current = fn(current)
      }),
    updateAndGet: (fn) =>
      ResultTask.sync(() => {
        current = fn(current)
        return current
      }),
    getAndUpdate: (fn) =>
      ResultTask.sync(() => {
        const previous = current
        current = fn(previous)
        return previous
      }),
    getAndSet: (value) =>
      ResultTask.sync(() => {
        const previous = current
        current = value
        return previous
      }),
    modify: <B>(fn: (value: A) => readonly [B, A]) =>
      ResultTask.sync(() => {
        const [result, next] = fn(current)
        current = next
        return result
      }),
  }
}

/**
 * Factory namespace for constructing lazy mutable {@link Ref} cells.
 *
 * @example
 * ```ts
 * import { Ref } from 'resultar'
 *
 * const ref = Ref.make('idle')
 * const previous = ref.getAndSet('running').runSync()
 * // Ok('idle')
 * ```
 */
export const Ref: {
  /** Creates a new {@link Ref} initialized to `initial`. */
  readonly make: <A>(initial: A) => Ref<A>
} = Object.freeze({ make })
