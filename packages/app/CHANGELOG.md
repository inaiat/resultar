# resultar-app

## 1.0.0-beta.0

### Major Changes

- ba1b381: Implement RFC 0012 — v5 unified async model (`Result` + `ResultTask`):
  
  - **Core `resultar`:**
    - `task.runResult()` and `ResultTask.runResult(task)` now return a native `Promise<Result<A, E | ScopeError<R>>>` instead of `ResultAsync`, eliminating the global `registerResultAsyncFactory` side-effect registry and making `resultar/task` and `resultar/result` genuinely tree-shakeable with zero transitive `result-async/` JS or `.d.ts` imports.
    - Root `"resultar"` exports only `Result` (pure sync) + `ResultTask` / `StrictResultTask` (lazy async) + shared primitives (`Match`, tagged errors, concurrency, observability, retry, function helpers). All v4 deprecated aliases (`safeTry`, `tryCatch`, `succeed`/`fail`, `mapError`, `flatMap`, `catchAll`, `toResultAsync`, `TaggedError.errAsync`, `Result#tap`/`tapError`, `Result#asyncMap`/`asyncAndThen`, async `Result.gen`/`Result.fn`, legacy Match/Retry option shapes) are removed from root `"resultar"`.
    - Opt-in `@deprecated` `"resultar/async"` compatibility subpath retains the full v4 eager `ResultAsync` surface throughout v5.x (`ResultAsync`, `StrictResultAsync`, `DisposableResultAsync`, `okAsync`, `errAsync`, `unitAsync`, `fromPromise`, `fromSafePromise`, `tryResultAsync`, `fromCallback`, `fromThrowableAsync`, `runPromise`, `tryAsync` / `tryCatchAsync`, `safeTry`, `ResultAsync.gen` / `ResultAsync.fn`, standalone `asyncMap` / `asyncAndThen`, and `@deprecated` v4 `ResultAsync` helpers such as `fromTask`, `retry`, `withResource`, `fromCallback`, `all`, `race`, `timeout`, `tap`, `tapError`, and `toAsyncDisposable`) for incremental migration, per `docs/migrations/v5.md`.
  - **HTTP request adapters (`resultar-request`, `resultar-request-zod`, `resultar-request-typebox`):**
    - `requestJson`, `requestJsonZod`, and `requestJsonTypeBox` now return `ResultTask` directly; `*Task` duplicates and `ResultAsync` coupling are removed.
  - **DI & framework adapters (`resultar-di`, `resultar-hono`, `resultar-fastify`, `resultar-nestjs`, `resultar-app`, `resultar-config`):**
    - Removed all `ResultAsync` imports and internal `ResultAsync.fromCallback` usage; imperative lifecycle boundaries (`ready()`, `close()`, session completions) return native `Promise<Result<...>>` / `Promise<Exit<...>>` directly.
  - **Static analyzer (`resultar-check`):**
    - Added `no-await-result-task` (default `"error"`, 43 rules total) with safe `.runResult()` autofix only when narrowed, requirement-free, and the surrounding context positively expects a `Result` (preserving inferred `Promise<ResultTask<...>>` returns and removing redundant `await` when the surrounding contract expects a `ResultTask`).
    - Updated `no-promise-resultar` to flag `Promise<ResultTask>` / `Promise<StrictResultTask>` / mixed Task unions while allowing `Promise<Result>` / `Promise<StrictResult>` execution boundaries.
    - Changed `prefer-result-async` default from `"warning"` to `"off"`, and scoped `prefer-tap` / `prefer-tap-error` to `tap`/`tapError` on `ResultTask` and `inspect`/`inspectError` on `Result`/`ResultAsync`.
    - Added the `resultar-check migrate-v5` CLI subcommand (`preview`, `--fix`, `--json`, `--file`) with symbol-resolved rewrites, alias preservation when `requestJson*` would collide with local bindings, safe computed-key and legacy `{ ok, error }` handler preservation in `match`, and the [v5 Migration Guide](docs/migrations/v5.md).

### Minor Changes

