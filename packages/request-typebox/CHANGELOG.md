# resultar-request-typebox

## 3.1.0

### Minor Changes

- Extend `mapError` in `resultar-request`, `resultar-request-typebox`, and `resultar-request-zod` via `RequestJsonMapErrorInput` to support partial handler objects with `orElse: (context: RequestJsonErrorContext) => Error` and a single-function shorthand `(context: RequestJsonErrorContext) => Error`, while preserving `RequestJsonMapError` backward compatibility, handler `this` binding, full exhaustiveness, and exact error union inference.

### Patch Changes

- Updated dependencies
- Updated dependencies [ea7fe8e]
- Updated dependencies
- Updated dependencies [310626a]
- Updated dependencies [5eb2e8e]
- Updated dependencies
  - resultar@5.1.0
  - resultar-request@3.1.0

## 3.0.0

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
- 7ac4799: Preserve late acquisition cleanup through service and tracing wrappers. Handle synchronous aborts while reading HTTP responses and cancel stalled native Fetch streams through their readers.

  Harden core `ResultTask`, JIT, companion adapters, `resultar-check`, VS Code extension, and docs playground:

  - **Core (`resultar`)**: preserve all finalizer defects across multi-finalizer `TaskScope` drains in `race`/`timeout`; run synchronous `ResultTask.gen` `try/finally` blocks synchronously in `runSync()`/`runSyncExit()`, mark generator cleanup failures, and preserve external `Interrupt`; fix `RESULTAR_JIT=1` vs `RESULTAR_JIT=0` last-step `resumeSync` and `tryPromise` interruption parity; trap throwing `_tag` getters across all `catchTag`/`catchTags` tiers and guard `Cause.pretty` against throwing `Error.stack` getters, `BigInt`/circular span attributes, and shared non-circular references; fix `acquireDisposable` fallback when `[Symbol.asyncDispose]` is `undefined`; collapse pure external `race`/`raceAll` interruptions to `AbortError`; keep synchronous `tapCause` callbacks sync; isolate `ResultTask.memoize` cancellation, timeouts, and span traces per caller; compact `Semaphore` waiters and release aborted waiter references; unregister completed unjoined `Success` `forkChild` fibers; propagate `makeScope().close()` runtime context to finalizers and guard sync-abort-then-suspend in `scope.use()`; bail out before JIT codegen when `canUseJit()` is false; protect `Result.all`/`Result.validateAll`/`Tracer.memory()`/`createTaggedError` from `__proto__`, prototype interpolation, and `then`/`toJSON`/`findCause` overwrites; handle rejections in `ResultAsync.race*` and preserve `this` in `ResultAsync.fromThrowable`.
  - **Companion packages (`resultar-di`, `resultar-hono`, `resultar-fastify`, `resultar-nestjs`, `resultar-request`, `resultar-request-zod`, `resultar-request-typebox`, `resultar-config`)**: detect `transient` circular dependencies in `resultar-di`, enforce `useSingletons()` lifetime checks on overridden services, fix sync thenable detection, and allow `ServiceAccess.get()` during shutdown drain; cancel orphaned Hono wrapped responses when outer middleware throws or replaces `c.res`; fix NestJS Tier 2 pre-interceptor disconnect leaks, `handlerTimeout` `request.signal` propagation on FastifyAdapter, `initTimeout` cancellation/rollback, `@Inject(APP_SERVICES)` prototype preservation, and `createNestApp().close()` hook ordering; skip `locals()` on already-aborted requests in NestJS and Fastify Tier 2; defer `requestJson` `mapError` lazily, cancel stalled response bodies on abort/timeout, and serialize Fetch `Headers` in `HttpResponseErrorCauseError`; remove dangling `.d.ts.map` comments from companion type declarations.
  - **Checker & Editor (`resultar-check`, VS Code extension)**: fix Unicode byte-offset panic in `parseSuppressions` and support `-- reason` justifications; prevent destructive autofixes in `prefer-as-void`, `prefer-map`, `prefer-map-err`, `prefer-or-else-succeed`, `unnecessary-pipe`, `no-await-result-task`, and generator rules; analyze named `ResultTask.fn("span", ...)` overloads and RFC 0010 consumers/runners; preserve `!`/`as` receivers in `migrate-v5`; fix LSP `(0,0)` range matching, Windows case-insensitive paths, debounce handling, and `ResultTask.fn` refactor guards; fix absolute `tsconfig` `extends` and string-safe JSONC trailing-comma stripping; support hoisted monorepo binaries in `doctor`, split VS Code problem matchers, and harden VS Code LSP `EPIPE`/crash/multi-root handling.
