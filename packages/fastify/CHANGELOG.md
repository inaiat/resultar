# resultar-fastify

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
- a912c37: Attach request services to earlier-registered child routes, such as Swagger UI routes, whose request constructors predate the services decorator. Preserve request isolation and resource cleanup.

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

- 2fc19dd: Add `createFastifyApp(options, configure)` to create a native Fastify instance, register the existing Resultar services plugin and configure routes synchronously. It preserves binding validation and lazy provider initialization; Fastify still owns startup, requests and shutdown. Simplify the Fastify example to match Hono's application factory.

  Preserve selected service types on the returned `FastifyServicesApplication` so `InferRequestServices<typeof createApplication>` and `InferAppServices` derive declarations from the bindings or custom exposed views. The type metadata adds no runtime properties, and native route plugins and autoload remain compatible.

  Allow both inference helpers to accept factory functions directly, preserving inference from application instances and callable service plugins.

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

## 0.2.1

### Patch Changes

- e31669c: Keep request service scopes alive when Fastify signals a generic abort after a complete HTTP request body. Real client disconnects and response transport errors still cancel the scope, and explicit native timeout reasons remain forwarded. Add real-network JSON and streaming-response regression tests.

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

- c823e56: Use ResultAsync for internal service readiness, completion and shutdown. Adapt lifecycle signals
  with fromCallback, preserve eager shared execution and complete failure causes, and convert results
  to rejected promises only at native Fastify hook boundaries.

  Simplify the Fastify example: createApplication() synchronously returns the native server with
  default services. Keep application creation and guarded startup in main.ts so tests can import
  the factory without opening a port; test repository overrides through native plugin registration.

- Updated dependencies [8bf0d07]
- Updated dependencies [c823e56]
- Updated dependencies [1ffab20]
- Updated dependencies [c823e56]
  - resultar@3.8.0
  - resultar-di@0.2.0
