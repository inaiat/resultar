# resultar-nestjs

## 2.0.0-beta.1

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
  - resultar-di@2.0.0-beta.1

## 2.0.0-beta.0

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
- 7348f02: Add Tier 0 / Tier 1 compiled synchronous request dispatch to `resultar-fastify` and `resultar-nestjs` via an internal `resultar-di` sync-plan bridge:
  
  - **`resultar-di`**: Attach a non-enumerable internal sync-plan bridge on root `ServiceScope` instances so framework adapters can share the compiled Tier 0 / Tier 1 subgraph resolvers and counter-based in-flight request tracking with zero public API changes.
  - **`resultar-fastify`**: Automatically run callback-style Fastify hooks backed by the compiled Tier 0 / Tier 1 resolver when no request-scoped resources, async tasks, or dynamic `exposeRequest` accessors are used (including single-slot local-key shape caching for synchronous and asynchronous `locals` factories), seamlessly falling back to the full `startSession` Tier 2 path otherwise. Reduces DI overhead per HTTP request by 16x–29x (reaching ~95% of raw Fastify throughput) while preserving abort, error identity, `ResultTaskCauseError`, shutdown draining, and `RESULTAR_JIT=0` parity.
  - **`resultar-nestjs`**: Automatically run synchronous Tier 0 / Tier 1 request initialization in `APP_INTERCEPTOR` (returning `next.handle()` directly without `from(Promise).pipe(switchMap(...))`) and `APP_GUARD` (returning `true` synchronously) with shared Fastify `onResponse`/`onRequestAbort` drain hooks and single-slot local-key caching, falling back seamlessly to `startSession` for Tier 2 resources, `exposeRequest`, or `handlerTimeout`. Speeds up NestJS HTTP requests by 1.55x–2.51x (reaching ~84% of raw NestJS in default `interceptor` mode and ~92% with `requestHook: "guard"`), and fixes `app.inject({ signal })` on Node.js 26 where `IncomingMessage.prototype.signal` is a getter-only property.
- 8cd6a0c: Fix second-review RFC 0010 / RFC 0011 follow-up regressions:
  
  - **`resultar`**: Restore `_tag`, `fingerprint`, `messageTemplate`, and `name` as own enumerable instance properties on `createTaggedError` instances (matching `cacb729` descriptors so `Object.keys(error)` and `{ ...error }` preserve discriminator and metadata) while keeping the shared frozen `fingerprint` tuple and 1-argument `super(message)` fast path when `cause` is omitted.
  - **`resultar-fastify`**: Observe `reply.raw` `close` alongside `onResponse` and `onRequestAbort` via a single idempotent finalizer on Tier 0 / Tier 1 fast request hooks (both static bindings and per-request `locals`), removing the listener on settlement and calling `endChild()` exactly once so `app.close()` never hangs after client disconnects during streamed replies.
  - **`resultar-nestjs`**: Apply the same idempotent `rawResponse` `close` finalizer to the Fastify-backed Tier 0 / Tier 1 fast request tracker so streamed client disconnects release child tracking cleanly without double-decrementing active requests.
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

## 1.0.0

### Major Changes

- 7684e1e: Add official `resultar-nestjs` integration package with `createNestModule`, `createNestApp`, `@Services()` parameter decorator, `APP_SERVICES` token, `InferRequestServices`, `InferAppServices`, per-request DI resource scopes, cancellation propagation, and startup tasks (defaulting to `@nestjs/platform-fastify`). Update the bundled Resultar agent guide and documentation with `resultar-nestjs`.

### Patch Changes

- Updated dependencies [7684e1e]
  - resultar@4.0.1