- 2e08b70: Fix duplicate execution in `ResultTask.runResult()`, native Promise adoption, tagged error formatting, and parity between compiled and interpreted Tasks. Synchronous runners now handle pure workflows through collection, recovery, and cleanup operators. Preserve cancellation and failure spans across scopes and deferred observers.

  Align request error causes and cancellation signals across HTTP adapters, defer TypeBox compilation until decoding, and synchronize dependency mappings in the JSR manifests.

  Keep Resultar quick fixes available alongside TypeScript semantic diagnostics, preserve callback semantics in tap suggestions, and apply nested v5 migrations to convergence. Editor setup supports JSONC.

  Preserve the original rejection reason from a failing `tryPromise` error mapper. Apply synchronous retry and repeat hooks without introducing a Promise. Honor deadline order across concurrent virtual clock drivers, retain nested composite span frames, and support tagged enum variants named after Object prototype properties.

  Exclude default and rest parameters from tap and tapError suggestions to preserve callback return values when applying fixes.

  Keep callback exceptions observable by withholding inspect autofixes for property access and destructuring, and skip tap suggestions for generator callbacks.

  Observe interruption between `ResultTask.iterate` steps that return synchronous Results. Honor custom clock sleeps when repeating with zero delay, including during `runSync()`.

  Preserve the original rejection reason when migrating to `runPromise()`, and honor scheduler budgets for synchronous `loop` and `firstSuccessOf` steps. Limit automatic `inspect` conversions to simple local writes. Migrate nested chains to convergence and generate fresh callback parameter names without shadowing handler bindings.

  Preserve composite failure typing, span outcomes, finalizer defects, and scheduler yields across Task execution modes. Support synchronous service resolution and disposal, and preserve object receivers in synchronous Result callbacks. Keep tagged enum factories compatible with Promise resolution and retain own metadata during serialization.

  Stop Fastify routes and subsequent hooks when a service hook fails with a falsy value or the request disconnects while resolving locals. Align locked response stream failures across DI execution paths. Skip schema compilation when TypeBox acceleration is unavailable. Preserve explicit eager types, optional execution, import bindings, and nested getters in migration and editor fixes.

  Report an invalid `catchReason` or `catchReasons` handler return as a defect when the reason matches.

  Check cancellation before computing a repeat delay when the clock aborts while reading the elapsed budget.
  Recognize Promise-like values returned by Task inspectors consistently with the retry and repeat hooks.
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
- Updated dependencies [8cd6a0c]
- Updated dependencies [8cd6a0c]
- Updated dependencies [7348f02]
- Updated dependencies [7ac4799]
- Updated dependencies [2e08b70]
- Updated dependencies [cacb729]
- Updated dependencies [ba1b381]
- Updated dependencies [46c28fa]
- Updated dependencies [ba1b381]
  - resultar@5.0.0
  - resultar-request@3.0.0

## 3.0.0-beta.2

### Patch Changes

