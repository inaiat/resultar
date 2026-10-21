/* eslint-disable max-params */
export type PipeFn<Input, Output> = (input: Input) => Output

export type FnPipe<Input, Args extends readonly unknown[], Output> = (
  input: Input,
  ...args: Args
) => Output

export const runPipe = <Self>(self: Self, fns: readonly PipeFn<never, unknown>[]): unknown => {
  let input: unknown = self
  const length = fns.length
  for (let index = 0; index < length; index += 1) {
    const transform = fns[index]
    if (transform === undefined) throw new TypeError('pipe requires transformation functions')
    input = transform(input as never)
  }

  return input
}

export const runFnPipe = <Self>(
  self: Self,
  args: readonly unknown[],
  fns: readonly FnPipe<never, readonly never[], unknown>[],
): unknown => {
  let input: unknown = self
  const length = fns.length
  for (let index = 0; index < length; index += 1) {
    const transform = fns[index]
    if (transform === undefined) throw new TypeError('pipe requires transformation functions')
    input = transform(input as never, ...(args as readonly never[]))
  }

  return input
}

export abstract class Pipeable {
  /**
   * Passes this value through one or more transformation functions.
   *
   * Use `pipe` to package reusable Result or ResultAsync combinators without hiding the underlying
   * type.
   */
  public pipe(): this
  public pipe<A>(ab: PipeFn<this, A>): A
  public pipe<A, B>(ab: PipeFn<this, A>, bc: PipeFn<A, B>): B
  public pipe<A, B, C>(ab: PipeFn<this, A>, bc: PipeFn<A, B>, cd: PipeFn<B, C>): C
  public pipe<A, B, C, D>(
    ab: PipeFn<this, A>,
    bc: PipeFn<A, B>,
    cd: PipeFn<B, C>,
    de: PipeFn<C, D>,
  ): D
  public pipe<A, B, C, D, E>(
    ab: PipeFn<this, A>,
    bc: PipeFn<A, B>,
    cd: PipeFn<B, C>,
    de: PipeFn<C, D>,
    ef: PipeFn<D, E>,
  ): E
  public pipe<A, B, C, D, E, F>(
    ab: PipeFn<this, A>,
    bc: PipeFn<A, B>,
    cd: PipeFn<B, C>,
    de: PipeFn<C, D>,
    ef: PipeFn<D, E>,
    fg: PipeFn<E, F>,
  ): F
  public pipe<A, B, C, D, E, F, G>(
    ab: PipeFn<this, A>,
    bc: PipeFn<A, B>,
    cd: PipeFn<B, C>,
    de: PipeFn<C, D>,
    ef: PipeFn<D, E>,
    fg: PipeFn<E, F>,
    gh: PipeFn<F, G>,
  ): G
  public pipe<A, B, C, D, E, F, G, H>(
    ab: PipeFn<this, A>,
    bc: PipeFn<A, B>,
    cd: PipeFn<B, C>,
    de: PipeFn<C, D>,
    ef: PipeFn<D, E>,
    fg: PipeFn<E, F>,
    gh: PipeFn<F, G>,
    hi: PipeFn<G, H>,
  ): H
  public pipe(...fns: readonly PipeFn<never, unknown>[]): unknown {
    return runPipe(this, fns)
  }
}
