import type { Combine, Dedup, EmptyArrayToNever, IsLiteralArray, MemberListOf, MembersToUnion } from './result.js'
import { Result } from './result.js'
import type {
  ExtractErrAsyncTypes,
  ExtractOkAsyncTypes,
  InferAsyncErrTypes,
  InferAsyncOkTypes,
  InferErrTypes,
  InferOkTypes,
} from './utils.js'
import { combineResultAsyncList, combineResultAsyncListWithAllErrors } from './utils.js'

export class DisposableResultAsync<T, E> implements PromiseLike<Result<T, E>> {
  private readonly innerPromise: Promise<Result<T, E>>

  constructor(res: Promise<Result<T, E>>) {
    this.innerPromise = res
  }

  then<A, B>( // eslint-disable-line unicorn/no-thenable
    successCallback?: (res: Result<T, E>) => A | PromiseLike<A>,
    failureCallback?: (reason: unknown) => B | PromiseLike<B>,
  ): PromiseLike<A | B> {
    return this.innerPromise.then(successCallback, failureCallback)
  }
}

/**
 * The ResultAsync type.
 * This is a union of `Result` and `PromiseLike<Result>`
 */
export class ResultAsync<T, E> implements PromiseLike<Result<T, E>> {
  /**
   * Returns a ResultAsync instance that is immediately resolved with a Result.ok(value).
   *
   * @param {T} value - The value to be wrapped in a Result.ok.
   * @return {ResultAsync<T, E>} A ResultAsync instance with the given value and error type E.
   */
  static okAsync<T, E = never>(value: T): ResultAsync<T, E> {
    return new ResultAsync<T, E>(Promise.resolve(Result.ok(value)))
  }

  /**
   * Returns a ResultAsync that is immediately resolved with a Result.ok(undefined) value.
   *
   * @return {ResultAsync<undefined, E>} A ResultAsync instance with undefined as the value type and E as the error type.
   */
  static unitAsync<E = never>(): ResultAsync<undefined, E> {
    return new ResultAsync<undefined, E>(Promise.resolve(Result.unit()))
  }

  /**
   * Returns a ResultAsync instance that is immediately resolved with a Result.err(error).
   *
   * @param {E} error - The error to be wrapped in a Result.err.
   * @return {ResultAsync<T, E>} A ResultAsync instance with the given error and value type T.
   */
  static errAsync<T = never, E = unknown>(error: E): ResultAsync<T, E> {
    return new ResultAsync<T, E>(Promise.resolve(Result.err(error)))
  }

  /**
   * Returns a ResultAsync instance that is resolved with a Result.ok(value) or Result.err(error)
   * based on the provided promise.
   *
   * @param {Promise<T>} promise - The promise to be wrapped in a ResultAsync.
   * @return {ResultAsync<T, E>} A ResultAsync instance with the given promise and error type E.
   */
  static fromSafePromise<T, E = never>(promise: PromiseLike<T>): ResultAsync<T, E>
  static fromSafePromise<T, E = never>(promise: Promise<T>): ResultAsync<T, E> {
    const newPromise = promise
      .then((value: T) => Result.ok(value))

    return new ResultAsync<T, E>(newPromise)
  }

  /**
   * Returns a ResultAsync instance that is resolved with a Result.ok(value) or Result.err(error)
   * based on the provided promise.
   *
   * @param {Promise<T>} promise - The promise to be wrapped in a ResultAsync.
   * @param {(e: unknown) => E} errorFn - A function that transforms the error from the promise into the error type E.
   * @return {ResultAsync<T, E>} A ResultAsync instance with the given promise and error type E.
   */
  static fromPromise<T, E>(promise: PromiseLike<T>, errorFn: (e: unknown) => E): ResultAsync<T, E>
  static fromPromise<T, E>(promise: Promise<T>, errorFn: (e: unknown) => E): ResultAsync<T, E> {
    const newPromise = promise
      .then((value: T) => Result.ok(value))
      .catch(error => Result.err(errorFn(error)))

    return new ResultAsync<T, E>(newPromise)
  }

  static combine<
    T extends readonly [ResultAsync<unknown, unknown>, ...Array<ResultAsync<unknown, unknown>>],
  >(asyncResultList: T): CombineResultAsyncs<T>
  static combine<T extends ReadonlyArray<ResultAsync<unknown, unknown>>>(
    asyncResultList: T,
  ): CombineResultAsyncs<T>
  static combine<T extends ReadonlyArray<ResultAsync<unknown, unknown>>>(
    asyncResultList: T,
  ): CombineResultAsyncs<T> {
    return (combineResultAsyncList(asyncResultList) as unknown) as CombineResultAsyncs<T>
  }