- 7ac4799: Preserve late acquisition cleanup through service and tracing wrappers. Handle synchronous aborts while reading HTTP responses and cancel stalled native Fetch streams through their readers.
  
  Harden core `ResultTask`, JIT, companion adapters, `resultar-check`, VS Code extension, and docs playground:
  
  - **Core (`resultar`)**: preserve all finalizer defects across multi-finalizer `TaskScope` drains in `race`/`timeout`; run synchronous `ResultTask.gen` `try/finally` blocks synchronously in `runSync()`/`runSyncExit()`, mark generator cleanup failures, and preserve external `Interrupt`; fix `RESULTAR_JIT=1` vs `RESULTAR_JIT=0` last-step `resumeSync` and `tryPromise` interruption parity; trap throwing `_tag` getters across all `catchTag`/`catchTags` tiers and guard `Cause.pretty` against throwing `Error.stack` getters, `BigInt`/circular span attributes, and shared non-circular references; fix `acquireDisposable` fallback when `[Symbol.asyncDispose]` is `undefined`; collapse pure external `race`/`raceAll` interruptions to `AbortError`; keep synchronous `tapCause` callbacks sync; isolate `ResultTask.memoize` cancellation, timeouts, and span traces per caller; compact `Semaphore` waiters and release aborted waiter references; unregister completed unjoined `Success` `forkChild` fibers; propagate `makeScope().close()` runtime context to finalizers and guard sync-abort-then-suspend in `scope.use()`; bail out before JIT codegen when `canUseJit()` is false; protect `Result.all`/`Result.validateAll`/`Tracer.memory()`/`createTaggedError` from `__proto__`, prototype interpolation, and `then`/`toJSON`/`findCause` overwrites; handle rejections in `ResultAsync.race*` and preserve `this` in `ResultAsync.fromThrowable`.
  - **Companion packages (`resultar-di`, `resultar-hono`, `resultar-fastify`, `resultar-nestjs`, `resultar-request`, `resultar-request-zod`, `resultar-request-typebox`, `resultar-config`)**: detect `transient` circular dependencies in `resultar-di`, enforce `useSingletons()` lifetime checks on overridden services, fix sync thenable detection, and allow `ServiceAccess.get()` during shutdown drain; cancel orphaned Hono wrapped responses when outer middleware throws or replaces `c.res`; fix NestJS Tier 2 pre-interceptor disconnect leaks, `handlerTimeout` `request.signal` propagation on FastifyAdapter, `initTimeout` cancellation/rollback, `@Inject(APP_SERVICES)` prototype preservation, and `createNestApp().close()` hook ordering; skip `locals()` on already-aborted requests in NestJS and Fastify Tier 2; defer `requestJson` `mapError` lazily, cancel stalled response bodies on abort/timeout, and serialize Fetch `Headers` in `HttpResponseErrorCauseError`; remove dangling `.d.ts.map` comments from companion type declarations.
  - **Checker & Editor (`resultar-check`, VS Code extension)**: fix Unicode byte-offset panic in `parseSuppressions` and support `-- reason` justifications; prevent destructive autofixes in `prefer-as-void`, `prefer-map`, `prefer-map-err`, `prefer-or-else-succeed`, `unnecessary-pipe`, `no-await-result-task`, and generator rules; analyze named `ResultTask.fn("span", ...)` overloads and RFC 0010 consumers/runners; preserve `!`/`as` receivers in `migrate-v5`; fix LSP `(0,0)` range matching, Windows case-insensitive paths, debounce handling, and `ResultTask.fn` refactor guards; fix absolute `tsconfig` `extends` and string-safe JSONC trailing-comma stripping; support hoisted monorepo binaries in `doctor`, split VS Code problem matchers, and harden VS Code LSP `EPIPE`/crash/multi-root handling.
- Updated dependencies [7ac4799]
  - resultar@5.0.0-beta.2
  - resultar-request@3.0.0-beta.2

## 3.0.0-beta.1

### Patch Changes

