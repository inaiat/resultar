import type { Result } from '../result/result.js'

export type ResultAsyncFinalizer<T, E> = (
  value: T | undefined,
  error: E | undefined,
) => void | Promise<void>

/**
 * Wrapper around a Result-producing Promise that also implements AsyncDisposable (`await using`).
 * @deprecated Since v4. Use ResultTask.acquireRelease or acquireDisposable in new workflows.
 */
export class DisposableResultAsync<T, E> implements PromiseLike<Result<T, E>>, AsyncDisposable {
  readonly #promise: Promise<Result<T, E>>
  readonly #finalizer: ResultAsyncFinalizer<unknown, unknown>
  #disposed = false

  public constructor(promise: Promise<Result<T, E>>, finalizer: ResultAsyncFinalizer<T, E>) {
    this.#promise = promise
    this.#finalizer = finalizer as ResultAsyncFinalizer<unknown, unknown>
  }

  // eslint-disable-next-line unicorn/no-thenable -- Intentional PromiseLike implementation for `await using`.
  public then<TResult1 = Result<T, E>, TResult2 = never>(
    onfulfilled?: ((value: Result<T, E>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.#promise.then(onfulfilled, onrejected)
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) {
      return
    }

    this.#disposed = true
    const result = await this.#promise

    try {
      await this.#finalizer(
        result.isOk() ? result.value : undefined,
        result.isErr() ? result.error : undefined,
      )
    } catch {
      /* empty */
    }
  }
}