  static combineWithAllErrors<
    T extends readonly [ResultAsync<unknown, unknown>, ...Array<ResultAsync<unknown, unknown>>],
  >(asyncResultList: T): CombineResultsWithAllErrorsArrayAsync<T>
  static combineWithAllErrors<T extends ReadonlyArray<ResultAsync<unknown, unknown>>>(
    asyncResultList: T,
  ): CombineResultsWithAllErrorsArrayAsync<T>
  static combineWithAllErrors<T extends ReadonlyArray<ResultAsync<unknown, unknown>>>(
    asyncResultList: T,
  ): CombineResultsWithAllErrorsArrayAsync<T> {
    return combineResultAsyncListWithAllErrors(
      asyncResultList,
    ) as CombineResultsWithAllErrorsArrayAsync<T>
  }

  /**
   * Wraps a async function with a try catch, creating a new function with the same
   * arguments but returning `Ok` if successful, `Err` if the function throws
   *
   * @param fn function to wrap with ok on success or err on failure
   * @param errorFn when an error is thrown, this will wrap the error result if provided
   * @returns a new function that returns a `ResultAsync`
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static fromThrowable<A extends readonly any[], T, E>(
    fn: (...args: A) => Promise<T>,
    errorFn?: (err: unknown) => E,
  ): (...args: A) => ResultAsync<T, E> {
    return (...args) =>
      new ResultAsync<T, E>(
        (async () => {
          try {
            const v = await fn(...args)
            return Result.ok(v)
          } catch (error) {
            const e = errorFn ? errorFn(error) : error
            return Result.err(e as E)
          }
        })(),
      )
  }

  private readonly innerPromise: Promise<Result<T, E>>

  constructor(res: Promise<Result<T, E>>) {
    this.innerPromise = res
  }

  then<A, B>( // eslint-disable-line unicorn/no-thenable
    successCallback?: (res: Result<T, E>) => A | PromiseLike<A>,
    failureCallback?: (reason: unknown) => B | PromiseLike<B>,
  ): PromiseLike<A | B> {
    return this.innerPromise.then(successCallback, failureCallback)
  }

  mapErr<U>(f: (t: E) => U | Promise<U>): ResultAsync<T, U> {
    return new ResultAsync<T, U>(this.innerPromise.then(async res => {
      if (res.isOk()) {
        return okAsync(res.value)
      }

      return errAsync(await f(res.error))
    }))
  }

  map<X>(f: (t: T) => X | Promise<X>): ResultAsync<X, E> {
    const x = new ResultAsync(
      this.innerPromise.then(async (res: Result<T, E>) => {
        if (res.isErr()) {
          return errAsync(res.error)
        }

        return okAsync(await f(res.value))
      }),
    )

    return x
  }

  andThen<R extends Result<unknown, unknown>>(
    f: (t: T) => R,
  ): ResultAsync<InferOkTypes<R>, InferErrTypes<R> | E>
  andThen<R extends ResultAsync<unknown, unknown>>(
    f: (t: T) => R,
  ): ResultAsync<InferAsyncOkTypes<R>, InferAsyncErrTypes<R> | E>
  andThen<U, F>(f: (t: T) => Result<U, F> | ResultAsync<U, F>): ResultAsync<U, E | F>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  andThen(f: any): any {
    return new ResultAsync(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      this.innerPromise.then(async res => {
        if (res.isErr()) {
          return errAsync(res.error)
        }

        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const newValue = f(res.value) // eslint-disable-line @typescript-eslint/no-unsafe-assignment
        return newValue instanceof ResultAsync ? newValue.innerPromise : newValue // eslint-disable-line @typescript-eslint/no-unsafe-return
      }),
    )
  }

  if(fCondition: (t: T) => boolean) {
    return {
      true: <X1, Y1>(fTrue: (t: T) => ResultAsync<X1, Y1>) => ({
        false: <X2, Y2>(fFalse: (t: T) => ResultAsync<X2, Y2>): ResultAsync<X1 | X2, Y1 | Y2 | E> =>
          new ResultAsync(this.innerPromise.then(async res => {
            if (res.isOk()) {
              const condition = fCondition(res.value)
              return condition ? fTrue(res.value) : fFalse(res.value)
            }

            return errAsync(res.error)
          })),
      }),
    }
  }

  orElse<R extends Result<unknown, unknown>>(
    f: (e: E) => R,
  ): ResultAsync<InferOkTypes<R> | T, InferErrTypes<R>>
  orElse<R extends ResultAsync<unknown, unknown>>(
    f: (e: E) => R,
  ): ResultAsync<InferAsyncOkTypes<R> | T, InferAsyncErrTypes<R>>
  orElse<U, A>(f: (e: E) => Result<U, A> | ResultAsync<U, A>): ResultAsync<U | T, A>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orElse(f: any): any {
    return new ResultAsync(
      this.innerPromise.then(async (res: Result<T, E>) => { // eslint-disable-line @typescript-eslint/no-unsafe-argument
        if (res.isErr()) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call
          return f(res.error) // eslint-disable-line @typescript-eslint/no-unsafe-return
        }

        return okAsync(res.value)
      }),
    )
  }

  async match<X>(ok: (t: T) => X, err: (e: E) => X): Promise<X> {
    return this.innerPromise.then(res => res.match(ok, err))
  }

  async unwrapOr<A>(t: A): Promise<T | A> {
    return this.innerPromise.then(res => res.unwrapOr(t))
  }

  /**
   * Performs a side effect for the `Ok` variant of `ResultAsync`.
   * This function can be used for control flow based on result values.
   * @param f The function to call if the result is `Ok`
   * @returns `self` if the result is `Err`, otherwise the result of `f`
   */
  log(f: (t?: T, e?: E) => void | Promise<void>): ResultAsync<T, E> {
    return new ResultAsync(
      this.innerPromise.then(async res => {
        if (res.isOk()) {
          try {
            await f(res.value)
          } catch { /* empty */ }

          return okAsync(res.value)
        }

        try {
          await f(undefined, res.error)
        } catch { /* empty */ }

        return errAsync(res.error)
      }),
    )
  }

