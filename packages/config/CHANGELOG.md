# resultar-config

## 1.0.0

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

### Patch Changes

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
- 7ac4799: Preserve late acquisition cleanup through service and tracing wrappers. Handle synchronous aborts while reading HTTP responses and cancel stalled native Fetch streams through their readers.

  Harden core `ResultTask`, JIT, companion adapters, `resultar-check`, VS Code extension, and docs playground:

  - **Core (`resultar`)**: preserve all finalizer defects across multi-finalizer `TaskScope` drains in `race`/`timeout`; run synchronous `ResultTask.gen` `try/finally` blocks synchronously in `runSync()`/`runSyncExit()`, mark generator cleanup failures, and preserve external `Interrupt`; fix `RESULTAR_JIT=1` vs `RESULTAR_JIT=0` last-step `resumeSync` and `tryPromise` interruption parity; trap throwing `_tag` getters across all `catchTag`/`catchTags` tiers and guard `Cause.pretty` against throwing `Error.stack` getters, `BigInt`/circular span attributes, and shared non-circular references; fix `acquireDisposable` fallback when `[Symbol.asyncDispose]` is `undefined`; collapse pure external `race`/`raceAll` interruptions to `AbortError`; keep synchronous `tapCause` callbacks sync; isolate `ResultTask.memoize` cancellation, timeouts, and span traces per caller; compact `Semaphore` waiters and release aborted waiter references; unregister completed unjoined `Success` `forkChild` fibers; propagate `makeScope().close()` runtime context to finalizers and guard sync-abort-then-suspend in `scope.use()`; bail out before JIT codegen when `canUseJit()` is false; protect `Result.all`/`Result.validateAll`/`Tracer.memory()`/`createTaggedError` from `__proto__`, prototype interpolation, and `then`/`toJSON`/`findCause` overwrites; handle rejections in `ResultAsync.race*` and preserve `this` in `ResultAsync.fromThrowable`.
  - **Companion packages (`resultar-di`, `resultar-hono`, `resultar-fastify`, `resultar-nestjs`, `resultar-request`, `resultar-request-zod`, `resultar-request-typebox`, `resultar-config`)**: detect `transient` circular dependencies in `resultar-di`, enforce `useSingletons()` lifetime checks on overridden services, fix sync thenable detection, and allow `ServiceAccess.get()` during shutdown drain; cancel orphaned Hono wrapped responses when outer middleware throws or replaces `c.res`; fix NestJS Tier 2 pre-interceptor disconnect leaks, `handlerTimeout` `request.signal` propagation on FastifyAdapter, `initTimeout` cancellation/rollback, `@Inject(APP_SERVICES)` prototype preservation, and `createNestApp().close()` hook ordering; skip `locals()` on already-aborted requests in NestJS and Fastify Tier 2; defer `requestJson` `mapError` lazily, cancel stalled response bodies on abort/timeout, and serialize Fetch `Headers` in `HttpResponseErrorCauseError`; remove dangling `.d.ts.map` comments from companion type declarations.
  - **Checker & Editor (`resultar-check`, VS Code extension)**: fix Unicode byte-offset panic in `parseSuppressions` and support `-- reason` justifications; prevent destructive autofixes in `prefer-as-void`, `prefer-map`, `prefer-map-err`, `prefer-or-else-succeed`, `unnecessary-pipe`, `no-await-result-task`, and generator rules; analyze named `ResultTask.fn("span", ...)` overloads and RFC 0010 consumers/runners; preserve `!`/`as` receivers in `migrate-v5`; fix LSP `(0,0)` range matching, Windows case-insensitive paths, debounce handling, and `ResultTask.fn` refactor guards; fix absolute `tsconfig` `extends` and string-safe JSONC trailing-comma stripping; support hoisted monorepo binaries in `doctor`, split VS Code problem matchers, and harden VS Code LSP `EPIPE`/crash/multi-root handling.
