import type { ErrorConfig } from './error.js'
import { createResultarError } from './error.js'
import { errAsync, ResultAsync } from './result-async.js'
import type { ExtractErrTypes, ExtractOkTypes, InferErrTypes, InferOkTypes } from './utils.js'
import { combineResultList, combineResultListWithAllErrors } from './utils.js'

class Ok<T> {
  readonly ok = true
  constructor(public readonly value: T) {}
}

class Err<E> {
  readonly ok = false
  constructor(public readonly error: E) {}
}

/**
 * A Result interface that is used to define the methods that are available on a
 * `Result` object.
 *
 * The immutability of the `Result` object is maintained by the interface.
 */
interface Resultable<T, E> {
  get value(): T
  get error(): E

  /**
   * Used to check if a `Result` is an `OK`
   *
   * @returns `true` if the result is an `OK` variant of Result
   */
  isOk(): boolean

  /**
   * Used to check if a `Result` is an `Err`
   *
   * @returns `true` if the result is an `Err` variant of Result
   */
  isErr(): boolean
  /**
   * Unwrap the `Ok` value, or return the default if there is an `Err`
   *
   * @param v the default value to return if there is an `Err`
   */

  unwrapOr<A>(defaultValue: A): T | A

  // safeUnwrap(): Generator<Result<never, E>, T>

  /**
   * **This method is unsafe, and should only be used in a test environments**
   *
   * Takes a `Result<T, E>` and returns a `T` when the result is an `Ok`, otherwise it throws a custom object.
   *
   * @param config
   */
  _unsafeUnwrap(config?: ErrorConfig): T

  /**
   * **This method is unsafe, and should only be used in a test environments**
   *
   * takes a `Result<T, E>` and returns a `E` when the result is an `Err`,
   * otherwise it throws a custom object.
   *
   * @param config
   */
  _unsafeUnwrapErr(config?: ErrorConfig): E
}

/**
 * A `Result` is a type that represents either success (`Ok`) or failure (`Err`).
 * It is often used to replace exceptions or `null` returns.
 * `Result` is often used to handle errors in a functional way.
 * The `Result` type is often used to handle errors in a functional way.
 */
export class Result<T, E> implements Resultable<T, E> {
  /**
   * Wraps a function with a try catch, creating a new function with the same
   * arguments but returning `Ok` if successful, `Err` if the function throws
   *
   * @param fn function to wrap with ok on success or err on failure
   * @param errorFn when an error is thrown, this will wrap the error result if provided
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static fromThrowable<Fn extends (...args: readonly any[]) => unknown, E>(
    fn: Fn,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    errorFn?: (e: any) => E,
  ): (...args: Parameters<Fn>) => Result<ReturnType<Fn>, E> {
    return (...args) => {
      try {
        const result = fn(...args)
        return ok(result as ReturnType<Fn>)
      } catch (error) {
        if (errorFn) {
          return err(errorFn(error))
        }

        return err(error as E)
      }
    }
  }

  /**
   * Creates a new `Result` instance representing a successful operation.
   *
   * @param {T} value - The value to be wrapped in the `Result` instance.
   * @return {Result<T, E>} A new `Result` instance with the provided value.
   */
  static ok<T, E = never>(value: T): Result<T, E> {
    return new Result<T, E>(new Ok(value))
  }

  /**
   * Creates a new `Result` instance representing a successful operation with an undefined value.
   *
   * @return {Result<undefined, E>} A new `Result` instance with an undefined value.
   */
  static unit<E = never>(): Result<undefined, E> {
    return new Result<undefined, E>(new Ok(undefined))
  }

  static err<T = never, E = unknown>(error: E): Result<T, E> {
    return new Result<T, E>(new Err(error))
  }

  static combine<
    T extends readonly [Result<unknown, unknown>, ...Result<unknown, unknown>[]],
  >(resultList: T): CombineResults<T>
  static combine<T extends readonly Result<unknown, unknown>[]>(
    resultList: T,
  ): CombineResults<T>
  static combine<
    T extends readonly [Result<unknown, unknown>, ...Result<unknown, unknown>[]],
  >(resultList: T): CombineResults<T> {
    return combineResultList(resultList) as CombineResults<T>
  }

