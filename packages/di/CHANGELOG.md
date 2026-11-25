# resultar-di

## 2.0.0

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
- 7348f02: Fix RFC 0010 and RFC 0011 runtime, concurrency, observability, and DI regressions:

  - **`resultar`**:
    - Add a browser-compatible macrotask scheduler fallback (`setTimeout(..., 0)` / `clearTimeout` when `setImmediate` is unavailable) in `VirtualClock.flush()` and `Scheduler.live.yield()`, preserving FIFO wake order and abort cancellation across Node, browsers, and edge runtimes.
    - Allocate a distinct `Interrupt` `Cause` per operation on `Queue.shutdown()` and closed-queue `take()`, preventing span trace cross-contamination across queues and concurrent consumers.
    - Switch `Queue` waiter storage to FIFO `Set`s and immediately unlink and clear payload, callback, and signal references upon offer/take cancellation.
    - Remove consumer-exposed pooling from `OkResultIterator` and `ResultTaskIterator` so retained `.next()` results and simultaneous iterators never alias or mutate each other.
    - Ensure `Match` JIT evaluates property and array element getters strictly once in interpreter-identical order (fixing multi-read predicates such as `Match.nonEmptyString`, `Match.record`, `Match.defined`, zero-read `Match.any`, and `NaN` literals).
  - **`resultar-di` & `resultar-hono`**:
    - Replace delimiter-joined sync plan cache keys in `RuntimeScope.getSyncPlan` with structural JSON tuple keys so service names containing NUL or control characters cannot collide.
    - Cache frozen middleware key selections and avoid unnecessary async microtask hops for synchronous `locals` factories in `createHonoServices().middleware()`.
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
- 364039c: Replace dynamic `new Function` code generation in `resultar-di` sync plans with a CSP-safe pure-JavaScript resolver, harden binding/resolver record construction against inherited `Object.prototype` setters, and fix HTTP adapter regressions:

  - `resultar-hono`: keep fast-path middleware scopes open through response stream consumption or cancellation and cancel source streams on request abort.
  - `resultar-nestjs`: keep Fastify 5 `request.signal` lazy (including on Node 26+ `IncomingMessage.prototype.signal`) while honoring own `request.signal` getters installed by hooks on routes without `handlerTimeout`.
  - `resultar-fastify`: decrement the dynamic Tier 2 active counter on client disconnect and abort paths so subsequent unscoped responses skip `WeakMap` lookups.
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

## 2.0.0-beta.3

### Patch Changes

- 364039c: Replace dynamic `new Function` code generation in `resultar-di` sync plans with a CSP-safe pure-JavaScript resolver, harden binding/resolver record construction against inherited `Object.prototype` setters, and fix HTTP adapter regressions:
  
  - `resultar-hono`: keep fast-path middleware scopes open through response stream consumption or cancellation and cancel source streams on request abort.
  - `resultar-nestjs`: keep Fastify 5 `request.signal` lazy (including on Node 26+ `IncomingMessage.prototype.signal`) while honoring own `request.signal` getters installed by hooks on routes without `handlerTimeout`.
  - `resultar-fastify`: decrement the dynamic Tier 2 active counter on client disconnect and abort paths so subsequent unscoped responses skip `WeakMap` lookups.
- Updated dependencies [46c28fa]
  - resultar@5.0.0-beta.3

## 2.0.0-beta.2

### Patch Changes