- 2e08b70: Fix duplicate execution in `ResultTask.runResult()`, native Promise adoption, tagged error formatting, and parity between compiled and interpreted Tasks. Synchronous runners now handle pure workflows through collection, recovery, and cleanup operators. Preserve cancellation and failure spans across scopes and deferred observers.
  
  Align request error causes and cancellation signals across HTTP adapters, defer TypeBox compilation until decoding, and synchronize dependency mappings in the JSR manifests.
  
  Keep Resultar quick fixes available alongside TypeScript semantic diagnostics, preserve callback semantics in tap suggestions, and apply nested v5 migrations to convergence. Editor setup supports JSONC.
  
  Preserve the original rejection reason from a failing `tryPromise` error mapper. Apply synchronous retry and repeat hooks without introducing a Promise. Honor deadline order across concurrent virtual clock drivers, retain nested composite span frames, and support tagged enum variants named after Object prototype properties.
  
  Exclude default and rest parameters from tap and tapError suggestions to preserve callback return values when applying fixes.
  
  Keep callback exceptions observable by withholding inspect autofixes for property access and destructuring, and skip tap suggestions for generator callbacks.
  
  Observe interruption between `ResultTask.iterate` steps that return synchronous Results. Honor custom clock sleeps when repeating with zero delay, including during `runSync()`.
  
  Preserve the original rejection reason when migrating to `runPromise()`, and honor scheduler budgets for synchronous `loop` and `firstSuccessOf` steps. Limit automatic `inspect` conversions to simple local writes. Migrate nested chains to convergence and generate fresh callback parameter names without shadowing handler bindings.
  
  Preserve composite failure typing, span outcomes, finalizer defects, and scheduler yields across Task execution modes. Support synchronous service resolution and disposal, and preserve object receivers in synchronous Result callbacks. Keep tagged enum factories compatible with Promise resolution and retain own metadata during serialization.
  
  Stop Fastify routes and subsequent hooks when a service hook fails with a falsy value or the request disconnects while resolving locals. Align locked response stream failures across DI execution paths. Skip schema compilation when TypeBox acceleration is unavailable. Preserve explicit eager types, optional execution, import bindings, and nested getters in migration and editor fixes.
  
  Report an invalid `catchReason` or `catchReasons` handler return as a defect when the reason matches.
  
  Check cancellation before computing a repeat delay when the clock aborts while reading the elapsed budget.
  Recognize Promise-like values returned by Task inspectors consistently with the retry and repeat hooks.
- Updated dependencies [2e08b70]
  - resultar@5.0.0-beta.1
  - resultar-request@3.0.0-beta.1

## 3.0.0-beta.0

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
- Updated dependencies [8cd6a0c]
- Updated dependencies [8cd6a0c]
- Updated dependencies [7348f02]
- Updated dependencies [cacb729]
- Updated dependencies [ba1b381]
- Updated dependencies [ba1b381]
  - resultar@5.0.0-beta.0
  - resultar-request@3.0.0-beta.0

## 2.1.0

### Minor Changes

- 6d50af4: Reexport TypeBox's `Type` as `t` from the public entry point, allowing request helpers,
  schema builders and `t.Static` inference to be used from one import. Preserve direct
  TypeBox import compatibility and eager/lazy request behavior. Update documentation
  and the request example. Move TypeBox from a peer dependency to a runtime dependency
  with range `>=1.3.4 <2.0.0`, so using `t` requires no separate TypeBox installation.

### Patch Changes

- Updated dependencies [72e8b81]
  - resultar@4.1.1

## 2.0.0

### Major Changes