  static combineWithAllErrors<
    T extends readonly [Result<unknown, unknown>, ...Result<unknown, unknown>[]],
  >(resultList: T): CombineResultsWithAllErrorsArray<T>
  static combineWithAllErrors<T extends readonly Result<unknown, unknown>[]>(
    resultList: T,
  ): CombineResultsWithAllErrorsArray<T>
  static combineWithAllErrors<T extends readonly Result<unknown, unknown>[]>(
    resultList: T,
  ): CombineResultsWithAllErrorsArray<T> {
    return combineResultListWithAllErrors(resultList) as CombineResultsWithAllErrorsArray<T>
  }

  readonly value: T
  readonly error: E

  private constructor(private readonly state: Ok<T> | Err<E>) {
    if (state.ok) {
      this.value = state.value
      this.error = undefined as E
    } else {
      this.error = state.error
      this.value = undefined as T
    }
  }

  /**
   * Used to check if a `Result` is an `OK`
   *
   * @returns `true` if the result is an `OK` variant of Result
   */
  isOk(): boolean {
    return this.state.ok
  }

  /**
   * Used to check if a `Result` is an `Err`
   *
   * @returns `true` if the result is an `Err` variant of Result
   */
  isErr(): boolean {
    return !this.state.ok
  }

  /**
   * Maps a `Result<T, E>` to `Result<U, E>`
   * by applying a function to a contained `Ok` value, leaving an `Err` value
   * untouched.
   *
   * @param f The function to apply an `OK` value
   * @returns the result of applying `f` or an `Err` untouched
   */
  map<X>(f: (t: T) => X): Result<X, E> {
    if (this.state.ok) {
      const value = f(this.value)
      return ok(value)
    }

    return err(this.error)
  }

  /**
   * Maps a `Result<T, E>` to `Result<T, F>` by applying a function to a
   * contained `Err` value, leaving an `Ok` value untouched.
   *
   * This function can be used to pass through a successful result while
   * handling an error.
   *
   * @param f a function to apply to the error `Err` value
   */
  mapErr<X>(fn: (t: E) => X): Result<T, X> {
    if (this.state.ok) {
      return ok(this.value)
    }

    return err(fn(this.error))
  }

  /**
   * Similar to `map` Except you must return a new `Result`.
   *
   * This is useful for when you need to do a subsequent computation using the
   * inner `T` value, but that computation might fail.
   * Additionally, `andThen` is really useful as a tool to flatten a
   * `Result<Result<A, E2>, E1>` into a `Result<A, E2>` (see example below).
   *
   * @param f The function to apply to the current value
   */
  andThen<X, Y>(f: (t: T) => Result<X, Y>): Result<X, E | Y> {
    if (this.state.ok) {
      return f(this.value)
    }

    return err(this.error)
  }

  if(fCondition: (t: T) => boolean) {
    return {
      true: <X1, Y1>(fTrue: (t: T) => Result<X1, Y1>) => ({
        false: <X2, Y2>(fFalse: (t: T) => Result<X2, Y2>): Result<X1 | X2, Y1 | Y2 | E> => {
          if (this.state.ok) {
            const condition = fCondition(this.value)
            return condition ? fTrue(this.value) : fFalse(this.value)
          }

          return err(this.error)
        },
      }),
    }
  }

  /**
   * Takes an `Err` value and maps it to a `Result<T, SomeNewType>`.
   *
   * This is useful for error recovery.
   *
   * @param f  A function to apply to an `Err` value, leaving `Ok` values
   * untouched.
   */
  orElse<R extends Result<unknown, unknown>>(
    f: (e: E) => R,
  ): Result<InferOkTypes<R> | T, InferErrTypes<R>>
  orElse<U, A>(f: (e: E) => Result<U, A>): Result<U | T, A> {
    if (this.state.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ok(this.value as Exclude<T, Promise<any>>)
    }

    return f(this.error)
  }

  /**
   * Similar to `map` Except you must return a new `Result`.
   *
   * This is useful for when you need to do a subsequent async computation using
   * the inner `T` value, but that computation might fail. Must return a ResultAsync
   *
   * @param f The function that returns a `ResultAsync` to apply to the current
   * value
   */
  asyncAndThen<X, Y>(f: (t: T) => ResultAsync<X, Y>): ResultAsync<X, E | Y>
  asyncAndThen<X, Y>(f: (t: T) => ResultAsync<X, E>): ResultAsync<X, E | Y> {
    if (this.state.ok) {
      return f(this.value)
    }

    return errAsync(this.error)
  }