- cacb729: Implement transparent CSP-safe JIT compilation, static DI graph specialization, and V8 runtime performance optimizations (RFC 0011) with zero public API changes and automatic `RESULTAR_JIT=0` / strict-CSP fallback:

  - **`resultar`**:
    - Unify `ResultTaskRuntimeContext` hidden-class property ordering, replace object instruction tags with V8 Smi numeric opcodes plus dedicated `OP_CATCH_TAG`/`OP_CATCH_TAGS`, specialize `pipe`/`flow`/`dual` by arity, pool `OkResultIterator` and continuation stacks, and remove boxing allocations in `tagged-match`.
    - Compile `$variable` message templates in `createTaggedError` once at class-creation time with shared frozen fingerprints and zero-tuple metadata copying, and cache `taggedEnum` constructors.
    - Add a lazy decision-tree JIT compiler for reusable `Match` matchers (`switch (v._tag)`, inlined built-in guards and nested object/array checks) plus a zero-allocation `Match.valueTags` fast path.
    - Add an unboxed `runTaskLoop` and tiered lazy JIT compilation for hot reusable `ResultTask` chains (`map`, `andThen`, `mapErr`, `catchAll`, `catchTag`, `catchTags`) with cooperative scheduler checkpoints, mid-chain async bailout, and `AbortSignal` preservation.
  - **`resultar-di` & `resultar-hono`**:
    - Add static dependency subgraph specialization (Tier 0 pure singleton/value, Tier 1 scoped/transient sync JIT, Tier 2 full `TaskScope` for resources/streams), replace per-request `children` `Set` allocations with counter-based draining, skip empty `Map` cloning and `defaultResolvers` recomputation, and skip empty `withServices({})` wrapping in `createHonoServices`.
  - **`resultar-request-typebox` & `resultar-config`**:
    - Cache compiled `TypeBox` `Compile(schema)` validators per schema in a `WeakMap` (with automatic `Value.Check` fallback under `RESULTAR_JIT=0` or uncompilable schemas) and lazily compile and cache Ajv validators once per `defineAppConfig` instance.
- Updated dependencies [cacb729]
- Updated dependencies [7348f02]
- Updated dependencies [8cd6a0c]
- Updated dependencies [8cd6a0c]
- Updated dependencies [7348f02]
- Updated dependencies [7ac4799]
- Updated dependencies [2e08b70]
- Updated dependencies [cacb729]
- Updated dependencies [364039c]
- Updated dependencies [ba1b381]
- Updated dependencies [46c28fa]
- Updated dependencies [ba1b381]
  - resultar@5.0.0
  - resultar-di@2.0.0

## 1.0.0-beta.1

### Patch Changes

- 7ac4799: Preserve late acquisition cleanup through service and tracing wrappers. Handle synchronous aborts while reading HTTP responses and cancel stalled native Fetch streams through their readers.
  
  Harden core `ResultTask`, JIT, companion adapters, `resultar-check`, VS Code extension, and docs playground:
  
  - **Core (`resultar`)**: preserve all finalizer defects across multi-finalizer `TaskScope` drains in `race`/`timeout`; run synchronous `ResultTask.gen` `try/finally` blocks synchronously in `runSync()`/`runSyncExit()`, mark generator cleanup failures, and preserve external `Interrupt`; fix `RESULTAR_JIT=1` vs `RESULTAR_JIT=0` last-step `resumeSync` and `tryPromise` interruption parity; trap throwing `_tag` getters across all `catchTag`/`catchTags` tiers and guard `Cause.pretty` against throwing `Error.stack` getters, `BigInt`/circular span attributes, and shared non-circular references; fix `acquireDisposable` fallback when `[Symbol.asyncDispose]` is `undefined`; collapse pure external `race`/`raceAll` interruptions to `AbortError`; keep synchronous `tapCause` callbacks sync; isolate `ResultTask.memoize` cancellation, timeouts, and span traces per caller; compact `Semaphore` waiters and release aborted waiter references; unregister completed unjoined `Success` `forkChild` fibers; propagate `makeScope().close()` runtime context to finalizers and guard sync-abort-then-suspend in `scope.use()`; bail out before JIT codegen when `canUseJit()` is false; protect `Result.all`/`Result.validateAll`/`Tracer.memory()`/`createTaggedError` from `__proto__`, prototype interpolation, and `then`/`toJSON`/`findCause` overwrites; handle rejections in `ResultAsync.race*` and preserve `this` in `ResultAsync.fromThrowable`.
  - **Companion packages (`resultar-di`, `resultar-hono`, `resultar-fastify`, `resultar-nestjs`, `resultar-request`, `resultar-request-zod`, `resultar-request-typebox`, `resultar-config`)**: detect `transient` circular dependencies in `resultar-di`, enforce `useSingletons()` lifetime checks on overridden services, fix sync thenable detection, and allow `ServiceAccess.get()` during shutdown drain; cancel orphaned Hono wrapped responses when outer middleware throws or replaces `c.res`; fix NestJS Tier 2 pre-interceptor disconnect leaks, `handlerTimeout` `request.signal` propagation on FastifyAdapter, `initTimeout` cancellation/rollback, `@Inject(APP_SERVICES)` prototype preservation, and `createNestApp().close()` hook ordering; skip `locals()` on already-aborted requests in NestJS and Fastify Tier 2; defer `requestJson` `mapError` lazily, cancel stalled response bodies on abort/timeout, and serialize Fetch `Headers` in `HttpResponseErrorCauseError`; remove dangling `.d.ts.map` comments from companion type declarations.
  - **Checker & Editor (`resultar-check`, VS Code extension)**: fix Unicode byte-offset panic in `parseSuppressions` and support `-- reason` justifications; prevent destructive autofixes in `prefer-as-void`, `prefer-map`, `prefer-map-err`, `prefer-or-else-succeed`, `unnecessary-pipe`, `no-await-result-task`, and generator rules; analyze named `ResultTask.fn("span", ...)` overloads and RFC 0010 consumers/runners; preserve `!`/`as` receivers in `migrate-v5`; fix LSP `(0,0)` range matching, Windows case-insensitive paths, debounce handling, and `ResultTask.fn` refactor guards; fix absolute `tsconfig` `extends` and string-safe JSONC trailing-comma stripping; support hoisted monorepo binaries in `doctor`, split VS Code problem matchers, and harden VS Code LSP `EPIPE`/crash/multi-root handling.
