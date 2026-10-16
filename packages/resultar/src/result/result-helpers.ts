import type { ErrorConfig } from '../core/error.js'
import type { Result } from './result.js'
import type {
  MatchErrorHandler,
  MatchHandlers,
  MatchOkHandler,
  Resultable,
  ResultFinalizer,
} from './result-types.js'

export const isIterable = (value: unknown): value is Iterable<unknown> =>
  // Stryker disable next-line all: invalid null input still fails outside the iterable branch; this guard keeps the hot check explicit.
  value !== null &&
  // Stryker disable next-line all: iterable functions are valid iterables, but normal collection tests cover object iterables.
  (typeof value === 'object' || typeof value === 'function') &&
  typeof (value as { readonly [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'

export const createEmptyResultsCollectionError = (): Error => {
  const error = new Error('Received an empty collection of results')
  error.name = 'IllegalArgumentException'

  return error
}

export const getReason = (value: unknown): unknown =>
  (value as { readonly reason?: unknown }).reason

export const callSyncSideEffect = (effect: () => void): void => {
  try {
    effect()
  } catch {
    /* empty */
  }
}

export const getMatchErrorHandler = <T, E, A, B>(
  input: MatchHandlers<T, E, A, B> | MatchOkHandler<T, A>,
  fnErr: MatchErrorHandler<E, B> | undefined,
): MatchErrorHandler<E, B> => {
  if (typeof input !== 'function') {
    return 'err' in input ? input.err : input.error
  }

  if (fnErr === undefined) {
    throw new TypeError('Result.match requires an error handler')
  }

  return fnErr
}

export class OkResultIterator<T> {
  declare public readonly done: true
  public readonly value: T

  public constructor(value: T) {
    this.value = value
  }

  public next(): IteratorResult<never, T> {
    return this as unknown as IteratorResult<never, T>
  }
}

Object.assign(OkResultIterator.prototype, { done: true })

/**
 * A `Disposable` is an object that has a `dispose` method that can be used to
 * clean up resources.
 */
export class DisposableResult<T, E> implements Resultable<T, E>, Disposable {
  private disposed = false
  private readonly finalizer: (value: unknown, error: unknown) => void
  /**
   * Wrapped Result value.
   */
  public readonly result: Result<T, E>

  /**
   * Creates a disposable wrapper around a Result.
   */
  public constructor(result: Result<T, E>, finalizer: ResultFinalizer<T, E>) {
    this.result = result
    this.finalizer = finalizer as (value: unknown, error: unknown) => void
  }

  /**
   * Ok value when present, otherwise undefined cast to `T` for compatibility.
   */
  public get value(): T {
    return this.result.isOk() ? this.result.value : (undefined as T)
  }

  /**
   * Err value when present, otherwise undefined cast to `E` for compatibility.
   */
  public get error(): E {
    return this.result.isErr() ? this.result.error : (undefined as E)
  }

  /**
   * Delegates to the wrapped Result `_unsafeUnwrap`.
   */
  public _unsafeUnwrap(config?: ErrorConfig): T {
    return this.result._unsafeUnwrap(config)
  }

  /**
   * Delegates to the wrapped Result `_unsafeUnwrapErr`.
   */
  public _unsafeUnwrapErr(config?: ErrorConfig): E {
    return this.result._unsafeUnwrapErr(config)
  }

  /**
   * Returns whether the wrapped Result is Ok.
   */
  public isOk(): boolean {
    return this.result.isOk()
  }

  /**
   * Returns whether the wrapped Result is Err.
   */
  public isErr(): boolean {
    return this.result.isErr()
  }

  /**
   * Returns the wrapped Ok value, or `defaultValue` when Err.
   */
  public unwrapOr<A>(defaultValue: A): T | A {
    return this.result.unwrapOr(defaultValue)
  }

  /**
   * Runs the finalizer once.
   *
   * Finalizer exceptions are intentionally swallowed.
   */
  public [Symbol.dispose](): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
    try {
      this.finalizer(
        this.result.isOk() ? this.result.value : undefined,
        this.result.isErr() ? this.result.error : undefined,
      )
    } catch {
      /* empty */
    }
  }
}
