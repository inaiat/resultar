/* eslint-disable @typescript-eslint/ban-types */

import {
  Result,
} from './result.js'
import {
  Combine,
  Dedup,
  EmptyArrayToNever,
  ExtractErrAsyncTypes,
  ExtractOkAsyncTypes,
  InferAsyncErrTypes, InferAsyncOkTypes, InferErrTypes, InferOkTypes,
  IsLiteralArray,
  MemberListOf,
  MembersToUnion,
  combineResultAsyncList,
  combineResultAsyncListWithAllErrors,
} from './utils.js'

// Combines the array of async results into one result.
export type CombineResultAsyncs<
  T extends ReadonlyArray<ResultAsync<unknown, unknown>>,
> = IsLiteralArray<T> extends 1
  ? TraverseAsync<UnwrapAsync<T>>
  : ResultAsync<ExtractOkAsyncTypes<T>, ExtractErrAsyncTypes<T>[number]>

// Combines the array of async results into one result with all errors.
export type CombineResultsWithAllErrorsArrayAsync<
  T extends ReadonlyArray<ResultAsync<unknown, unknown>>,
> = IsLiteralArray<T> extends 1
  ? TraverseWithAllErrorsAsync<UnwrapAsync<T>>
  : ResultAsync<ExtractOkAsyncTypes<T>, Array<ExtractErrAsyncTypes<T>[number]>>

// Unwraps the inner `Result` from a `ResultAsync` for all elements.
type UnwrapAsync<T> = IsLiteralArray<T> extends 1
  ? Writable<T> extends [infer H, ...infer Rest]
    ? H extends PromiseLike<infer HI>
      ? HI extends Result<unknown, unknown>
        ? [Dedup<HI>, ...UnwrapAsync<Rest>]
        : never
      : never
    : []
  : // If we got something too general such as ResultAsync<X, Y>[] then we
  // simply need to map it to ResultAsync<X[], Y[]>. Yet `ResultAsync`
  // itself is a union therefore it would be enough to cast it to Ok.
  T extends Array<infer A>
    ? A extends PromiseLike<infer HI>
      ? HI extends Result<infer L, infer R>
        ? Array<Result<L, R>>
        : never
      : never
    : never

// Traverse through the tuples of the async results and create one
// `ResultAsync` where the collected tuples are merged.
type TraverseAsync<T, Depth extends number = 5> = IsLiteralArray<T> extends 1
  ? Combine<T, Depth> extends [infer Oks, infer Errs]
    ? ResultAsync<EmptyArrayToNever<Oks>, MembersToUnion<Errs>>
    : never
  : // The following check is important if we somehow reach to the point of
  // checking something similar to ResultAsync<X, Y>[]. In this case we don't
  // know the length of the elements, therefore we need to traverse the X and Y
  // in a way that the result should contain X[] and Y[].
  T extends Array<infer I>
    ? // The MemberListOf<I> here is to include all possible types. Therefore
  // if we face (ResultAsync<X, Y> | ResultAsync<A, B>)[] this type should
  // handle the case.
    Combine<MemberListOf<I>, Depth> extends [infer Oks, infer Errs]
      ? // The following `extends unknown[]` checks are just to satisfy the TS.
    // we already expect them to be an array.
      Oks extends unknown[]
        ? Errs extends unknown[]
          ? ResultAsync<EmptyArrayToNever<Array<Oks[number]>>, MembersToUnion<Array<Errs[number]>>>
          : ResultAsync<EmptyArrayToNever<Array<Oks[number]>>, Errs>
        : // The rest of the conditions are to satisfy the TS and support
      // the edge cases which are not really expected to happen.
        Errs extends unknown[]
          ? ResultAsync<Oks, MembersToUnion<Array<Errs[number]>>>
          : ResultAsync<Oks, Errs>
      : never
    : never

// This type is similar to the `TraverseAsync` while the errors are also
// collected in order. For the checks/conditions made here, see that type
// for the documentation.
type TraverseWithAllErrorsAsync<T, Depth extends number = 5> = IsLiteralArray<T> extends 1
  ? Combine<T, Depth> extends [infer Oks, infer Errs]
    ? ResultAsync<EmptyArrayToNever<Oks>, EmptyArrayToNever<Errs>>
    : never
  : Writable<T> extends Array<infer I>
    ? Combine<MemberListOf<I>, Depth> extends [infer Oks, infer Errs]
      ? Oks extends unknown[]
        ? Errs extends unknown[]
          ? ResultAsync<EmptyArrayToNever<Array<Oks[number]>>, EmptyArrayToNever<Array<Errs[number]>>>
          : ResultAsync<EmptyArrayToNever<Array<Oks[number]>>, Errs>
        : Errs extends unknown[]
          ? ResultAsync<Oks, EmptyArrayToNever<Array<Errs[number]>>>
          : ResultAsync<Oks, Errs>
      : never
    : never

