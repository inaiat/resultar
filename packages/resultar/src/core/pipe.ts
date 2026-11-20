/* eslint-disable max-params, prefer-rest-params, complexity */
export type PipeFn<Input, Output> = (input: Input) => Output

export type FnPipe<Input, Args extends readonly unknown[], Output> = (
  input: Input,
  ...args: Args
) => Output

export const applyPipeStep = (
  value: unknown,
  transform: PipeFn<never, unknown> | undefined,
): unknown => {
  if (transform === undefined) throw new TypeError('pipe requires transformation functions')
  return transform(value as never)
}

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

export const runPipeArgs = (self: unknown, args: IArguments, startIndex: number): unknown => {
  const count = args.length - startIndex
  let value: unknown = self
  /* Stryker disable all: fixed-arity switches are allocation-free fast paths equivalent to the loop below. */
  switch (count) {
    case 0: {
      return value
    }
    case 1: {
      return applyPipeStep(value, args[startIndex] as PipeFn<never, unknown> | undefined)
    }
    case 2: {
      return applyPipeStep(
        applyPipeStep(value, args[startIndex] as PipeFn<never, unknown> | undefined),
        args[startIndex + 1] as PipeFn<never, unknown> | undefined,
      )
    }
    case 3: {
      return applyPipeStep(
        applyPipeStep(
          applyPipeStep(value, args[startIndex] as PipeFn<never, unknown> | undefined),
          args[startIndex + 1] as PipeFn<never, unknown> | undefined,
        ),
        args[startIndex + 2] as PipeFn<never, unknown> | undefined,
      )
    }
    case 4: {
      value = applyPipeStep(value, args[startIndex] as PipeFn<never, unknown> | undefined)
      value = applyPipeStep(value, args[startIndex + 1] as PipeFn<never, unknown> | undefined)
      value = applyPipeStep(value, args[startIndex + 2] as PipeFn<never, unknown> | undefined)
      return applyPipeStep(value, args[startIndex + 3] as PipeFn<never, unknown> | undefined)
    }
    default: {
      for (let index = startIndex; index < args.length; index += 1) {
        value = applyPipeStep(value, args[index] as PipeFn<never, unknown> | undefined)
      }
      return value
    }
  }
  /* Stryker restore all */
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
  public pipe(): unknown {
    return runPipeArgs(this, arguments, 0)
  }
}
