/** Internal dispatcher; callers retain explicit overloads and argument validation. */
export const dual =
  <Args extends readonly unknown[], Output>(
    isDataFirst: (args: readonly unknown[]) => boolean,
    body: (...args: Args) => Output,
  ): ((...args: readonly unknown[]) => Output | ((self: Args[0]) => Output)) =>
  (...args) =>
    isDataFirst(args)
      ? body(...(args as unknown as Args))
      : (self) => body(...([self, ...args] as unknown as Args))