  /**
   * Performs a side effect for the `Ok` variant of `ResultAsync`.
   * This function can be used for control flow based on result values.
   * @param f The function to call if the result is `Ok`
   * @returns `self` if the result is `Err`, otherwise the result of `f`
   */
  tap(f: (t: T) => void | Promise<void>): ResultAsync<T, E> {
    return new ResultAsync(
      this.innerPromise.then(async res => {
        if (res.isErr()) {
          return errAsync(res.error)
        }

        try {
          await f(res.value)
        } catch { /* empty */ }

        return okAsync(res.value)
      }),
    )
  }

  /**
   * Performs a side effect for the `Err` variant of `ResultAsync`.
   * This function can be used for control flow based on result values.
   * @param f The function to call if the result is `Err`
   * @returns `self` if the result is `Ok`, otherwise the result of `f`
   * @example
   */
  tapError(f: (e: E) => void | Promise<void>): ResultAsync<T, E> {
    return new ResultAsync(
      this.innerPromise.then(async res => {
        if (res.isErr()) {
          try {
            await f(res.error)
          } catch { /* empty */ }

          return errAsync(res.error)
        }

        return okAsync(res.value)
      }),
    )
  }

  finally(f: (value: T, error: E) => void): DisposableResultAsync<T, E> {
    return new DisposableResultAsync(
      // eslint-disable-next-line @typescript-eslint/require-await
      this.innerPromise.then(async res => {
        try {
          res.finally(f)
        } catch {
          // Dont do anything. Its just a finally
        }

        return res
      }),
    )
  }

  /**
   * Emulates Rust's `?` operator in `safeTry`'s body. See also `safeTry`.
   */
  async *safeUnwrap(): AsyncGenerator<Result<never, E>, T> {
    return yield* await this.innerPromise.then(res => res.safeUnwrap())
  }
}

// eslint-disable-next-line @typescript-eslint/unbound-method
export const { okAsync, errAsync, fromPromise, fromSafePromise, unitAsync } = ResultAsync
// eslint-disable-next-line @typescript-eslint/unbound-method
export const fromThrowableAsync = ResultAsync.fromThrowable

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
 * @returns The first occurence of either an yielded Err or a returned `ResultAsync`.
 */
export function safeTryAsync<T, E>(
  body: () => AsyncGenerator<Result<never, E>, Result<T, E>>,
): ResultAsync<T, E> {
  return new ResultAsync<T, E>(
    (async () => {
      const n = await body().next()
      if (n.value.isOk()) {
        return okAsync(n.value.value)
      }

      return errAsync(n.value.error)
    })(),
  )
}

