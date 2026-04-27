/* eslint-disable @typescript-eslint/unbound-method, class-methods-use-this */
import { type ErrorConfig, createResultarError } from './error.js'
import { ResultAsync, errAsync } from './result-async.js'
import {
  type ExtractErrTypes,
  type ExtractOkTypes,
  type InferErrTypes,
  type InferOkTypes,
  combineResultList,
  combineResultListWithAllErrors,
} from './utils.js'

type TaggedValue = { readonly _tag: string }
type TaggedErrorValue = Error & TaggedValue
type TagsOf<E> = Extract<E, TaggedValue>['_tag']
type ErrorTagsOf<E> = Extract<E, TaggedErrorValue>['_tag']
type ErrorForTag<E, Tag extends string> = Extract<E, { readonly _tag: Tag }>
type ExcludeTag<E, Tag extends string> = Exclude<E, { readonly _tag: Tag }>
type UntaggedError<E> = Exclude<Extract<E, Error>, TaggedErrorValue>
type CatchTagHandlerResult<Handlers> = {
  readonly [Key in keyof Handlers]: Handlers[Key] extends (...args: infer _Args) => infer R
    ? R
    : never
}[keyof Handlers]
type MatchTagHandlerResult<Handlers> = {
  readonly [Key in keyof Handlers]: Handlers[Key] extends (...args: infer _Args) => infer R
    ? R
    : never
}[keyof Handlers]
type CatchTagHandlers<E, Handlers> = {
  readonly [Tag in keyof Handlers]: Tag extends TagsOf<E>
    ? (error: ErrorForTag<E, Tag & string>) => Result<unknown, unknown>
    : never
}
type MatchTagHandlers<E, Handlers> = {
  readonly [Tag in ErrorTagsOf<E>]: (error: ErrorForTag<E, Tag>) => unknown
} & ([UntaggedError<E>] extends [never]
  ? { readonly Error?: (error: Error) => unknown }
  : { readonly Error: (error: UntaggedError<E>) => unknown }) & {
    readonly [Tag in keyof Handlers]: Tag extends ErrorTagsOf<E> | 'Error' ? Handlers[Tag] : never
  }
type PipeFn<Input, Output> = (input: Input) => Output

const hasTag = <Tag extends string>(value: unknown, tag: Tag): value is { readonly _tag: Tag } =>
  typeof value === 'object' && value !== null && '_tag' in value && value._tag === tag

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

export interface ResultOperations<T, E> {
  isOk(): this is OkResult<T, E>
  isErr(): this is ErrResult<T, E>
  unwrapOr<A>(defaultValue: A): T | A
  _unsafeUnwrap(config?: ErrorConfig): T
  _unsafeUnwrapErr(config?: ErrorConfig): E
  map<X>(f: (t: T) => X): Result<X, E>
  filterOrElse<U extends T, F>(
    predicate: (value: T) => value is U,
    onFalse: (value: T) => F,
  ): Result<U, E | F>
  filterOrElse<F>(predicate: (value: T) => boolean, onFalse: (value: T) => F): Result<T, E | F>
  mapErr<X>(fn: (t: E) => X): Result<T, X>
  andThen<X, Y>(f: (t: T) => Result<X, Y>): Result<X, E | Y>
  if(fCondition: (t: T) => boolean): {
    true: <X1, Y1>(
      fTrue: (t: T) => Result<X1, Y1>,
    ) => { false: <X2, Y2>(fFalse: (t: T) => Result<X2, Y2>) => Result<X1 | X2, Y1 | Y2 | E> }
  }
  orElse<R extends Result<unknown, unknown>>(
    f: (e: E) => R,
  ): Result<InferOkTypes<R> | T, InferErrTypes<R>>
  catchTag<const Tag extends TagsOf<E>, R extends Result<unknown, unknown>>(
    tag: Tag,
    f: (error: ErrorForTag<E, Tag>) => R,
  ): Result<T | InferOkTypes<R>, ExcludeTag<E, Tag> | InferErrTypes<R>>
  catchTags<const Handlers extends object>(
    handlers: Handlers & CatchTagHandlers<E, Handlers>,
  ): Result<
    T | InferOkTypes<CatchTagHandlerResult<Handlers>>,
    ExcludeTag<E, keyof Handlers & string> | InferErrTypes<CatchTagHandlerResult<Handlers>>
  >
  asyncAndThen<X, Y>(f: (t: T) => ResultAsync<X, Y>): ResultAsync<X, E | Y>
  asyncMap<X>(f: (t: T) => Promise<X>): ResultAsync<X, E>
  match<A, B = A>(fnOk: (t: T) => A, fnErr: (e: E) => B): A | B
  matchTags<A, const Handlers extends object>(
    fnOk: (t: T) => A,
    handlers: Handlers & MatchTagHandlers<E, Handlers>,
  ): A | MatchTagHandlerResult<Handlers>
  pipe<A>(ab: PipeFn<Result<T, E>, A>): A
  pipe<A, B>(ab: PipeFn<Result<T, E>, A>, bc: PipeFn<A, B>): B
  pipe<A, B, C>(ab: PipeFn<Result<T, E>, A>, bc: PipeFn<A, B>, cd: PipeFn<B, C>): C
  log(fn: (t?: T, e?: E) => void): this
  tap(fn: (t: T) => void): this
  tapError(fn: (e: E) => void): this
  finally<X = T, Y = E>(f: (value: X, error: Y) => void): DisposableResult<X, Y>
  unwrapOrThrow(): T
  [Symbol.iterator](): Generator<Result<never, E>, T>
  safeUnwrap(): Generator<Result<never, E>, T>
}

