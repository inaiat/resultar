---
"resultar": patch
"resultar-check": patch
"resultar-hono": patch
---

Return `ResultAsync<A, E | ScopeError<R>>` from `ResultTask.runResult` and `task.runResult` as the official in-flight `Result` representation (`PromiseLike<Result<T, E>>`).

- Un-deprecate `ResultAsync` and `StrictResultAsync` for consuming and transforming in-flight `Result` values before `await`.
- Make `task.toResultAsync()`, `ResultTask.toResultAsync(task)`, and `ResultAsync.fromTask(task)` deprecated aliases of `runResult()`.
- Mark static eager constructors and workflow/orchestration methods on `ResultAsync` (`retry`, `retryOrElse`, `race`, `raceAll`, `raceFirst`, `raceWith`, `timeout`, `withResource`, `forEach`, `validateAll`, `loop`, `iterate`, `firstSuccessOf`, `all`, `combine`, `combineWithAllErrors`, `zip`) as `@deprecated` in favor of `ResultTask`.
- Delegate `ResultAsync` resolution transformation and consumption methods (`andThen`, `orElse`, `catchTag`, `catchTags`, `catchReason`, `catchReasons`, `as`, `unwrapReason`, `match`, `matchTags`, `matchTagsPartial`, `unwrapOr`, `unwrapOrThrow`) to `Result` and eliminate redundant wrapper allocations in `map`, `mapErr`, `filterOrElse`, `if`, `orElseSucceed`, `log`, `inspect`, `inspectError`, and `inspectBoth`.
- Transfer `resultar-check` `no-discard` tracking when awaiting a `ResultAsync` variable into a `Result` binding (`const res = await pending`) and flag bare `await pending;` statements.
- Return `ResultAsync<void, CloseError>` from `HonoApplication.close()` and `HonoServices.close()` in `resultar-hono`.

