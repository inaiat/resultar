export type PipeFn<Input, Output> = (input: Input) => Output

const runPipe = <Self>(self: Self, fns: readonly PipeFn<never, unknown>[]): unknown => {
  const first = fns[0]

  if (!first) {
    return self
  }

  let input = first(self as never)

  for (const fn of fns.slice(1)) {
    input = (fn as PipeFn<unknown, unknown>)(input)
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
  public pipe<A>(ab: PipeFn<this, A>): A
  public pipe<A, B>(ab: PipeFn<this, A>, bc: PipeFn<A, B>): B
  public pipe<A, B, C>(ab: PipeFn<this, A>, bc: PipeFn<A, B>, cd: PipeFn<B, C>): C
  public pipe(...fns: readonly PipeFn<never, unknown>[]): unknown {
    return runPipe(this, fns)
  }
}