export interface OkResult<T, E> extends ResultOperations<T, E> {
  readonly value: T
}

export interface ErrResult<T, E> extends ResultOperations<T, E> {
  readonly error: E
}

export type Result<T, E> = OkResult<T, E> | ErrResult<T, E>

interface ResultStatic {
  [Symbol.hasInstance](value: unknown): boolean
  tryCatch<T, E>(fn: () => Exclude<T, Promise<unknown>>, errorFn?: (e: unknown) => E): Result<T, E>
  fromThrowable<Fn extends (...args: readonly any[]) => unknown, E>(
    fn: Fn,
    errorFn?: (e: any) => E,
  ): (...args: Parameters<Fn>) => Result<ReturnType<Fn>, E>
  ok<T, E = never>(value: T): OkResult<T, E>
  ok<E = never>(value: void): OkResult<void, E>
  unit<E = never>(): Result<undefined, E>
  err<T = never, E extends string = string>(err: E): ErrResult<T, E>
  err<T = never, E = unknown>(err: E): ErrResult<T, E>
  err<T = never>(err: void): ErrResult<T, void>
  combine<T extends readonly [Result<unknown, unknown>, ...Result<unknown, unknown>[]]>(
    resultList: T,
  ): CombineResults<T>
  combine<T extends readonly Result<unknown, unknown>[]>(resultList: T): CombineResults<T>
  combineWithAllErrors<
    T extends readonly [Result<unknown, unknown>, ...Result<unknown, unknown>[]],
  >(
    resultList: T,
  ): CombineResultsWithAllErrorsArray<T>
  combineWithAllErrors<T extends readonly Result<unknown, unknown>[]>(
    resultList: T,
  ): CombineResultsWithAllErrorsArray<T>
}

/**
 * Runtime namespace for Result constructors and static helpers.
 */
/* eslint-disable @typescript-eslint/no-extraneous-class, unicorn/no-static-only-class */
class ResultNamespace {
  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Ok || value instanceof Err
  }

  /**
   * Creates a `Result` by running a function that might throw.
   * If the function throws, the error will be caught and returned as an `Err`.
   * If the function succeeds, the value will be wrapped in an `Ok`.
   *
   * @param fn - The function to execute, which might throw an error
   * @param errorFn - Optional function to transform the thrown error before wrapping in `Err`
   * @returns A `Result` containing either the function's return value or the caught error
   */
  static tryCatch<T, E>(
    fn: () => Exclude<T, Promise<unknown>>,
    errorFn?: (e: unknown) => E,
  ): Result<T, E> {
    try {
      return ok(fn())
    } catch (error) {
      if (errorFn) {
        return err(errorFn(error))
      }
      return err(error as E)
    }
  }

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

  /**
   * Creates a new `Result` instance representing a successful operation.
   *
   * @param {T} value - The value to be wrapped in the `Result` instance.
   * @return {Result<T, E>} A new `Result` instance with the provided value.
   */

  static ok<T, E = never>(value: T): OkResult<T, E>
  static ok<E = never>(value: void): OkResult<void, E>
  static ok<T, E = never>(value: T): OkResult<T, E> {
    return ok<T, E>(value)
  }

  /**
   * Creates a new `Result` instance representing a successful operation with an undefined value.
   *
   * @return {Result<undefined, E>} A new `Result` instance with an undefined value.
   */
  static unit<E = never>(): Result<undefined, E> {
    return unit<E>()
  }

  static err<T = never, E extends string = string>(err: E): ErrResult<T, E>
  static err<T = never, E = unknown>(err: E): ErrResult<T, E>
  static err<T = never>(err: void): ErrResult<T, void>
  static err<T = never, E = unknown>(error: E): ErrResult<T, E> {
    return err<T, E>(error)
  }

  static combine<T extends readonly [Result<unknown, unknown>, ...Result<unknown, unknown>[]]>(
    resultList: T,
  ): CombineResults<T>
  static combine<T extends readonly Result<unknown, unknown>[]>(resultList: T): CombineResults<T>
  static combine<T extends readonly [Result<unknown, unknown>, ...Result<unknown, unknown>[]]>(
    resultList: T,
  ): CombineResults<T> {
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
}