- 7ac4799: Preserve late acquisition cleanup through service and tracing wrappers. Handle synchronous aborts while reading HTTP responses and cancel stalled native Fetch streams through their readers.
  
  Harden core `ResultTask`, JIT, companion adapters, `resultar-check`, VS Code extension, and docs playground:
  
  - **Core (`resultar`)**: preserve all finalizer defects across multi-finalizer `TaskScope` drains in `race`/`timeout`; run synchronous `ResultTask.gen` `try/finally` blocks synchronously in `runSync()`/`runSyncExit()`, mark generator cleanup failures, and preserve external `Interrupt`; fix `RESULTAR_JIT=1` vs `RESULTAR_JIT=0` last-step `resumeSync` and `tryPromise` interruption parity; trap throwing `_tag` getters across all `catchTag`/`catchTags` tiers and guard `Cause.pretty` against throwing `Error.stack` getters, `BigInt`/circular span attributes, and shared non-circular references; fix `acquireDisposable` fallback when `[Symbol.asyncDispose]` is `undefined`; collapse pure external `race`/`raceAll` interruptions to `AbortError`; keep synchronous `tapCause` callbacks sync; isolate `ResultTask.memoize` cancellation, timeouts, and span traces per caller; compact `Semaphore` waiters and release aborted waiter references; unregister completed unjoined `Success` `forkChild` fibers; propagate `makeScope().close()` runtime context to finalizers and guard sync-abort-then-suspend in `scope.use()`; bail out before JIT codegen when `canUseJit()` is false; protect `Result.all`/`Result.validateAll`/`Tracer.memory()`/`createTaggedError` from `__proto__`, prototype interpolation, and `then`/`toJSON`/`findCause` overwrites; handle rejections in `ResultAsync.race*` and preserve `this` in `ResultAsync.fromThrowable`.
  - **Companion packages (`resultar-di`, `resultar-hono`, `resultar-fastify`, `resultar-nestjs`, `resultar-request`, `resultar-request-zod`, `resultar-request-typebox`, `resultar-config`)**: detect `transient` circular dependencies in `resultar-di`, enforce `useSingletons()` lifetime checks on overridden services, fix sync thenable detection, and allow `ServiceAccess.get()` during shutdown drain; cancel orphaned Hono wrapped responses when outer middleware throws or replaces `c.res`; fix NestJS Tier 2 pre-interceptor disconnect leaks, `handlerTimeout` `request.signal` propagation on FastifyAdapter, `initTimeout` cancellation/rollback, `@Inject(APP_SERVICES)` prototype preservation, and `createNestApp().close()` hook ordering; skip `locals()` on already-aborted requests in NestJS and Fastify Tier 2; defer `requestJson` `mapError` lazily, cancel stalled response bodies on abort/timeout, and serialize Fetch `Headers` in `HttpResponseErrorCauseError`; remove dangling `.d.ts.map` comments from companion type declarations.
  - **Checker & Editor (`resultar-check`, VS Code extension)**: fix Unicode byte-offset panic in `parseSuppressions` and support `-- reason` justifications; prevent destructive autofixes in `prefer-as-void`, `prefer-map`, `prefer-map-err`, `prefer-or-else-succeed`, `unnecessary-pipe`, `no-await-result-task`, and generator rules; analyze named `ResultTask.fn("span", ...)` overloads and RFC 0010 consumers/runners; preserve `!`/`as` receivers in `migrate-v5`; fix LSP `(0,0)` range matching, Windows case-insensitive paths, debounce handling, and `ResultTask.fn` refactor guards; fix absolute `tsconfig` `extends` and string-safe JSONC trailing-comma stripping; support hoisted monorepo binaries in `doctor`, split VS Code problem matchers, and harden VS Code LSP `EPIPE`/crash/multi-root handling.
- Updated dependencies [7ac4799]
  - resultar@5.0.0-beta.2

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
- 7348f02: Fix RFC 0010 and RFC 0011 runtime, concurrency, observability, and DI regressions:
  
  - **`resultar`**:
    - Add a browser-compatible macrotask scheduler fallback (`setTimeout(..., 0)` / `clearTimeout` when `setImmediate` is unavailable) in `VirtualClock.flush()` and `Scheduler.live.yield()`, preserving FIFO wake order and abort cancellation across Node, browsers, and edge runtimes.
    - Allocate a distinct `Interrupt` `Cause` per operation on `Queue.shutdown()` and closed-queue `take()`, preventing span trace cross-contamination across queues and concurrent consumers.
    - Switch `Queue` waiter storage to FIFO `Set`s and immediately unlink and clear payload, callback, and signal references upon offer/take cancellation.
    - Remove consumer-exposed pooling from `OkResultIterator` and `ResultTaskIterator` so retained `.next()` results and simultaneous iterators never alias or mutate each other.
    - Ensure `Match` JIT evaluates property and array element getters strictly once in interpreter-identical order (fixing multi-read predicates such as `Match.nonEmptyString`, `Match.record`, `Match.defined`, zero-read `Match.any`, and `NaN` literals).
  - **`resultar-di` & `resultar-hono`**:
    - Replace delimiter-joined sync plan cache keys in `RuntimeScope.getSyncPlan` with structural JSON tuple keys so service names containing NUL or control characters cannot collide.
    - Cache frozen middleware key selections and avoid unnecessary async microtask hops for synchronous `locals` factories in `createHonoServices().middleware()`.
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

