# Review generated Resultar code

Review the consumer's actual contracts and checker configuration. Optional rule
preferences are not universal runtime requirements.

- Is the chosen primitive correct? New async workflow: Task. Existing eager API:
  preserve ResultAsync. Does a bridge create work inside its factory on each run?
- Does a Promise signature belong to a driver/SDK input or an explicit native
  execution boundary? New application methods return Tasks without `async`; eager
  Result boundaries return `ResultAsync` / `StrictResultAsync` without `async`
  (never `Promise<ResultTask<...>>` or `Promise<Result<...>>`). Use `requestJsonTask` /
  `requestJsonZodTask` / `requestJsonTypeBoxTask` for lazy HTTP calls, `tryPromise`
  directly for raw Promise drivers, and `fromResultAsync` only for existing typed Async operations. Are negative checker fixtures labeled?
- Do calls exist in installed declarations with the correct static/instance form?
  Avoid copying similarly named APIs from other libraries.
- Are expected failures concrete and tagged where appropriate? Are causes retained,
  sensitive fields redacted, and generated constructors left intact?
- Are modern generator successes plain values, with `yield*` steps and explicit
  `return yield*` on failing branches? Sync Results may be yielded inside Tasks.
  Does legacy `safeTry` still return a final Result?
- Are child Tasks composed instead of run inside generators? Are Task `map`
  callbacks synchronous? Do effectful taps and best-effort inspectors retain semantics?
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