export const Result: ResultStatic = ResultNamespace

class Ok<T, E> {
  constructor(readonly value: T) {}

  isOk(): this is OkResult<T, E> {
    return true
  }

  isErr(): this is ErrResult<T, E> {
    return false
  }

  map<X>(f: (t: T) => X): Result<X, E> {
    return ok<X, E>(f(this.value))
  }

  filterOrElse<U extends T, F>(
    predicate: (value: T) => value is U,
    onFalse: (value: T) => F,
  ): Result<U, E | F>
  filterOrElse<F>(predicate: (value: T) => boolean, onFalse: (value: T) => F): Result<T, E | F>
  filterOrElse<F>(predicate: (value: T) => boolean, onFalse: (value: T) => F): Result<T, E | F> {
    if (predicate(this.value)) {
      return ok<T, E | F>(this.value)
    }

    return err<T, E | F>(onFalse(this.value))
  }

  mapErr<X>(_fn: (t: E) => X): Result<T, X> {
    return ok<T, X>(this.value)
  }

  andThen<X, Y>(f: (t: T) => Result<X, Y>): Result<X, E | Y> {
    return f(this.value)
  }

  if(fCondition: (t: T) => boolean): {
    true: <X1, Y1>(
      fTrue: (t: T) => Result<X1, Y1>,
    ) => { false: <X2, Y2>(fFalse: (t: T) => Result<X2, Y2>) => Result<X1 | X2, Y1 | Y2 | E> }
  } {
    return {
      true: <X1, Y1>(fTrue: (t: T) => Result<X1, Y1>) => ({
        false: <X2, Y2>(fFalse: (t: T) => Result<X2, Y2>): Result<X1 | X2, Y1 | Y2 | E> =>
          fCondition(this.value) ? fTrue(this.value) : fFalse(this.value),
      }),
    }
  }

  orElse<R extends Result<unknown, unknown>>(
    f: (e: E) => R,
  ): Result<InferOkTypes<R> | T, InferErrTypes<R>>
  orElse<U, A>(f: (e: E) => Result<U, A>): Result<U | T, A>
  orElse<U, A>(_f: (e: E) => Result<U, A>): Result<U | T, A> {
    return ok<U | T, A>(this.value as Exclude<T, Promise<any>>)
  }

  catchTag<const Tag extends TagsOf<E>, R extends Result<unknown, unknown>>(
    _tag: Tag,
    _f: (error: ErrorForTag<E, Tag>) => R,
  ): Result<T | InferOkTypes<R>, ExcludeTag<E, Tag> | InferErrTypes<R>> {
    return ok(this.value)
  }

  catchTags<const Handlers extends object>(
    _handlers: Handlers & CatchTagHandlers<E, Handlers>,
  ): Result<
    T | InferOkTypes<CatchTagHandlerResult<Handlers>>,
    ExcludeTag<E, keyof Handlers & string> | InferErrTypes<CatchTagHandlerResult<Handlers>>
  > {
    return ok(this.value)
  }

  asyncAndThen<X, Y>(f: (t: T) => ResultAsync<X, Y>): ResultAsync<X, E | Y>
  asyncAndThen<X, Y>(f: (t: T) => ResultAsync<X, E>): ResultAsync<X, E | Y> {
    return f(this.value)
  }

  asyncMap<X>(f: (t: T) => Promise<X>): ResultAsync<X, E> {
    return ResultAsync.fromSafePromise(f(this.value))
  }

  unwrapOr<A>(_defaultValue: A): T | A {
    return this.value
  }

  match<A, B = A>(fnOk: (t: T) => A, _fnErr: (e: E) => B): A | B {
    return fnOk(this.value)
  }