  /**
   * Maps a `Result<T, E>` to `ResultAsync<U, E>`
   * by applying an async function to a contained `Ok` value, leaving an `Err`
   * value untouched.
   *
   * @param f An async function to apply an `OK` value
   */
  asyncMap<X>(f: (t: T) => Promise<X>): ResultAsync<X, E> {
    if (this.state.ok) {
      return ResultAsync.fromSafePromise(f(this.value))
    }

    return errAsync(this.error)
  }

  /**
   * Unwrap the `Ok` value, or return the default if there is an `Err`
   *
   * @param v the default value to return if there is an `Err`
   */
  unwrapOr<A>(defaultValue: A): T | A {
    if (this.state.ok) {
      return this.value
    }

    return defaultValue
  }

  /**
   * Given 2 functions (one for the `Ok` variant and one for the `Err` variant)
   * execute the function that matches the `Result` variant.
   *
   * Match callbacks do not necessitate to return a `Result`, however you can
   * return a `Result` if you want to.
   *
   * `match` is like chaining `map` and `mapErr`, with the distinction that
   * with `match` both functions must have the same return type.
   *
   * @param ok
   * @param err
   */
  match<X>(fnOk: (t: T) => X, fnErr: (e: E) => X): X {
    if (this.state.ok) {
      return fnOk(this.value)
    }

    return fnErr(this.error)
  }

  /**
   * Performs a side effect for the `Ok` or `Err` variant of `Result`.
   *
   * @param fn The function to apply an `OK` value
   * @returns the result of applying `f` or an `Err` untouched
   */
  log(fn: (t?: T, e?: E) => void): this {
    try {
      fn(this.value, this.error)
    } catch { /* empty */ }

    return this
  }

  /**
   * Performs a side effect for the `Ok` variant of `Result`.
   *
   * @param fn The function to apply an `OK` value
   * @returns the result of applying `f` or an `Err` untouched
   */
  tap(fn: (t: T) => void): this {
    if (this.state.ok) {
      try {
        fn(this.value)
      } catch { /* empty */ }
    }

    return this
  }

  /**
   * Performs a side effect for the `Err` variant of `Result`.
   *
   * @param fn The function to apply an `Err` value
   * @returns the result of applying `f` or an `Ok` untouched
   */
  tapError(fn: (e: E) => void): this {
    if (!this.state.ok) {
      try {
        fn(this.error)
      } catch { /* empty */ }
    }

    return this
  }

  /**
   * This method is used to clean up and release any resources that the `Result`
   * @param f The function that will be called to clean up the resources
   */
  finally<X = T, Y = E>(f: (value: X, error: Y) => void): DisposableResult<X, Y>
  finally(f: (value: T, error: E) => void): DisposableResult<T, E> {
    const resultDisposable = new DisposableResult(this, f)
    try {
      return resultDisposable
    } finally {
      resultDisposable[Symbol.dispose]()
    }
  }

  /**
   * **This method is unsafe, and should only be used in a test environments**
   *
   * Takes a `Result<T, E>` and returns a `T` when the result is an `Ok`, otherwise it throws a custom object.
   *
   * @param config
   */
  _unsafeUnwrap(config?: ErrorConfig): T {
    if (this.state.ok) {
      return this.value
    }

    throw createResultarError('Called `_unsafeUnwrap` on an Err', this, config)
  }

  /**
   * **This method is unsafe, and should only be used in a test environments**
   *
   * takes a `Result<T, E>` and returns a `E` when the result is an `Err`,
   * otherwise it throws a custom object.
   *
   * @param config
   */
  _unsafeUnwrapErr(config?: ErrorConfig): E {
    if (this.state.ok) {
      throw createResultarError('Called `_unsafeUnwrapErr` on an Ok', this, config)
    }

    return this.error
  }

  safeUnwrap(): Generator<Result<never, E>, T> {
    if (this.state.ok) {
      const { value } = this
      /* eslint-disable-next-line require-yield */
      return (function*() {
        return value
      })()
    }

    const { error } = this
    return (function*() {
      yield err(error)

      throw new Error('Do not use this generator out of `safeTry`')
    })()
  }
}

