/* eslint-disable max-params */
/** Internal dispatcher; callers retain explicit overloads and argument validation. */
export const dual = <Args extends readonly unknown[], Output>(
  isDataFirst: (args: readonly unknown[]) => boolean,
  body: (...args: Args) => Output,
): ((...args: readonly unknown[]) => Output | ((self: Args[0]) => Output)) =>
  function dualDispatcher(...args: readonly unknown[]): Output | ((self: Args[0]) => Output) {
    if (isDataFirst(args)) {
      return body(...(args as unknown as Args))
    }
    const length = args.length
    if (length === 0) {
      const fn = body as unknown as (self: unknown) => Output
      return (self) => fn(self)
    }
    if (length === 1) {
      const a0 = args[0]
      const fn = body as unknown as (self: unknown, arg0: unknown) => Output
      return (self) => fn(self, a0)
    }
    if (length === 2) {
      const a0 = args[0]
      const a1 = args[1]
      const fn = body as unknown as (self: unknown, arg0: unknown, arg1: unknown) => Output
      return (self) => fn(self, a0, a1)
    }
    if (length === 3) {
      const a0 = args[0]
      const a1 = args[1]
      const a2 = args[2]
      const fn = body as unknown as (
        self: unknown,
        arg0: unknown,
        arg1: unknown,
        arg2: unknown,
      ) => Output
      return (self) => fn(self, a0, a1, a2)
    }
    return (self) => body(...([self, ...args] as unknown as Args))
  }