- Updated dependencies [7ac4799]
  - resultar@5.0.0-beta.2
  - resultar-di@2.0.0-beta.2

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

### Patch Changes

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
- cacb729: Implement transparent CSP-safe JIT compilation, static DI graph specialization, and V8 runtime performance optimizations (RFC 0011) with zero public API changes and automatic `RESULTAR_JIT=0` / strict-CSP fallback:
  
  - **`resultar`**:
    - Unify `ResultTaskRuntimeContext` hidden-class property ordering, replace object instruction tags with V8 Smi numeric opcodes plus dedicated `OP_CATCH_TAG`/`OP_CATCH_TAGS`, specialize `pipe`/`flow`/`dual` by arity, pool `OkResultIterator` and continuation stacks, and remove boxing allocations in `tagged-match`.
    - Compile `$variable` message templates in `createTaggedError` once at class-creation time with shared frozen fingerprints and zero-tuple metadata copying, and cache `taggedEnum` constructors.
    - Add a lazy decision-tree JIT compiler for reusable `Match` matchers (`switch (v._tag)`, inlined built-in guards and nested object/array checks) plus a zero-allocation `Match.valueTags` fast path.
    - Add an unboxed `runTaskLoop` and tiered lazy JIT compilation for hot reusable `ResultTask` chains (`map`, `andThen`, `mapErr`, `catchAll`, `catchTag`, `catchTags`) with cooperative scheduler checkpoints, mid-chain async bailout, and `AbortSignal` preservation.
  - **`resultar-di` & `resultar-hono`**:
    - Add static dependency subgraph specialization (Tier 0 pure singleton/value, Tier 1 scoped/transient sync JIT, Tier 2 full `TaskScope` for resources/streams), replace per-request `children` `Set` allocations with counter-based draining, skip empty `Map` cloning and `defaultResolvers` recomputation, and skip empty `withServices({})` wrapping in `createHonoServices`.
  - **`resultar-request-typebox` & `resultar-config`**:
    - Cache compiled `TypeBox` `Compile(schema)` validators per schema in a `WeakMap` (with automatic `Value.Check` fallback under `RESULTAR_JIT=0` or uncompilable schemas) and lazily compile and cache Ajv validators once per `defineAppConfig` instance.
- Updated dependencies [cacb729]
- Updated dependencies [7348f02]
- Updated dependencies [8cd6a0c]
- Updated dependencies [8cd6a0c]
- Updated dependencies [7348f02]
- Updated dependencies [cacb729]
- Updated dependencies [ba1b381]
- Updated dependencies [ba1b381]
  - resultar@5.0.0-beta.0
  - resultar-di@2.0.0-beta.0

## 0.3.0

### Minor Changes

- 6d50af4: Reexport TypeBox's `Type` as `t` so configuration schemas and `defineAppConfig`
  can be imported from `resultar-config` together. Preserve schema inference and
  compatibility with direct TypeBox imports. Move TypeBox from a peer dependency to
  a runtime dependency with range `>=1.3.4 <2.0.0`, so using `t` requires no separate
  TypeBox installation.
  Update the Hono example and configuration recipe to use the new alias.

### Patch Changes

- Updated dependencies [72e8b81]
  - resultar@4.1.1

## 0.2.0

### Minor Changes

- cfb4f9c: Add lazy TypeBox environment configuration modules with isolated snapshots, finite-number validation, safe aggregated ConfigError issues and exact DI graph inference.

  Use the configuration module in the Hono example, validating PORT before listening
  and sharing the validated snapshot with request services. Include isolated-source
  and invalid-startup smoke coverage.

  Add `AppConfigModule.load()` for direct typed configuration loading as a lazy
  ResultTask, with a fresh isolated snapshot per execution. Simplify Hono startup
  and document how to reuse the validated value in application services.

### Patch Changes

- Updated dependencies [ca8a242]
- Updated dependencies [cfb4f9c]
- Updated dependencies [210f3a3]
- Updated dependencies [6f4712a]
- Updated dependencies [210f3a3]
  - resultar@4.1.0
