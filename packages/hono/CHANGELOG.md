# resultar-hono

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
- Updated dependencies [7348f02]
- Updated dependencies [8cd6a0c]
- Updated dependencies [8cd6a0c]
- Updated dependencies [7348f02]
- Updated dependencies [cacb729]
- Updated dependencies [ba1b381]
- Updated dependencies [ba1b381]
  - resultar@5.0.0-beta.0
  - resultar-di@2.0.0-beta.0

## 1.1.0

### Minor Changes

- ca8a242: Add lazy `ResultTask.fromCallback` subscriptions with per-execution cancellation, synchronous cleanup and preserved failure causes. Keep the legacy eager adapter unchanged.

  Accept resource factories that propagate `ResultTaskScope` across functions and files, including workflows executed by root runners or explicit scope owners.

  Add `runTaskJson` for materialized Hono JSON responses with request cancellation, typed error mapping and preserved RPC/OpenAPI response inference. Services must be provided before execution; task resources close before response mapping.

### Patch Changes

- Updated dependencies [ca8a242]
- Updated dependencies [cfb4f9c]
- Updated dependencies [210f3a3]
- Updated dependencies [6f4712a]
- Updated dependencies [210f3a3]
  - resultar@4.1.0

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

- 557eb58: Accept and forward native server/router options in `createFastifyApp` (`FastifyAppOptions`, such as `logger`, `loggerInstance`, and `requestIdHeader`) and `createHonoApp` (`HonoOptions`, such as `strict`, `router`, and `getPath`) while stripping Resultar service options before underlying framework initialization.
- f8458ae: Make `ResultTask` the preferred asynchronous workflow API and unify `ResultAsync` as the in-flight `Result` returned by `task.runResult()` in `resultar`.

  - Keep tasks lazy and repeatable, with explicit `runResult`, `runExit`, `runPromise`, and `runFork` boundaries. Tasks are not thenable; `map` remains synchronous.
  - Export `ResultAsync`, `StrictResultAsync`, and eager helpers from `resultar`. Preserve shared single execution, awaited callbacks, native Promise terminals and best-effort observation.
  - Preserve Async-producing compatibility methods on Result and tagged errors, plus explicit Task bridges.
  - `Result.gen` and `Result.fn` support synchronous and eager asynchronous generators with plain returns. The retained legacy `safeTry` preserves final-Result returns in both execution modes.
  - Keep `ResultTask.fromResultAsync` as a structural bridge accepting a Result-producing thenable or signal-aware factory.
  - HTTP request and lifecycle adapters preserve their eager public behavior using `resultar`.

- c6aed8b: Return `ResultAsync<A, E | ScopeError<R>>` from `ResultTask.runResult` and `task.runResult` as the official in-flight `Result` representation (`PromiseLike<Result<T, E>>`).

  - Un-deprecate `ResultAsync` and `StrictResultAsync` for consuming and transforming in-flight `Result` values before `await`, as well as in-flight value/Promise constructors (`ResultAsync.ok`, `ResultAsync.err`, `ResultAsync.unit`, `ResultAsync.fromPromise`, `ResultAsync.fromSafePromise`, `ResultAsync.try`, `okAsync`, `errAsync`, `unitAsync`, `fromPromise`, `fromSafePromise`, and `tryResultAsync`).
  - Unify `.try` across namespaces (`Result.try`, `ResultAsync.try`, `ResultTask.try`, `ResultTask.tryPromise`) supporting both positional `(fn, catchFn)` and object `{ try, catch }` signatures, while marking `*tryCatch*` (`Result.tryCatch`, `ResultAsync.tryCatch`, `tryCatch`, `tryCatchAsync`, `tryAsync`) as `@deprecated`.
  - Make `task.toResultAsync()`, `ResultTask.toResultAsync(task)`, and `ResultAsync.fromTask(task)` deprecated aliases of `runResult()`.
  - Mark static workflow/orchestration methods on `ResultAsync` (`retry`, `retryOrElse`, `race`, `raceAll`, `raceFirst`, `raceWith`, `timeout`, `withResource`, `forEach`, `validateAll`, `loop`, `iterate`, `firstSuccessOf`, `all`, `combine`, `combineWithAllErrors`, `zip`) as `@deprecated` in favor of `ResultTask`.
  - Delegate `ResultAsync` resolution transformation and consumption methods (`andThen`, `orElse`, `catchTag`, `catchTags`, `catchReason`, `catchReasons`, `as`, `unwrapReason`, `match`, `matchTags`, `matchTagsPartial`, `unwrapOr`, `unwrapOrThrow`) to `Result` and eliminate redundant wrapper allocations in `map`, `mapErr`, `filterOrElse`, `if`, `orElseSucceed`, `log`, `inspect`, `inspectError`, and `inspectBoth`.
  - Transfer `resultar-check` `no-discard` tracking when awaiting a `ResultAsync` variable into a `Result` binding (`const res = await pending`) or passing it through `Promise.resolve(pending)` / `Promise.all([pending])`, flag bare `await pending;` statements, prevent recursion cycles on self-referential variables, and tighten `.then` / tuple index / destructuring handling.
  - Fix `ResultAsync.then` single-callback return type inference, allow `.bind(task)` on `ResultTask` instance runners (`runResult`, `runPromise`, `runExit`, `runFork`, `toResultAsync`), and make `Redacted<T>` an opaque object type instead of intersecting with `string`.
  - Return `ResultAsync<void, CloseError>` from `HonoApplication.close()` and `HonoServices.close()` in `resultar-hono`.

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
  - resultar-di@1.0.0