/**
 * A `Disposable` is an object that has a `dispose` method that can be used to
 * clean up resources.
 */
export class DisposableResult<T, E> implements Resultable<T, E>, Disposable {
  constructor(readonly result: Resultable<T, E>, private readonly finalizer: (value: T, error: E) => void) {}

  get value(): T {
    return this.result.value
  }

  get error(): E {
    return this.result.error
  }

  _unsafeUnwrap(config?: ErrorConfig): T {
    return this.result._unsafeUnwrap(config)
  }

  _unsafeUnwrapErr(config?: ErrorConfig): E {
    return this.result._unsafeUnwrapErr(config)
  }

  isOk(): boolean {
    return this.result.isOk()
  }

  isErr(): boolean {
    return this.result.isErr()
  }

  unwrapOr<A>(defaultValue: A): T | A {
    return this.result.unwrapOr(defaultValue)
  }

  [Symbol.dispose](): void {
    this.finalizer(this.result.value, this.result.error)
  }
}

// eslint-disable-next-line @typescript-eslint/unbound-method
export const { ok, err, fromThrowable, unit } = Result

/**
 * Evaluates the given generator to a Result returned or an Err yielded from it,
 * whichever comes first.
 *
 * This function, in combination with `Result.safeUnwrap()`, is intended to emulate
 * Rust's ? operator.
 * See `/tests/safeTry.test.ts` for examples.
 *
 * @param body - What is evaluated. In body, `yield* result.safeUnwrap()` works as
 * Rust's `result?` expression.
 * @returns The first occurence of either an yielded Err or a returned Result.
 */
export function safeTry<T, E>(body: () => Generator<Result<never, E>, Result<T, E>>): Result<T, E>
export function safeTry<
  YieldErr extends Result<never, unknown>,
  GeneratorReturnResult extends Result<unknown, unknown>,
>(
  body: () => Generator<YieldErr, GeneratorReturnResult>,
): Result<
  InferOkTypes<GeneratorReturnResult>,
  InferErrTypes<YieldErr> | InferErrTypes<GeneratorReturnResult>
>

/**
 * Evaluates the given generator to a Result returned or an Err yielded from it,
 * whichever comes first.
 *
 * This function, in combination with `Result.safeUnwrap()`, is intended to emulate
 * Rust's ? operator.
 * See `/tests/safeTry.test.ts` for examples.
 *
 * @param body - What is evaluated. In body, `yield* result.safeUnwrap()` and
 * `yield* resultAsync.safeUnwrap()` work as Rust's `result?` expression.
 * @returns The first occurence of either an yielded Err or a returned Result.
 */
export function safeTry<T, E>(
  body: () => AsyncGenerator<Result<never, E>, Result<T, E>>,
): ResultAsync<T, E>
export function safeTry<
  YieldErr extends Result<never, unknown>,
  GeneratorReturnResult extends Result<unknown, unknown>,
>(
  body: () => AsyncGenerator<YieldErr, GeneratorReturnResult>,
): ResultAsync<
  InferOkTypes<GeneratorReturnResult>,
  InferErrTypes<YieldErr> | InferErrTypes<GeneratorReturnResult>
>
export function safeTry<T, E>(
  body:
    | (() => Generator<Result<never, E>, Result<T, E>>)
    | (() => AsyncGenerator<Result<never, E>, Result<T, E>>),
): Result<T, E> | ResultAsync<T, E> {
  const n = body().next()
  if (n instanceof Promise) {
    return new ResultAsync(n.then((r) => r.value))
  }

  return n.value
}

// #region Combine - Types

// This is a helper type to prevent infinite recursion in typing rules.
//
// Use this with your `depth` variable in your types.
type Prev = [
  never,
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  17,
  18,
  19,
  20,
  21,
  22,
  23,
  24,
  25,
  26,
  27,
  28,
  29,
  30,
  31,
  32,
  33,
  34,
  35,
  36,
  37,
  38,
  39,
  40,
  41,
  42,
  43,
  44,
  45,
  46,
  47,
  48,
  49,
  ...0[],
]

