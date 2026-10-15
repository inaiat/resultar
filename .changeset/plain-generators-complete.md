---
"resultar": major
"resultar-check": minor
"resultar-check-darwin-arm64": minor
"resultar-check-darwin-x64": minor
"resultar-check-linux-arm64": minor
"resultar-check-linux-x64": minor
"resultar-check-win32-arm64": minor
"resultar-check-win32-x64": minor
---

Unify `ok` and `err` across `Result`, `ResultAsync`, `ResultTask`, generator workflows, and `.match` object handlers:

- Change `Result.gen` to return plain success values (wrapping in `Ok` automatically) and require `yield*` for `Result`, `ResultAsync`, and early error returns, matching `ResultTask.gen` while preserving eager asynchronous execution. Keep `safeTry`'s original Result-returning signatures and runtime behavior for gradual migration.
- Add `ResultTask.ok` and `ResultTask.err` as the canonical task constructors (preserving `ResultTask.succeed` and `ResultTask.fail` as deprecated aliases) and `ResultAsync.ok` and `ResultAsync.err` static constructors alongside `okAsync` and `errAsync`.
- Support `{ ok, err }` object handlers in `Result.match`, `ResultAsync.match`, and `ResultTask.match` while retaining `{ ok, error }` and `{ onSuccess, onFailure }` for compatibility.
- Allow `ResultTask` combinators (`andThen`, `orElse`, `catchTag`, `catchTags`, `catchReason`, and `catchReasons`) to accept synchronous `Result` values (`ok(...)`, `err(...)`) directly alongside `ResultTask`.
- Add `Result.fn` (for both synchronous `Result` and `async function*` `ResultAsync` generators), constrain `ResultTask.gen` and `ResultTask.fn` at compile time via `ResultTaskYieldable` to reject invalid yields (`ResultAsync`, `Promise`), export `ResultGenerator`, `ResultAsyncGenerator`, `ResultTaskGenerator`, and `ResultTaskYieldOf` for explicit generator return annotations, and extend `Result.fn` and `ResultTask.fn` to accept up to eight post-body pipeline operators receiving `(current, ...args)`.
- Add `filterOrElse`, `matchTags`, `matchTagsPartial`, `inspectCause`, `inspectBoth`, `tapCause`, `tapBoth`, `orElseSucceed`, `unwrapOr`, `catchCause`, `sandbox`, `unsandbox`, `catchReason`, `catchReasons`, `unwrapReason`, `ensuring`, `onExit`, `delay`, `timed`, `asVoid`, `zip` (with `{ concurrent?: boolean }`), `makeSemaphore`, `firstSuccessOf`, `if`, `when`, `unless`, `loop`, and `iterate` (instance, direct, and curried `pipe` forms) to `ResultTask`, export `Semaphore` (`Semaphore.make`, `withPermit`, `withPermits`, `available`) and `Cause.isCause` / `Cause.failures` / `Cause.defects`, unify `when` and `unless` across `Result`, `ResultAsync`, and `ResultTask` (supporting instance `.when` / `.unless`, curried `pipe` forms, fallible conditions, and direct or lazy bodies while preserving `whenResult` / `unlessResult`), add `orElseSucceed` and `asVoid` (instance, direct, and curried `pipe` forms) to `Result` and `ResultAsync`, add static direct/curried `unwrapOr`, `catchTag`, `catchTags`, `catchReason`, `catchReasons`, `unwrapReason`, `matchTags`, `matchTagsPartial`, and `inspectBoth` to `Result` and `ResultAsync`, and optimize `Match` tag/discriminator tables to dispatch via a single precompiled `Map` lookup.
- Add `.errAsync(...)` and `.taskErr(...)` static factory methods alongside `.err(...)` on `createTaggedError` classes.
- Add `Result.all` and `ResultAsync.all` as collection combinators matching `ResultTask.all` and `Promise.all` (alongside `Result.combine` and `ResultAsync.combine`).
- Update `resultar-check` to recognize `Result.fn`, `ResultTask.fn(..., ResultTask.scoped)`, `Result.all`, `ResultAsync.all`, and the new instance and static `Result` / `ResultAsync` / `ResultTask` consumer, control-flow, and recovery methods.