## 0.4.1

### Patch Changes

- 9034eac: Require resultar-di ^0.4.1 so existing consumer lockfiles cannot retain DI 0.4.0 behind the adapters when upgrading for optional Service factory requirements.

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
  - resultar-di@0.4.0
  - resultar@3.9.1

## 0.3.0

### Minor Changes

- 2fc19dd: Preserve selected bindings in the `createHonoApp` return type and export
  `InferRequestServices` for application instances and factory functions. Separate route
  files can derive their Hono environment from `typeof createApplication` without repeating
  service tokens. The existing `HonoApplication<CloseError>` contract remains supported;
  inference adds no runtime metadata or lifecycle changes.

  Align the guides with the runnable examples: `main.ts` exports `AppHono`, route files
  import that type, and the factory's bindings define the exposed services. Document the
  matching Fastify declaration and self-contained services/routes/main layout.

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

- 2fc19dd: Reexport the Resultar DI application helpers from both framework integrations: `createModule`, `Service`, `service`, `resource`, and their public types. Applications can declare and register services without importing or directly installing `resultar-di`. Framework-independent shared code can continue using `resultar-di` directly.

### Patch Changes

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

- Updated dependencies [2fc19dd]
- Updated dependencies [2fc19dd]
- Updated dependencies [2fc19dd]
  - resultar@3.9.0
  - resultar-di@0.3.0

## 0.2.0

### Minor Changes

- 1ffab20: Add a native Fastify plugin with typed application and request service selections, request locals,
  startup rollback, cancellation and resource cleanup through streamed responses. Add per-route
  Hono services middleware that preserves native bindings and RPC inference. Both integrations
  reuse Resultar DI scopes; application callbacks can explicitly restrict resolution to singletons
  with useSingletons. Existing createHonoApp behavior remains compatible.
  Compose Fastify lifecycle recovery with Resultar while preserving original failures and awaited rollback.

### Patch Changes

- Updated dependencies [8bf0d07]
- Updated dependencies [c823e56]
- Updated dependencies [1ffab20]
- Updated dependencies [c823e56]
  - resultar@3.8.0
  - resultar-di@0.2.0

## 0.1.0

### Minor Changes

- fcf0f14: Add typed Hono bindings, response-scoped service ownership and explicit application shutdown. Provide a runnable Deno example without runtime-specific adapters. Export adapter type helpers from DI's advanced entry point and generate declaration imports that resolve in Deno workspace consumers.

### Patch Changes

- Updated dependencies [fcf0f14]
- Updated dependencies [fcf0f14]
- Updated dependencies [fcf0f14]
- Updated dependencies [fcf0f14]
- Updated dependencies [fcf0f14]
- Updated dependencies [fcf0f14]
- Updated dependencies [fcf0f14]
- Updated dependencies [fcf0f14]
- Updated dependencies [28ec63c]
- Updated dependencies [fcf0f14]
  - resultar@3.7.0
  - resultar-di@0.1.0