  matchTags<A, const Handlers extends object>(
    fnOk: (t: T) => A,
    _handlers: Handlers & MatchTagHandlers<E, Handlers>,
  ): A | MatchTagHandlerResult<Handlers> {
    return fnOk(this.value)
  }

  pipe<A>(ab: PipeFn<this, A>): A
  pipe<A, B>(ab: PipeFn<this, A>, bc: PipeFn<A, B>): B
  pipe<A, B, C>(ab: PipeFn<this, A>, bc: PipeFn<A, B>, cd: PipeFn<B, C>): C
  pipe(...fns: readonly PipeFn<never, unknown>[]): unknown {
    const first = fns[0]

    if (!first) {
      return this
    }

    let input = first(this as never)

    for (const fn of fns.slice(1)) {
      input = (fn as PipeFn<unknown, unknown>)(input)
    }

    return input
  }

  log(fn: (t?: T, e?: E) => void): this {
    try {
      fn(this.value, undefined)
    } catch {
      /* empty */
    }

    return this
  }

  tap(fn: (t: T) => void): this {
    try {
      fn(this.value)
    } catch {
      /* empty */
    }

    return this
  }

  tapError(_fn: (e: E) => void): this {
    return this
  }

  finally<X = T, Y = E>(f: (value: X, error: Y) => void): DisposableResult<X, Y>
  finally(f: (value: T, error: E) => void): DisposableResult<T, E> {
    const resultDisposable = new DisposableResult(this, f)
    try {
      return resultDisposable
    } finally {
      resultDisposable[Symbol.dispose]()
    }
  }

  unwrapOrThrow(): T {
    return this.value
  }

  _unsafeUnwrap(_config?: ErrorConfig): T {
    return this.value
  }

  _unsafeUnwrapErr(config?: ErrorConfig): E {
    throw createResultarError('Called `_unsafeUnwrapErr` on an Ok', this, config)
  }

  /* eslint-disable-next-line require-yield */
  *[Symbol.iterator](): Generator<Result<never, E>, T> {
    return this.value
  }

  safeUnwrap(): Generator<Result<never, E>, T> {
    const { value } = this
    /* eslint-disable-next-line require-yield */
    return (function* () {
      return value
    })()
  }
}

class Err<T, E> {
  constructor(readonly error: E) {}

  isOk(): this is OkResult<T, E> {
    return false
  }

  isErr(): this is ErrResult<T, E> {
    return true
  }

  map<X>(_f: (t: T) => X): Result<X, E> {
    return err<X, E>(this.error)
  }

  filterOrElse<U extends T, F>(
    predicate: (value: T) => value is U,
    onFalse: (value: T) => F,
  ): Result<U, E | F>
  filterOrElse<F>(predicate: (value: T) => boolean, onFalse: (value: T) => F): Result<T, E | F>
  filterOrElse<F>(_predicate: (value: T) => boolean, _onFalse: (value: T) => F): Result<T, E | F> {
    return err<T, E | F>(this.error)
  }

  mapErr<X>(fn: (t: E) => X): Result<T, X> {
    return err<T, X>(fn(this.error))
  }

  andThen<X, Y>(_f: (t: T) => Result<X, Y>): Result<X, E | Y> {
    return err<X, E | Y>(this.error)
  }

  if(_fCondition: (t: T) => boolean): {
    true: <X1, Y1>(
      fTrue: (t: T) => Result<X1, Y1>,
    ) => { false: <X2, Y2>(fFalse: (t: T) => Result<X2, Y2>) => Result<X1 | X2, Y1 | Y2 | E> }
  } {
    return {
      true: <X1, Y1>(_fTrue: (t: T) => Result<X1, Y1>) => ({
        false: <X2, Y2>(_fFalse: (t: T) => Result<X2, Y2>): Result<X1 | X2, Y1 | Y2 | E> =>
          err<X1 | X2, Y1 | Y2 | E>(this.error),
      }),
    }
  }

  orElse<R extends Result<unknown, unknown>>(
    f: (e: E) => R,
  ): Result<InferOkTypes<R> | T, InferErrTypes<R>>
  orElse<U, A>(f: (e: E) => Result<U, A>): Result<U | T, A>
  orElse<U, A>(f: (e: E) => Result<U, A>): Result<U | T, A> {
    return f(this.error)
  }