// Combines the array of async results into one result.
export type CombineResultAsyncs<
  T extends ReadonlyArray<ResultAsync<unknown, unknown>>,
> = IsLiteralArray<T> extends 1 ? TraverseAsync<UnwrapAsync<T>>
  : ResultAsync<ExtractOkAsyncTypes<T>, ExtractErrAsyncTypes<T>[number]>

// Combines the array of async results into one result with all errors.
export type CombineResultsWithAllErrorsArrayAsync<
  T extends ReadonlyArray<ResultAsync<unknown, unknown>>,
> = IsLiteralArray<T> extends 1 ? TraverseWithAllErrorsAsync<UnwrapAsync<T>>
  : ResultAsync<ExtractOkAsyncTypes<T>, Array<ExtractErrAsyncTypes<T>[number]>>

// Unwraps the inner `Result` from a `ResultAsync` for all elements.
type UnwrapAsync<T> = IsLiteralArray<T> extends 1
  ? Writable<T> extends [infer H, ...infer Rest]
    ? H extends PromiseLike<infer HI> ? HI extends Result<unknown, unknown> ? [Dedup<HI>, ...UnwrapAsync<Rest>]
      : never
    : never
  : []
  // If we got something too general such as ResultAsync<X, Y>[] then we
  // simply need to map it to ResultAsync<X[], Y[]>. Yet `ResultAsync`
  // itself is a union therefore it would be enough to cast it to Ok.
  : T extends Array<infer A>
    ? A extends PromiseLike<infer HI> ? HI extends Result<infer L, infer R> ? Array<Result<L, R>>
      : never
    : never
  : never

// Traverse through the tuples of the async results and create one
// `ResultAsync` where the collected tuples are merged.
type TraverseAsync<T, Depth extends number = 5> = IsLiteralArray<T> extends 1
  ? Combine<T, Depth> extends [infer Oks, infer Errs] ? ResultAsync<EmptyArrayToNever<Oks>, MembersToUnion<Errs>>
  : never
  // The following check is important if we somehow reach to the point of
  // checking something similar to ResultAsync<X, Y>[]. In this case we don't
  // know the length of the elements, therefore we need to traverse the X and Y
  // in a way that the result should contain X[] and Y[].
  : T extends Array<infer I>
  // The MemberListOf<I> here is to include all possible types. Therefore
  // if we face (ResultAsync<X, Y> | ResultAsync<A, B>)[] this type should
  // handle the case.
    ? Combine<MemberListOf<I>, Depth> extends [infer Oks, infer Errs]
      // The following `extends unknown[]` checks are just to satisfy the TS.
      // we already expect them to be an array.
      ? Oks extends unknown[]
        ? Errs extends unknown[]
          ? ResultAsync<EmptyArrayToNever<Array<Oks[number]>>, MembersToUnion<Array<Errs[number]>>>
        : ResultAsync<EmptyArrayToNever<Array<Oks[number]>>, Errs>
        // The rest of the conditions are to satisfy the TS and support
        // the edge cases which are not really expected to happen.
      : Errs extends unknown[] ? ResultAsync<Oks, MembersToUnion<Array<Errs[number]>>>
      : ResultAsync<Oks, Errs>
    : never
  : never

// This type is similar to the `TraverseAsync` while the errors are also
// collected in order. For the checks/conditions made here, see that type
// for the documentation.
type TraverseWithAllErrorsAsync<T, Depth extends number = 5> = IsLiteralArray<T> extends 1
  ? Combine<T, Depth> extends [infer Oks, infer Errs] ? ResultAsync<EmptyArrayToNever<Oks>, EmptyArrayToNever<Errs>>
  : never
  : Writable<T> extends Array<infer I>
    ? Combine<MemberListOf<I>, Depth> extends [infer Oks, infer Errs]
      ? Oks extends unknown[]
        ? Errs extends unknown[]
          ? ResultAsync<EmptyArrayToNever<Array<Oks[number]>>, EmptyArrayToNever<Array<Errs[number]>>>
        : ResultAsync<EmptyArrayToNever<Array<Oks[number]>>, Errs>
      : Errs extends unknown[] ? ResultAsync<Oks, EmptyArrayToNever<Array<Errs[number]>>>
      : ResultAsync<Oks, Errs>
    : never
  : never

// Converts a reaodnly array into a writable array
type Writable<T> = T extends readonly unknown[] ? [...T] : T