## 0.4.1

### Patch Changes

- d6eefe0: Allow Service factories to omit requires when they do not declare injected dependencies. Preserve lazy construction, explicit contracts, inferred task requirements and errors, and rejection of Promise factories.

## 0.4.0

### Minor Changes

- 9f5fa1f: Allow class services with `requires` to return synchronous service values directly from `make`,
  without wrapping ordinary object construction in `ResultTask.sync`.

  Keep task-returning factories and generator-based definitions compatible. Normalize construction
  to a lazy `ResultTask`, preserving dependency inference, explicit contracts, lifetimes and cleanup.
  Reject Promise and callable-then factory returns, including unions with synchronous values.
  Update the adapter examples and bundled agent guide to demonstrate the simpler factory form.
  Add optional application startup tasks to the Fastify and
  Hono adapters, with `R` validation, one-time lazy execution and rollback on failure.
  Run Fastify startup in `onReady`, supporting a native application factory. Retain startup resources
  until shutdown through a shared DI session, release them before singleton dependencies, and preserve
  initialization and cleanup failures. Hono close cancels pending startup and blocks waiting requests.
  Expose `startServiceTask`, `ServiceTaskSession` and `ServiceTaskRequirements` from DI for adapters
  that need the same task lifecycle and dependency validation.

  Consolidate the DI documentation into its README, removing the separate advanced guide and updating
  package contents and agent documentation links.

### Patch Changes

- Updated dependencies [9f5fa1f]
  - resultar@3.9.1

## 0.3.0

### Minor Changes

- 2fc19dd: Infer literal service identifiers with `ResultTask.service<Contract>()("name")` while retaining the direct overload.

  Add `Service.require<Contract>()("name")` and optional `Service` dependency maps through `requires`. Construction factories receive inferred readonly dependencies and return a lazy ResultTask. Existing generator-only definitions, token identity, typed requirements and scope lifetimes remain supported.

  Require Resultar 3.9 or newer in the DI package's JSR import map so the curried service primitive is available.

  Make the Fastify and Hono examples self-contained, with class services using explicit `requires` maps, a repository, cache and function-based health service. Import the primary DI API through each framework integration and keep matching file layouts for services, routes and server startup. Omit optional bindings in both examples to expose all registered services.

- 2fc19dd: BREAKING: remove the `resultar-di/advanced` entry point. Replace all imports from
  `resultar-di/advanced` with `resultar-di` before upgrading. The pre-1.0 DI package
  ships this breaking change in its next minor release.

  Expose one `createModule` and `ServiceModule` supporting token/class registration,
  named factories, task/resource registration, and fluent composition. Export
  `inspectModule`, `withProvider`, `useServiceAccess`, `ServiceAccessError` and their
  public types from the same entry point. Resolution, lazy initialization, lifetimes
  and resource ownership remain unchanged. No compatibility alias is retained.

  Update Fastify and Hono to use the unified entry point while preserving their
  explicit application-facing DI reexports. External framework facades that
  imported the removed subpath must migrate their imports when adopting this release.

### Patch Changes

- 2fc19dd: Allow omitting `bindings` in `createFastifyApp`, `createFastifyPlugin` and `createHonoApp`.
  Omission selects all registered services, validates their requirements and infers their
  readonly request view. Explicit selections and `bindings: []` retain their existing behavior;
  Fastify `appBindings` still defaults to an empty selection. Request locals satisfy dependencies
  but are not automatically exposed as registered services.
  Explicit selections must be literal tuples; ambiguous tuple unions and widened arrays are
  rejected so request types cannot promise services absent from the runtime selection.

  Selected services are resolved before the handler, preserving lazy application construction,
  scope lifetimes, failure propagation and cleanup. This is not property-based lazy resolution:
  a failure acquiring any default-selected service prevents the handler from executing.

  Use the Fastify and Hono example applications as integration cases in each package's test suite,
  covering their real service graph, native routes, overrides and application isolation without
  starting a listener. Both examples demonstrate omitted bindings and inferred application types.

