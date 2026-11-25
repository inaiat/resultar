# Review generated Resultar code

Review the consumer's actual contracts and checker configuration. Optional rule
preferences are not universal runtime requirements.

- Is the chosen primitive correct? Sync: `Result`. Async workflow: `ResultTask` (`task.runResult()` returns native `Promise<Result<T, E>>`). Legacy eager boundary: opt-in `"resultar/async"` (`ResultAsync`). Does a `fromResultAsync` bridge create work inside its factory on each run?
- Does a Promise signature belong to a driver/SDK input or an explicit native
  execution boundary (`task.runResult()`, `runExit()`, `runPromise()`)? Application methods return `ResultTask` without `async`
  (never `Promise<ResultTask<...>>`, and never `await task` directly). Use `requestJson` /
  `requestJsonZod` / `requestJsonTypeBox` directly for lazy HTTP calls, `tryPromise`
  directly for raw Promise drivers, and `fromResultAsync` only for legacy typed Async operations. Are negative checker fixtures labeled?
- Do calls exist in installed declarations with the correct static/instance form?
  Avoid copying similarly named APIs from other libraries.
- Are expected failures concrete and tagged where appropriate? Are causes retained,
  sensitive fields redacted, and generated constructors left intact?
- Are generator successes plain values, with `yield*` steps and explicit
  `return yield*` on failing branches? `Result.gen` / `Result.fn` are sync-only; sync Results may be yielded inside `ResultTask.gen`. Legacy eager async generators use `ResultAsync.gen` / `ResultAsync.fn` from `"resultar/async"`.
- Are child Tasks composed instead of run inside generators? Are Task `map`
  callbacks synchronous? Is `inspect` / `inspectError` used for best-effort observation and Task `tap` / `tapError` for composable fallible effects?
- Does the boundary distinguish typed failures from defects/interruption/composites?
  Use `runExit` when all causes must be handled as values.
- Are services supplied by providers or runner options, without asserting away `R`?
  Do singleton/scoped/transient lifetimes obey the DI graph rules?
- Is each resource lifetime explicit? Does interruption await finalizers? Are cleanup
  failures observable? Does detached work still access resources being closed?
- Are retries repeatable and bounded? Is a timeout being incorrectly described as a
  hard deadline? Are races first-success or first-completion as intended?
- Are HTTP schemas validated with the correct transformed output type? Do framework
  bindings, locals, startup, and streaming cleanup match the adapter manual?
- Do `resultar-check` diagnostics pass under the project's policy? Intentional
  suppressions use `resultar-check-disable-next-line` / `resultar-check-disable-line`,
  with reasons and no stale entries. See the [checker guide](anti-patterns.md).
- Were public types, relevant behavior tests, and package/example checks run?
  In the Resultar workspace, behavior changes need targeted tests and a changeset.
  Do not report grader self-tests as an AI performance comparison.