// Converts a reaodnly array into a writable array
type Writable<T> = T extends readonly unknown[] ? [...T] : T

export class ResultAsync<T, E> implements PromiseLike<Result<T, E>> {
  static fromSafePromise<T, E = never>(promise: PromiseLike<T>): ResultAsync<T, E>
  static fromSafePromise<T, E = never>(promise: Promise<T>): ResultAsync<T, E> {
    const newPromise = promise
      .then((value: T) => Result.ok(value))

    return new ResultAsync<T, E>(newPromise)
  }

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
  andThen(f: any): any {
    return new ResultAsync(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      this.innerPromise.then(async res => {
        if (res.isErr()) {
          return errAsync(res.error)
        }

        const newValue = f(res.value) // eslint-disable-line @typescript-eslint/no-unsafe-assignment
        return newValue instanceof ResultAsync ? newValue.innerPromise : newValue // eslint-disable-line @typescript-eslint/no-unsafe-return
      }),
    )
  }

  orElse<R extends Result<unknown, unknown>>(
    f: (e: E) => R,
  ): ResultAsync<InferOkTypes<R> | T, InferErrTypes<R>>
  orElse<R extends ResultAsync<unknown, unknown>>(
    f: (e: E) => R,
  ): ResultAsync<InferAsyncOkTypes<R> | T, InferAsyncErrTypes<R>>
  orElse<U, A>(f: (e: E) => Result<U, A> | ResultAsync<U, A>): ResultAsync<U | T, A>
  orElse(f: any): any {
    return new ResultAsync(
      this.innerPromise.then(async (res: Result<T, E>) => { // eslint-disable-line @typescript-eslint/no-unsafe-argument
        if (res.isErr()) {
          return f(res.error) // eslint-disable-line @typescript-eslint/no-unsafe-return
        }

        return okAsync(res.value)
      }),
    )
  }

  async match<X>(ok: (t: T) => X, _err: (e: E) => X): Promise<X> {
    return this.innerPromise.then(res => res.match(ok, _err))
  }

  async unwrapOr<A>(t: A): Promise<T | A> {
    return this.innerPromise.then(res => res.unwrapOr(t))
  }

  tap(f: (t: T) => void | Promise<void>): ResultAsync<T, E> {
    return new ResultAsync(
      this.innerPromise.then(async res => {
        if (res.isErr()) {
          return errAsync(res.error)
        }

        try {
          await f(res.value)
        } catch {
          // Dont do anything. Its just a tap
        }

        return okAsync(res.value)
      }),
    )
  }

  /**
   * Emulates Rust's `?` operator in `safeTry`'s body. See also `safeTry`.
   */
  async * safeUnwrap(): AsyncGenerator<Result<never, E>, T> {
    return yield * await this.innerPromise.then(res => res.safeUnwrap())
  }
}

export function fromSafePromise<T, E = never>(promise: PromiseLike<T>): ResultAsync<T, E>
export function fromSafePromise<T, E = never>(promise:
| PromiseLike<T>
| Promise<T>): ResultAsync<T, E> {
  return ResultAsync.fromSafePromise(promise)
}

export function fromPromise<T, E>(promise: PromiseLike<T>, errorFn: (e: unknown) => E): ResultAsync<T, E>
export function fromPromise<T, E>(promise:
| PromiseLike<T>
| Promise<T>, errorFn: (e: unknown) => E): ResultAsync<T, E> {
  return ResultAsync.fromPromise(promise, errorFn)
}

export function okAsync<T, E = never>(value: T): ResultAsync<T, E> {
  return new ResultAsync<T, E>(Promise.resolve(Result.ok(value)))
}

export function errAsync<T = never, E = unknown>(error: E): ResultAsync<T, E> {
  return new ResultAsync<T, E>(Promise.resolve(Result.err(error)))
}

export function fromThrowableAsync<A extends readonly any[], T, E>(
  fn: (...args: A) => Promise<T>,
  errorFn?: (err: unknown) => E,
): (...args: A) => ResultAsync<T, E> {
  return (...args) => new ResultAsync<T, E>(
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