  catchTag<const Tag extends TagsOf<E>, R extends Result<unknown, unknown>>(
    tag: Tag,
    f: (error: ErrorForTag<E, Tag>) => R,
  ): Result<T | InferOkTypes<R>, ExcludeTag<E, Tag> | InferErrTypes<R>> {
    if (hasTag(this.error, tag)) {
      return f(this.error as ErrorForTag<E, Tag>) as Result<
        T | InferOkTypes<R>,
        ExcludeTag<E, Tag> | InferErrTypes<R>
      >
    }

    return err(this.error as ExcludeTag<E, Tag>)
  }

  catchTags<const Handlers extends object>(
    handlers: Handlers & CatchTagHandlers<E, Handlers>,
  ): Result<
    T | InferOkTypes<CatchTagHandlerResult<Handlers>>,
    ExcludeTag<E, keyof Handlers & string> | InferErrTypes<CatchTagHandlerResult<Handlers>>
  > {
    const error = this.error

    if (typeof error === 'object' && error !== null && '_tag' in error) {
      const handler = handlers[error._tag as keyof Handlers]

      if (handler !== undefined) {
        return (handler as (error: E) => CatchTagHandlerResult<Handlers>)(error) as Result<
          T | InferOkTypes<CatchTagHandlerResult<Handlers>>,
          ExcludeTag<E, keyof Handlers & string> | InferErrTypes<CatchTagHandlerResult<Handlers>>
        >
      }
    }

    return err(error as ExcludeTag<E, keyof Handlers & string>)
  }

  asyncAndThen<X, Y>(_f: (t: T) => ResultAsync<X, Y>): ResultAsync<X, E | Y>
  asyncAndThen<X, Y>(_f: (t: T) => ResultAsync<X, E>): ResultAsync<X, E | Y> {
    return errAsync(this.error)
  }

  asyncMap<X>(_f: (t: T) => Promise<X>): ResultAsync<X, E> {
    return errAsync(this.error)
  }

  unwrapOr<A>(defaultValue: A): T | A {
    return defaultValue
  }

  match<A, B = A>(_fnOk: (t: T) => A, fnErr: (e: E) => B): A | B {
    return fnErr(this.error)
  }

  matchTags<A, const Handlers extends object>(
    _fnOk: (t: T) => A,
    handlers: Handlers & MatchTagHandlers<E, Handlers>,
  ): A | MatchTagHandlerResult<Handlers> {
    const error = this.error

    if (typeof error === 'object' && error !== null && '_tag' in error) {
      const handler = handlers[error._tag as keyof typeof handlers]

      if (handler !== undefined) {
        return (handler as (error: E) => MatchTagHandlerResult<Handlers>)(error)
      }
    }

    if (handlers.Error) {
      return (handlers.Error as (error: E) => MatchTagHandlerResult<Handlers>)(error)
    }

    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw error
  }

  pipe<A>(ab: PipeFn<this, A>): A
  pipe<A, B>(ab: PipeFn<this, A>, bc: PipeFn<A, B>): B
  pipe<A, B, C>(ab: PipeFn<this, A>, bc: PipeFn<A, B>, cd: PipeFn<B, C>): C
  pipe(...fns: readonly PipeFn<never, unknown>[]): unknown {
    const first = fns[0]

    if (!first) {
      return this
    }

    let input = first(this as never)

    for (const fn of fns.slice(1)) {
      input = (fn as PipeFn<unknown, unknown>)(input)
    }

    return input
  }

  log(fn: (t?: T, e?: E) => void): this {
    try {
      fn(undefined, this.error)
    } catch {
      /* empty */
    }

    return this
  }

  tap(_fn: (t: T) => void): this {
    return this
  }

  tapError(fn: (e: E) => void): this {
    try {
      fn(this.error)
    } catch {
      /* empty */
    }

    return this
  }

  finally<X = T, Y = E>(f: (value: X, error: Y) => void): DisposableResult<X, Y>
  finally(f: (value: T, error: E) => void): DisposableResult<T, E> {
    const resultDisposable = new DisposableResult(this, f)
    try {
      return resultDisposable
    } finally {
      resultDisposable[Symbol.dispose]()
    }
  }

  unwrapOrThrow(): T {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw this.error
  }

  _unsafeUnwrap(config?: ErrorConfig): T {
    throw createResultarError('Called `_unsafeUnwrap` on an Err', this, config)
  }

  _unsafeUnwrapErr(_config?: ErrorConfig): E {
    return this.error
  }

  *[Symbol.iterator](): Generator<Result<never, E>, T> {
    yield this as never
    return this as never
  }