- Implement RFC 0005 contract safety, HTTP cancellation/error-stage fixes, and Task-native HTTP entrypoints:

  Breaking change: `RequestJsonSource` factories now receive a required `AbortSignal`
  argument. Existing zero-argument factories remain accepted, but consumers invoking
  a narrowed `RequestJsonSource` must pass a signal. Factories with an optional first
  parameter of another type must be wrapped in a callback that ignores the signal.
  The schema adapters expose the same changed input contract. Existing HTTP APIs
  remain eager; the new Task entrypoints are lazy.

  - `resultar-check`: add `no-promise-resultar` (`noPromiseResultar`, default `"error"`) to reject native `Promise<Result<T, E>>`, `Promise<StrictResult<T, E>>`, and `Promise<ResultTask<T, E, R>>` contracts and unannotated `async` wrappers, recommending direct `ResultAsync`, `StrictResultAsync`, or `ResultTask` returns without duplicating `prefer-result-async` findings.
  - `resultar-request`, `resultar-request-zod`, `resultar-request-typebox`: propagate `AbortSignal` cancellation through `requestJson` and retries (`signal` and `(signal) => Promise<Response>` request factories), stop retry scheduling immediately on cancellation while keeping cancellations inside the declared eager error channel, classify HTTP failures at their originating stage (only JSON parse `SyntaxError` reaches `invalidJson`), safely format unserializable HTTP metadata (circular/`bigint`/throwing headers) inside `HttpResponseErrorCauseError`, and add lazy repeatable `requestJsonTask`, `requestJsonZodTask`, and `requestJsonTypeBoxTask` entrypoints backed by `ResultTask` and `TaskClock`.
  - `resultar`: refresh bundled coding-agent manuals, generated API inventory, compiled recipes, and evaluation regression cases.

### Patch Changes

- Align human and coding-agent documentation with the public v4 contracts while preserving
  existing eager and deprecated behavior. Bundle the canonical manuals, generated API inventory,
  and compiled contract recipes with the core package. Route agents to relevant references
  instead of loading every manual by default.

  Correct runner failure channels, numeric retry options, callbacks, race semantics, service
  provision, resource ownership and checker defaults. Document request error helpers and lazy
  bridging. Add CI checks for public-surface drift, recipe behavior, checker severities and
  bundled links; extend generation graders with HTTP, DI, matching, retry and Cause scenarios.

  Clarify Promise input/output roles throughout the guides: new application methods expose
  Tasks, raw driver Promises adapt directly via tryPromise, existing typed Async operations
  use fromResultAsync, and native execution boundaries retain Promises. Label negative
  checker fixtures and exercise typed repository contracts, rejection mapping and cancellation.

- Updated dependencies
- Updated dependencies
  - resultar@4.0.2
  - resultar-request@2.0.0

## 1.0.0

### Major Changes

- 37e8a0f: Prepare the next core major with plain-value Result generators and unified `ResultTask` / `ResultAsync`
  execution boundaries in `resultar`. Preserve legacy synchronous and asynchronous safeTry
  Result-returning generators, tap observation behavior and checker configuration.
  Add best-effort task observation with inspect/inspectError. Retain unrelated
  deprecated synchronous method names with equivalent replacements. Result/ResultAsync tap remains
  best-effort observation; inspect provides the same behavior under the new name.

  Add scope-owned child fibers, structured races and timeouts, bounded task
  collections, per-attempt scoped retries, live/virtual clocks, and parallel causes.
  Preserve eager ResultAsync and lazy, repeatable ResultTask execution.

  Keep new static asynchronous matching compositional while preserving legacy instance terminals,
  retain errors for optional tagged recovery handlers and preserve union-table outputs,
  add typed Match contexts, and improve finite object-pattern exhaustiveness.
  Preserve native Hono response unions and Fastify response contracts.

  Recognize yielded Results and task collection/fiber consumers in the checker,
  and expose Match coverage in hover. Update companion cause inspection for
  parallel failures. Preserve existing `resultar` exports and Async-producing methods; exhaustive Cause consumers
  must handle the new Parallel branch, and corrected tagged recovery types retain
  errors that optional handlers do not guarantee to recover.

### Patch Changes

