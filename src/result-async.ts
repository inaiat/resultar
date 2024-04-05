import {
  Result,
} from './result.js'

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
  ): ResultAsync<R, R | E>
  andThen<R extends ResultAsync<unknown, unknown>>(
    f: (t: T) => R,
  ): ResultAsync<R, R | E>
  andThen<X, Y>(f: (t: T) => ResultAsync<X, Y>): ResultAsync<X, E | Y>
  andThen<X, Y>(f: (t: T) => ResultAsync<X, E>): ResultAsync<X, E | Y> {
    return new ResultAsync<X, E | Y>(
      this.innerPromise.then(async res => {
        if (res.isErr()) {
          return errAsync(res.error)
        }

        const newValue = f(res.value)
        return newValue instanceof ResultAsync ? newValue.innerPromise : newValue
      }),
    )
  }

  async match<X>(ok: (t: T) => X, _err: (e: E) => X): Promise<X> {
    return this.innerPromise.then(res => res.match(ok, _err))
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