- Updated dependencies [2fc19dd]
  - resultar@3.9.0

## 0.2.0

### Minor Changes

- c823e56: Support framework facades that retain synchronous, lazy service access while sharing Resultar DI's
  resolution cache, lifetime checks and resource ownership. Add advanced provider registration,
  module metadata and scoped service access, backed by synchronous finalizer registration on a
  ResultTask scope owner. Existing native module factory timing remains unchanged.

  Allow Fastify facades to choose onRequest registration, expose application/request service views
  and map terminal lifecycle errors. Native selected-service defaults remain in preHandler. Facades
  can opt to report rollback failures only at startup without repeating them on subsequent close.

- 1ffab20: Add a native Fastify plugin with typed application and request service selections, request locals,
  startup rollback, cancellation and resource cleanup through streamed responses. Add per-route
  Hono services middleware that preserves native bindings and RPC inference. Both integrations
  reuse Resultar DI scopes; application callbacks can explicitly restrict resolution to singletons
  with useSingletons. Existing createHonoApp behavior remains compatible.
  Compose Fastify lifecycle recovery with Resultar while preserving original failures and awaited rollback.

### Patch Changes

- Updated dependencies [8bf0d07]
- Updated dependencies [c823e56]
- Updated dependencies [c823e56]
  - resultar@3.8.0

## 0.1.0

### Minor Changes

- fcf0f14: Introduce typed, immutable service modules with explicit dependencies, lazy graph selection,
  dedicated singleton/scoped/transient registration methods, long-lived roots, task and resource providers, and value
  overrides for tests. Delegate execution and resource finalization to ResultTask scopes, preserving
  typed errors and failure causes. Add class-shaped `Service` tokens whose dependencies are resolved
  with `yield*`, including singleton, scoped, and transient lifetimes.

  Require synchronous creation functions to declare a dependency parameter when their registration
  selects dependencies, reporting accidental zero-argument callbacks at the registration.

  Validate registered service contracts, resolve tokens inside use callbacks and finalizers, and
  detect dependency cycles. Share concurrent singleton initialization with retry after failure,
  retain class resources until their owning scope closes, and roll back partial acquisitions.
  Make close lazy and idempotent, wait for active child scopes, and retain all cleanup causes.

- fcf0f14: Add module.http() to acquire a Fetch application with automatic root ownership and response
  scopes. Simplify the Hono example to reuse one router with request services in typed bindings.
  Move class-shaped Service exports to resultar-di/advanced and separate the advanced reference
  from the main API guide. Add a repeatable local comparison of shared and per-request routers.
- fcf0f14: Prune overridden provider errors and requirements from the type graph. Replace branching type
  traversal with dependency-set traversal to prevent excessive instantiation in larger graphs.
  Add repeatable public-declaration scale checks and improve resolution-path diagnostics.
- fcf0f14: Keep token registration in the primary autocomplete throughout fluent composition. Move named registration overloads and module-level task/resource typing to the advanced entry point. Explain duplicate registrations and asynchronous factory mistakes in compiler diagnostics.
- fcf0f14: Add inferred service and resource tokens that share singleton/scoped/transient registration,
  immutable module merging, and typed request-local values. Add a Fetch-compatible scope adapter
  that retains resources through response streaming and cancellation, with a Hono example using
  one child per request. Infer errors and requirements from selected dependencies with bounded
  type traversal, improve incompatible-contract diagnostics, and preserve close error types.

### Patch Changes

- 28ec63c: Name unregistered dependencies in registration type errors. Singleton, scoped, transient, task, and resource dependency lists now report `Service "x" is not registered; register it before listing it as a dependency` instead of collapsing to an unreadable `never` mismatch.
- fcf0f14: Add typed Hono bindings, response-scoped service ownership and explicit application shutdown. Provide a runnable Deno example without runtime-specific adapters. Export adapter type helpers from DI's advanced entry point and generate declaration imports that resolve in Deno workspace consumers.
- Updated dependencies [fcf0f14]
- Updated dependencies [fcf0f14]
- Updated dependencies [fcf0f14]
  - resultar@3.7.0