- f8458ae: Make `ResultTask` the preferred asynchronous workflow API and unify `ResultAsync` as the in-flight `Result` returned by `task.runResult()` in `resultar`.

  - Keep tasks lazy and repeatable, with explicit `runResult`, `runExit`, `runPromise`, and `runFork` boundaries. Tasks are not thenable; `map` remains synchronous.
  - Export `ResultAsync`, `StrictResultAsync`, and eager helpers from `resultar`. Preserve shared single execution, awaited callbacks, native Promise terminals and best-effort observation.
  - Preserve Async-producing compatibility methods on Result and tagged errors, plus explicit Task bridges.
  - `Result.gen` and `Result.fn` support synchronous and eager asynchronous generators with plain returns. The retained legacy `safeTry` preserves final-Result returns in both execution modes.
  - Keep `ResultTask.fromResultAsync` as a structural bridge accepting a Result-producing thenable or signal-aware factory.
  - HTTP request and lifecycle adapters preserve their eager public behavior using `resultar`.

- Updated dependencies [37e8a0f]
- Updated dependencies [b15966d]
- Updated dependencies [37e8a0f]
- Updated dependencies [37e8a0f]
- Updated dependencies [bfe38b4]
- Updated dependencies [bfe38b4]
- Updated dependencies [37e8a0f]
- Updated dependencies [37e8a0f]
- Updated dependencies [40b76f2]
- Updated dependencies [37e8a0f]
- Updated dependencies [37e8a0f]
- Updated dependencies [bfe38b4]
- Updated dependencies [37e8a0f]
- Updated dependencies [37e8a0f]
- Updated dependencies [37e8a0f]
- Updated dependencies [37e8a0f]
- Updated dependencies [bfe38b4]
- Updated dependencies [bfe38b4]
- Updated dependencies [bfe38b4]
- Updated dependencies [bfe38b4]
- Updated dependencies [37e8a0f]
- Updated dependencies [37e8a0f]
- Updated dependencies [37e8a0f]
- Updated dependencies [f8458ae]
- Updated dependencies [c6aed8b]
- Updated dependencies [37e8a0f]
  - resultar@4.0.0
  - resultar-request@1.0.0

## 0.1.2

### Patch Changes

- 93b11c1: Document the JSR entrypoints and exported symbols used by Resultar and its request packages.
- b913a80: - **resultar**: Corrected `ResultAsyncRetryContext.attempt` JSDoc starting value to 0, streamlined concurrent traversal scheduling to avoid duplicate finish invocations, and added timer cleanup validation on retry aborts.
  - **resultar-request**: Guarded response `text()` and `json()` against synchronous throws and promise rejections outside `ResultAsync`, implemented safe serialization for circular references and BigInt values in `RequestError.exception`, mapped `BodyTimeoutError` and `TimeoutError` to status 408, and updated internal dependencies to caret workspace ranges.
  - **resultar-request-typebox**: Preserved `code` and `path` in TypeBox validation error items, widened `typebox` peer dependency to `^1.3.4`, and updated internal dependencies to caret workspace ranges.
  - **resultar-request-zod**: Widened `zod` peer dependency to `^4.4.3` and updated internal dependencies to caret workspace ranges.
- Updated dependencies [93b11c1]
- Updated dependencies [b913a80]
  - resultar@3.5.2
  - resultar-request@0.1.2

## 0.1.1

### Patch Changes

- 8ab30ff: Clarify the recommended validation workflow, request examples, runtime requirements, and published
  documentation links across the checker and request packages.
- Updated dependencies [8ab30ff]
- Updated dependencies [8ab30ff]
  - resultar@3.5.1
  - resultar-request@0.1.1

## 0.1.0

### Minor Changes

- f7f8fbd: Add fetch-first JSON request helpers with validator-neutral core support plus TypeBox and Zod adapters.

### Patch Changes

- Updated dependencies
- Updated dependencies [f7f8fbd]
- Updated dependencies [dfbfcb3]
  - resultar@3.5.0
  - resultar-request@0.1.0