  safeUnwrap(): Generator<Result<never, E>, T> {
    const { error } = this
    return (function* () {
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
  constructor(
    readonly result: Result<T, E>,
    private readonly finalizer: (value: T, error: E) => void,
  ) {}

  get value(): T {
    return this.result.isOk() ? this.result.value : (undefined as T)
  }

  get error(): E {
    return this.result.isErr() ? this.result.error : (undefined as E)
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
    this.finalizer(
      this.result.isOk() ? this.result.value : (undefined as T),
      this.result.isErr() ? this.result.error : (undefined as E),
    )
  }
}

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

export function ok<T, E = never>(value: T): OkResult<T, E>
export function ok<E = never>(value: void): OkResult<void, E>
export function ok<T, E = never>(value: T): OkResult<T, E> {
  return new Ok<T, E>(value)
}

export function err<T = never, E extends string = string>(err: E): ErrResult<T, E>
export function err<T = never, E = unknown>(err: E): ErrResult<T, E>
export function err<T = never>(err: void): ErrResult<T, void>
export function err<T = never, E = unknown>(error: E): ErrResult<T, E> {
  return new Err<T, E>(error)
}

export const fromThrowable = Result.fromThrowable
export function unit<E = never>(): OkResult<undefined, E> {
  return ok<undefined, E>(undefined)
}

export const tryCatch = Result.tryCatch

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
] extends [never]
  ? []
  : T extends [infer H, ...infer Rest]
    ? // And test whether the head of the list is a result
      H extends Result<infer L, infer R>
      ? // Continue collecting...
        CollectResults<
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
      ? PL extends unknown[]
        ? PR extends unknown[]
          ? Transpose<Rest, [[...PL, L], [...PR, R]], Prev[Depth]>
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
export type Combine<T, Depth extends number = 5> =
  Transpose<CollectResults<T>, [], Depth> extends [infer L, infer R]
    ? [UnknownMembersToNever<L>, UnknownMembersToNever<R>]
    : Transpose<CollectResults<T>, [], Depth> extends []
      ? [[], []]
      : never

// Deduplicates the result, as the result type is a union of Err and Ok types.
export type Dedup<T> = T extends Result<infer RL, infer RR> ? Result<RL, RR> : T

// Given a union, this gives the array of the union members.
export type MemberListOf<T> = (
  (T extends unknown ? (t: T) => T : never) extends infer U
    ? (U extends unknown ? (u: U) => unknown : never) extends (v: infer V) => unknown
      ? V
      : never
    : never
) extends (_: unknown) => infer W
  ? [...MemberListOf<Exclude<T, W>>, W]
  : []

// Converts an empty array to never.
//
// The second type parameter here will affect how to behave to `never[]`s.
// If a precise type is required, pass `1` here so that it will resolve
// a literal array such as `[ never, never ]`. Otherwise, set `0` or the default
// type value will cause this to resolve the arrays containing only `never`
// items as `never` only.
export type EmptyArrayToNever<T, NeverArrayToNever extends number = 0> = T extends []
  ? never
  : NeverArrayToNever extends 1
    ? T extends [never, ...infer Rest]
      ? [EmptyArrayToNever<Rest>] extends [never]
        ? never
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
export type IsLiteralArray<T> = T extends { length: infer L }
  ? L extends number
    ? number extends L
      ? 0
      : 1
    : 0
  : 0

// Traverses an array of results and returns a single result containing
// the oks and errs union-ed/combined.
type Traverse<T, Depth extends number = 5> =
  Combine<T, Depth> extends [infer Oks, infer Errs]
    ? Result<EmptyArrayToNever<Oks, 1>, MembersToUnion<Errs>>
    : never

// Traverses an array of results and returns a single result containing
// the oks combined and the array of errors combined.
type TraverseWithAllErrors<T, Depth extends number = 5> =
  Traverse<T, Depth> extends Result<infer Oks, infer Errs> ? Result<Oks, Errs[]> : never

// Combines the array of results into one result.
export type CombineResults<T extends readonly Result<unknown, unknown>[]> =
  IsLiteralArray<T> extends 1 ? Traverse<T> : Result<ExtractOkTypes<T>, ExtractErrTypes<T>[number]>

// Combines the array of results into one result with all errors.
export type CombineResultsWithAllErrorsArray<T extends readonly Result<unknown, unknown>[]> =
  IsLiteralArray<T> extends 1
    ? TraverseWithAllErrors<T>
    : Result<ExtractOkTypes<T>, ExtractErrTypes<T>[number][]>

// #endregion