// Collects the results array into separate tuple array.
//
// T         - The array of the results
// Collected - The collected tuples.
// Depth     - The maximum depth.
type CollectResults<T, Collected extends unknown[] = [], Depth extends number = 50> = [
  Depth,
] extends [never] ? []
  : T extends [infer H, ...infer Rest]
  // And test whether the head of the list is a result
    ? H extends Result<infer L, infer R>
      // Continue collecting...
      ? CollectResults<
        // the rest of the elements
        Rest,
        // The collected
        [...Collected, [L, R]],
        // and one less of the current depth
        Prev[Depth]
      >
    : never // Impossible
  : Collected

// Transposes an array
//
// A          - The array source
// Transposed - The collected transposed array
// Depth      - The maximum depth.
export type Transpose<
  A,
  Transposed extends unknown[][] = [],
  Depth extends number = 10,
> = A extends [infer T, ...infer Rest]
  ? T extends [infer L, infer R]
    ? Transposed extends [infer PL, infer PR]
      ? PL extends unknown[] ? PR extends unknown[] ? Transpose<Rest, [[...PL, L], [...PR, R]], Prev[Depth]>
        : never
      : never
    : Transpose<Rest, [[L], [R]], Prev[Depth]>
  : Transposed
  : Transposed

// Combines the both sides of the array of the results into a tuple of the
// union of the ok types and the union of the err types.
//
// T     - The array of the results
// Depth - The maximum depth.
export type Combine<T, Depth extends number = 5> = Transpose<CollectResults<T>, [], Depth> extends [
  infer L,
  infer R,
] ? [UnknownMembersToNever<L>, UnknownMembersToNever<R>]
  : Transpose<CollectResults<T>, [], Depth> extends [] ? [[], []]
  : never

// Deduplicates the result, as the result type is a union of Err and Ok types.
export type Dedup<T> = T extends Result<infer RL, infer RR> ? Result<RL, RR>
  : T

// Given a union, this gives the array of the union members.
export type MemberListOf<T> = (
  (T extends unknown ? (t: T) => T : never) extends infer U
    ? (U extends unknown ? (u: U) => unknown : never) extends (v: infer V) => unknown ? V
    : never
    : never
) extends (_: unknown) => infer W ? [...MemberListOf<Exclude<T, W>>, W]
  : []

// Converts an empty array to never.
//
// The second type parameter here will affect how to behave to `never[]`s.
// If a precise type is required, pass `1` here so that it will resolve
// a literal array such as `[ never, never ]`. Otherwise, set `0` or the default
// type value will cause this to resolve the arrays containing only `never`
// items as `never` only.
export type EmptyArrayToNever<T, NeverArrayToNever extends number = 0> = T extends [] ? never
  : NeverArrayToNever extends 1 ? T extends [never, ...infer Rest] ? [EmptyArrayToNever<Rest>] extends [never] ? never
      : T
    : T
  : T

// Converts the `unknown` items of an array to `never`s.
type UnknownMembersToNever<T> = T extends [infer H, ...infer R]
  ? [[unknown] extends [H] ? never : H, ...UnknownMembersToNever<R>]
  : T

// Gets the member type of the array or never.
export type MembersToUnion<T> = T extends unknown[] ? T[number] : never

// Checks if the given type is a literal array.
export type IsLiteralArray<T> = T extends { length: infer L } ? L extends number ? number extends L ? 0
    : 1
  : 0
  : 0

// Traverses an array of results and returns a single result containing
// the oks and errs union-ed/combined.
type Traverse<T, Depth extends number = 5> = Combine<T, Depth> extends [infer Oks, infer Errs]
  ? Result<EmptyArrayToNever<Oks, 1>, MembersToUnion<Errs>>
  : never

// Traverses an array of results and returns a single result containing
// the oks combined and the array of errors combined.
type TraverseWithAllErrors<T, Depth extends number = 5> = Combine<T, Depth> extends [
  infer Oks,
  infer Errs,
] ? Result<EmptyArrayToNever<Oks>, EmptyArrayToNever<Errs>>
  : never

export type CombineResults<
  T extends readonly Result<unknown, unknown>[],
> = IsLiteralArray<T> extends 1 ? Traverse<T>
  : Result<ExtractOkTypes<T>, ExtractErrTypes<T>[number]>

// Combines the array of results into one result with all errors.
export type CombineResultsWithAllErrorsArray<
  T extends readonly Result<unknown, unknown>[],
> = IsLiteralArray<T> extends 1 ? TraverseWithAllErrors<T>
  : Result<ExtractOkTypes<T>, ExtractErrTypes<T>[number][]>
