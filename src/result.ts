import {
  CombineResults, CombineResultsWithAllErrorsArray, InferErrTypes, InferOkTypes, combineResultList, combineResultListWithAllErrors,
} from './utils.js'
import { ErrorConfig, createResultarError } from './error.js'
import { ResultAsync, errAsync } from './result-async.js'

class Ok<T> {
  readonly ok = true // eslint-disable-line @typescript-eslint/class-literal-property-style
  constructor(public readonly value: T) {}
}

class Err<E> {
  readonly ok = false // eslint-disable-line @typescript-eslint/class-literal-property-style
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
  static fromThrowable<Fn extends (...args: readonly any[]) => unknown, E>(
    fn: Fn,
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

  static ok<T, E=never>(value: T): Result<T, E> {
    return new Result<T, E>(new Ok(value))
  }

  static err<T=never, E=unknown>(error: E): Result<T, E> {
    return new Result<T, E>(new Err(error))
  }

  static combine<
    T extends readonly [Result<unknown, unknown>, ...Array<Result<unknown, unknown>>],
  >(resultList: T): CombineResults<T>
  static combine<T extends ReadonlyArray<Result<unknown, unknown>>>(
    resultList: T,
  ): CombineResults<T>
  static combine<
    T extends readonly [Result<unknown, unknown>, ...Array<Result<unknown, unknown>>],
  >(resultList: T): CombineResults<T> {
    return combineResultList(resultList) as CombineResults<T>
  }

  static combineWithAllErrors<
    T extends readonly [Result<unknown, unknown>, ...Array<Result<unknown, unknown>>],
  >(resultList: T): CombineResultsWithAllErrorsArray<T>
  static combineWithAllErrors<T extends ReadonlyArray<Result<unknown, unknown>>>(
    resultList: T,
  ): CombineResultsWithAllErrorsArray<T>
  static combineWithAllErrors<T extends ReadonlyArray<Result<unknown, unknown>>>(
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
   *
   * @param f  A function to apply to an `Err` value, leaving `Ok` values
   * untouched.
   */
  orElse<R extends Result<unknown, unknown>>(
    f: (e: E) => R,
  ): Result<InferOkTypes<R> | T, InferErrTypes<R>>
  orElse<U, A>(f: (e: E) => Result<U, A>): Result<U | T, A> {
    if (this.state.ok) {
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
   *
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
   * Performs a side effect for the `Ok` variant of `Result`.
   *
   * @param fn The function to apply an `OK` value
   * @returns the result of applying `f` or an `Err` untouched
   */
  tap(fn: (t: T) => void): Result<T, E> {
    if (this.state.ok) {
      try {
        fn(this.value)
      } catch {}

      return ok(this.value)
    }

    return err(this.error)
  }

  /**
   * Performs a side effect for the `Err` variant of `Result`.
   *
   * @param fn The function to apply an `Err` value
   * @returns the result of applying `f` or an `Ok` untouched
   */
  tapError(fn: (e: E) => void): Result<T, E> {
    if (this.state.ok) {
      return ok(this.value)
    }

    try {
      fn(this.error)
    } catch {}

    return err(this.error)
  }

  /**
   * This method is used to clean up and release any resources that the `Result`
   * @param f The function that will be called to clean up the resources
   */
  finally<X=T, Y=E>(f: (value: X, error: Y) => void): DisposableResult<X, Y>
  finally(f: (value: T, error: E) => void): DisposableResult<T, E> {
    const resultDisposable = new DisposableResult(this, f)
    try {
      return resultDisposable
    } finally {
      resultDisposable[Symbol.dispose]() // eslint-disable-line no-use-extend-native/no-use-extend-native
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

    throw createResultarError('Called `_unsafeUnwrap` on an Err', this, config) // eslint-disable-line @typescript-eslint/no-throw-literal
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
      throw createResultarError('Called `_unsafeUnwrapErr` on an Ok', this, config) // eslint-disable-line @typescript-eslint/no-throw-literal
    }

    return this.error
  }

  safeUnwrap(): Generator<Result<never, E>, T> {
    if (this.state.ok) {
      const { value } = this
      /* eslint-disable-next-line require-yield */
      return (function * () {
        return value
      })()
    }

    const { error } = this
    return (function * () {
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
  constructor(readonly result: Resultable<T, E>,
    private readonly finalizer: (value: T, error: E) => void) {}

  get value(): T {
    return this.result.value
  }

  get error(): E {
    return this.result.error
  }

  _unsafeUnwrap(config?: ErrorConfig | undefined): T {
    return this.result._unsafeUnwrap(config)
  }

  _unsafeUnwrapErr(config?: ErrorConfig | undefined): E {
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

export const { ok, err, fromThrowable } = Result

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
// NOTE:
// Since body is potentially throwable because `await` can be used in it,
// Promise<Result<T, E>>, not ResultAsync<T, E>, is used as the return type.
export function safeTry<T, E>(
  body: () => AsyncGenerator<Result<never, E>, Result<T, E>>,
): Promise<Result<T, E>>
export function safeTry<T, E>(
  body:
  | (() => Generator<Result<never, E>, Result<T, E>>)
  | (() => AsyncGenerator<Result<never, E>, Result<T, E>>),
): Result<T, E> | Promise<Result<T, E>> {
  const n = body().next()
  if (n instanceof Promise) {
    return n.then(r => r.value)
  }

  return n.value
}