- cacb729: Add DX, observability, concurrency, tree-shaking, tooling, and documentation upgrades:
  
  - **`resultar` (and re-exported via `resultar-app`)**:
    - Core ergonomics & asymmetries: `ResultTask.suspend`, `task.scoped()`, `task.forkChild()`, `FiberHandle.await()`, `ResultTask.raceAll`, `ResultTask.raceFirstAll`, `ResultTask.runSync` / `runSyncExit`, `task.repeat()` / `ResultTask.repeat()`, `Cause` constructors (`fail`, `die`, `interrupt`, `sequential`, `parallel`, `isInterruptedOnly`, `spans`), enriched `ResultTaskCauseError` formatting (`prettyCause` and custom Node inspect), `VirtualClock.advanceToNext()` and `VirtualClock.runToCompletion()`, and `Retry.policy` `maxDelayMs`, `maxElapsedMs`, and error-aware `delayMs(context, error)`.
    - Lean concurrency primitives: `Ref`, `Deferred`, and bounded/unbounded `Queue` with FIFO backpressure and lossless shutdown draining.
    - Opt-in zero-overhead observability: `TaskLocal` (fiber-inherited ambient state), `Tracer` (`Tracer.noop`, `Tracer.memory()`, custom `TaskTracer`), `task.withSpan()` / `ResultTask.withSpan()`, named `ResultTask.fn(spanName, body, ...pipes)`, and automatic failure span traces on `Cause`.
    - Fine-grained tree-shaking: `"sideEffects": false` across library packages plus dedicated `resultar/result`, `resultar/task`, `resultar/match`, `resultar/tagged`, `resultar/retry`, and `resultar/function` subpath exports.
  - **`resultar-check`**:
    - Add `--fix` and `--fix-dry-run` flags to apply only safe `kind: "correction"` edits (never `intentional-discard`) and re-verify diagnostics.
    - Extend `init` and `doctor` with `--editor zed|vscode|cursor|all` (generating `.vscode/tasks.json` with a `resultar-check` problemMatcher, `.vscode/extensions.json` recommending `inaiat.resultar-check`, and `.cursor/rules/resultar-check.mdc` alongside `.zed/settings.json`).
  - **Editors, docs portal & agent guides**:
    - Add the official zero-dependency VS Code & Cursor LSP extension (`editors/vscode/`) exposing live `resultar-check lsp` diagnostics, `T / E / R` channel hover, inline quickfixes, and `--fix`/`overview` commands.
    - Add the searchable documentation site and interactive browser playground (`website/`, generated directly from CI-verified Markdown with Cmd+K search, 6 live presets, shareable URLs, and span waterfall visualization).
    - Add `docs/coming-from-effect.md` and `docs/rfcs/rfc-0010-dx-observability-concurrency-and-tooling.md`, eliminate doc drifts across `README.md`, `DOCUMENTATION.md`, `llms.txt`, package READMEs, and `skills/resultar/`, enrich core JSDoc + `@example` blocks, and add automated drift and snippet compilation assertions to `scripts/test-documentation.mjs`.

### Patch Changes

- 8cd6a0c: Resolve all 12 final-review findings across RFC 0010 and RFC 0011:
  
  - **`resultar`**:
    - Interrupt and clean up asynchronous steps (detaching waiters and suppressing pending continuations such as `.map()`) when `runSync` / `runSyncExit` encounters an asynchronous boundary.
    - Preserve explicit `null` abort reasons in `FiberSignal.abort` (only synthesizing default `DOMException('AbortError')` when `reason === undefined`), matching `runExit` in `runSyncExit` across JIT modes.
    - Isolate `TaskLocal` bindings per item in `ResultTask.all` / `forEach` / `validateAll` while preserving the worker's `scheduling.remaining` yield budget across items.
    - Preserve the `this` receiver for `try` and `catch` methods in JIT-compiled `ResultTask.try` chains.
    - Replace the growing array in `Queue.bounded` with a fixed-capacity circular ring buffer (and periodic compaction in `Queue.unbounded`) so long-running non-empty queues stay O(capacity) in memory.
    - Keep driving `VirtualClock.runToCompletion` automatically when virtual sleeps are scheduled after external Promises during normal execution (success or domain failure) as well as during post-`maxSteps` cleanup (including delayed timers and >10,000 finite sleeps), aborting and draining finalizers before throwing `RangeError`.
    - Clone failure `Cause` values per observer in `Deferred` while preserving origin span traces via `copyCauseSpans`, preventing cross-consumer span contamination.
    - Snapshot input iterables eagerly in `ResultTask.raceAll` and `ResultTask.raceFirstAll` (with an empty-list runtime guard) so post-construction array mutations cannot yield `Success(undefined)`.
    - Interrupt blocked producers waiting in `Queue.shutdown()` (matching RFC 0010 §4) while continuing to resolve subsequent `offer()` calls after shutdown with `Success(false)`.
    - Handle numeric `NaN` tags identically to the interpreter in compiled `Match.discriminator` for both `<= 4` and `> 4` tag lists.
  - **`resultar-di`**:
    - Propagate `request.signal` aborts after `scope.fetch` delivers a sync or async `Response` on the Tier 0 / Tier 1 fast path, coordinating overlapping or re-entrant `reader.cancel()` and `request.signal` aborts onto a single shared cancellation promise published synchronously before invoking the producer's `cancel()` (across both fast-path and resource-scoped `fetch`), keeping scopes open until producer cleanup finishes, and rejecting already-locked response bodies consistently while releasing the scope once.
    - Preserve services named `"__proto__"` as own enumerable properties across compiled plans, interpreted fallbacks, and service resolvers without prototype mutation.
  - **`resultar-config` & `resultar-app`**:
    - Remove the top-level `env-schema` dependency whose module initialization invoked `new Function` via AJV on import, so all workspace packages import and construct lazy definitions cleanly under `node --disallow-code-generation-from-strings`, and document that AJV compilation still applies lazily at `appConfig` / `load()` resolution time.
- Updated dependencies [cacb729]
- Updated dependencies [7348f02]
- Updated dependencies [8cd6a0c]
- Updated dependencies [8cd6a0c]
- Updated dependencies [7348f02]
- Updated dependencies [cacb729]
- Updated dependencies [ba1b381]
- Updated dependencies [ba1b381]
  - resultar@5.0.0-beta.0
  - resultar-config@1.0.0-beta.0
  - resultar-di@2.0.0-beta.0

## 0.1.0

### Minor Changes

- 6d50af4: Add resultar-app as the unified entry point for Resultar workflows, dependency
  injection and configuration. Reexport the existing implementations and types,
  including the TypeBox t alias, preserving runtime identity and execution semantics.
  Applications can install resultar-app and keep framework adapters as explicit
  integrations. Migrate the Hono example to the unified entry point.

### Patch Changes

- Updated dependencies [72e8b81]
- Updated dependencies [6d50af4]
  - resultar@4.1.1
  - resultar-config@0.3.0
