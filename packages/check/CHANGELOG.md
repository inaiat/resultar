# resultar-check

## 6.0.0-beta.2

### Patch Changes

- 7ac4799: Preserve late acquisition cleanup through service and tracing wrappers. Handle synchronous aborts while reading HTTP responses and cancel stalled native Fetch streams through their readers.
  
  Harden core `ResultTask`, JIT, companion adapters, `resultar-check`, VS Code extension, and docs playground:
  
  - **Core (`resultar`)**: preserve all finalizer defects across multi-finalizer `TaskScope` drains in `race`/`timeout`; run synchronous `ResultTask.gen` `try/finally` blocks synchronously in `runSync()`/`runSyncExit()`, mark generator cleanup failures, and preserve external `Interrupt`; fix `RESULTAR_JIT=1` vs `RESULTAR_JIT=0` last-step `resumeSync` and `tryPromise` interruption parity; trap throwing `_tag` getters across all `catchTag`/`catchTags` tiers and guard `Cause.pretty` against throwing `Error.stack` getters, `BigInt`/circular span attributes, and shared non-circular references; fix `acquireDisposable` fallback when `[Symbol.asyncDispose]` is `undefined`; collapse pure external `race`/`raceAll` interruptions to `AbortError`; keep synchronous `tapCause` callbacks sync; isolate `ResultTask.memoize` cancellation, timeouts, and span traces per caller; compact `Semaphore` waiters and release aborted waiter references; unregister completed unjoined `Success` `forkChild` fibers; propagate `makeScope().close()` runtime context to finalizers and guard sync-abort-then-suspend in `scope.use()`; bail out before JIT codegen when `canUseJit()` is false; protect `Result.all`/`Result.validateAll`/`Tracer.memory()`/`createTaggedError` from `__proto__`, prototype interpolation, and `then`/`toJSON`/`findCause` overwrites; handle rejections in `ResultAsync.race*` and preserve `this` in `ResultAsync.fromThrowable`.
  - **Companion packages (`resultar-di`, `resultar-hono`, `resultar-fastify`, `resultar-nestjs`, `resultar-request`, `resultar-request-zod`, `resultar-request-typebox`, `resultar-config`)**: detect `transient` circular dependencies in `resultar-di`, enforce `useSingletons()` lifetime checks on overridden services, fix sync thenable detection, and allow `ServiceAccess.get()` during shutdown drain; cancel orphaned Hono wrapped responses when outer middleware throws or replaces `c.res`; fix NestJS Tier 2 pre-interceptor disconnect leaks, `handlerTimeout` `request.signal` propagation on FastifyAdapter, `initTimeout` cancellation/rollback, `@Inject(APP_SERVICES)` prototype preservation, and `createNestApp().close()` hook ordering; skip `locals()` on already-aborted requests in NestJS and Fastify Tier 2; defer `requestJson` `mapError` lazily, cancel stalled response bodies on abort/timeout, and serialize Fetch `Headers` in `HttpResponseErrorCauseError`; remove dangling `.d.ts.map` comments from companion type declarations.
  - **Checker & Editor (`resultar-check`, VS Code extension)**: fix Unicode byte-offset panic in `parseSuppressions` and support `-- reason` justifications; prevent destructive autofixes in `prefer-as-void`, `prefer-map`, `prefer-map-err`, `prefer-or-else-succeed`, `unnecessary-pipe`, `no-await-result-task`, and generator rules; analyze named `ResultTask.fn("span", ...)` overloads and RFC 0010 consumers/runners; preserve `!`/`as` receivers in `migrate-v5`; fix LSP `(0,0)` range matching, Windows case-insensitive paths, debounce handling, and `ResultTask.fn` refactor guards; fix absolute `tsconfig` `extends` and string-safe JSONC trailing-comma stripping; support hoisted monorepo binaries in `doctor`, split VS Code problem matchers, and harden VS Code LSP `EPIPE`/crash/multi-root handling.

## 6.0.0-beta.1

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

## 6.0.0-beta.0

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

## 5.0.1

### Patch Changes

- ca8a242: Add lazy `ResultTask.fromCallback` subscriptions with per-execution cancellation, synchronous cleanup and preserved failure causes. Keep the legacy eager adapter unchanged.

  Accept resource factories that propagate `ResultTaskScope` across functions and files, including workflows executed by root runners or explicit scope owners.

  Add `runTaskJson` for materialized Hono JSON responses with request cancellation, typed error mapping and preserved RPC/OpenAPI response inference. Services must be provided before execution; task resources close before response mapping.

- 210f3a3: Do not flag catchCause as useless solely because the task's typed failure channel is never. Defects remain recoverable; typed-only recovery diagnostics are unchanged.
- 6f4712a: Recognize Task Promise defect factories in await and disposable diagnostics.

  Verify direct, aliased, namespace and reexported imports against built declarations,
  including recovery, disposal, scope propagation and invalid-contract controls.

- cfb4f9c: Keep static lifetime analysis scoped to immutable module compositions, including named and token/class registrations, merges and value overrides. Report direct dependency paths and both registration locations without mixing independent modules with identical service names.

## 5.0.0

### Major Changes

- Enable `noPromiseResultar` at error severity by default. Native `Promise<Result>`,
  `Promise<StrictResult>`, and `Promise<ResultTask>` contracts now fail validation even
  with `failOn: "error"`, without an explicit per-rule configuration. Return `ResultAsync`,
  `StrictResultAsync`, or `ResultTask` directly instead of wrapping them in `async`.

  Explicit severity overrides remain available for gradual adoption. The `failOn`
  default and existing runtime APIs are unchanged.

### Minor Changes

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

## 4.0.0

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

- 7b4a41e: Expand `resultar-check` analyzer coverage, add `tsgo`-inspired rules and LSP refactors, and upgrade the native analyzer to Go 1.27 with the latest `github.com/microsoft/TypeScript/tsc` compiler package:

  - Upgrade `packages/check/native` to Go 1.27 (`go1.27`) and migrate from `github.com/microsoft/typescript-go` to `github.com/microsoft/TypeScript/tsc` (`v0.0.0-20261015232437-0e081d6fb33d`).
  - Complete Stage 1 branch feature coverage across `no-discard`, `no-unsafe-await`, `typed-catch-mapper`, `no-run-inside-gen`, `prefer-first-success-of`, `prefer-result-for-each`, `prefer-map`, `prefer-and-then`, `prefer-map-err`, `prefer-catch-reason`, `no-useless-recovery`, and `no-result-in-task-gen` (including `ResultAsync`, `MatchMatcher` finalizers, `Semaphore`, `Fiber`, `Result.fn`, `ResultTask.try` / `ResultTask.tryPromise`, `ResultAsync.fromTask`, `ResultTask.firstSuccessOf`, `ResultTask.forEach`, and static/curried `Result` / `ResultAsync` / `ResultTask` / `TaggedError` operators and constructors).
  - Add 11 new `tsgo`-inspired rules with autofixes: `prefer-or-else-succeed`, `prefer-tap`, `prefer-tap-error`, `prefer-as-void`, `prefer-filter-or-else`, `prefer-acquire-disposable`, `no-fn-iife`, `require-return-yield-star`, `no-unnecessary-err-wrap-in-gen`, `unnecessary-pipe`, and `no-run-inside-gen`.
  - Add 2 new LSP safe refactors: `Convert to ResultTask.fn` / `Convert to Result.fn` and `Convert to method .pipe()` / `Convert to pipe(...)`.
  - Support `"diagnosticSeverity": "<severity>"` shorthand and `"*"` wildcard inside `diagnosticSeverity` (globally and in `overrides`) to set the baseline severity for all 41 rules at once.

### Minor Changes

- 37e8a0f: Unify `ok` and `err` across core `Result`, `ResultTask`, and `ResultAsync`, generator workflows, and `.match` object handlers:

  - Change `Result.gen` to return plain success values (wrapping in `Ok` automatically) and require `yield*` for fallible steps, matching `ResultTask.gen`. Result supports sync and eager async bodies; separate legacy `safeTry` preserves final-Result returns in both modes.
  - Add `ResultTask.ok` and `ResultTask.err` as the task constructors and `ResultAsync.ok` and `ResultAsync.err` static constructors alongside `okAsync` and `errAsync`.
  - Support `{ ok, err }` object handlers throughout while retaining the existing matching forms.
  - Allow `ResultTask` combinators (`andThen`, `orElse`, `catchTag`, `catchTags`, `catchReason`, and `catchReasons`) to accept synchronous `Result` values (`ok(...)`, `err(...)`) directly alongside `ResultTask`.
  - Add `Result.fn`, constrain `ResultTask.gen` and `ResultTask.fn` via `ResultTaskYieldable` to reject invalid yields, and export their generator annotations. All parameterized helpers preserve post-body pipelines receiving `(current, ...args)`.
  - Add `filterOrElse`, `matchTags`, `matchTagsPartial`, `inspectCause`, `inspectBoth`, `tapCause`, `tapBoth`, `orElseSucceed`, `unwrapOr`, `catchCause`, `sandbox`, `unsandbox`, `catchReason`, `catchReasons`, `unwrapReason`, `ensuring`, `onExit`, `delay`, `timed`, `asVoid`, `zip` (with `{ concurrent?: boolean }`), `makeSemaphore`, `firstSuccessOf`, `if`, `when`, `unless`, `loop`, and `iterate` (instance, direct, and curried `pipe` forms) to `ResultTask`, export `Semaphore` (`Semaphore.make`, `withPermit`, `withPermits`, `available`) and `Cause.isCause` / `Cause.failures` / `Cause.defects`, unify `when` and `unless` across `Result`, `ResultAsync`, and `ResultTask` (supporting instance `.when` / `.unless`, curried `pipe` forms, fallible conditions, and direct or lazy bodies while preserving `whenResult` / `unlessResult`), add `orElseSucceed` and `asVoid` (instance, direct, and curried `pipe` forms) to `Result` and `ResultAsync`, add static direct/curried `unwrapOr`, `catchTag`, `catchTags`, `catchReason`, `catchReasons`, `unwrapReason`, `matchTags`, `matchTagsPartial`, and `inspectBoth` to `Result` and `ResultAsync`, and optimize `Match` tag/discriminator tables to dispatch via a single precompiled `Map` lookup.
  - Add `.taskErr(...)` alongside `.err(...)` and the retained `.errAsync(...)` on tagged-error classes. Eager errors can also use `errAsync(new TaggedError(props))` from `resultar`.
  - Add `Result.all` and `ResultAsync.all` as collection combinators matching `ResultTask.all` and `Promise.all` (alongside `Result.combine` and `ResultAsync.combine`).
  - Update `resultar-check` to recognize `Result.fn`, `ResultTask.fn(..., ResultTask.scoped)`, `Result.all`, `ResultAsync.all`, and the new instance and static `Result` / `ResultAsync` / `ResultTask` consumer, control-flow, and recovery methods.

### Patch Changes

- b15966d: Add runResult, runPromise, runExit, and runFork instance methods to ResultTask with the same
  execution, required services, cancellation, and scoped error contracts as the static runners.
  Keep both entry points supported, recognize the fluent boundaries in Resultar diagnostics, and
  adopt the instance methods in runnable examples and agent documentation.
- 40b76f2: - Expose `string | number | Redacted<unknown>` on unspecialized `TaggedError` instance template properties so passing `Redacted` values without `.withProps<...>()` preserves sound property types.
  - Recognize `+0`/`-0` unary numeric literals, literal-typed index expressions, passthrough `.then()` calls, named/curried/flow/identity wrapper callbacks, recursive callbacks, and nested `Promise.resolve(results)` tuple forwarding in `resultar-check` `no-discard` handling while guarding against mutated callback aliases, overridden class methods, non-Resultar shadowed symbols, non-`.then` zero-arg method calls (e.g. `.toString()`), and shadowed `undefined` identifiers.
  - Align JSDoc and guide documentation with current `resultar` exports, `ResultTask.forkChild` static usage, `ResultTask` constructors, and `ResultTask.forEach` options.
- bfe38b4: Preserve existing Async root exports and module paths while keeping the eager
  implementation organized under `src/resultar-async`. Restore asynchronous Result
  composition, generator support, tagged-error helpers and explicit Task bridges.

  Retain Task composition aliases, supported matching and retry forms, and internal
  execution contracts. Handle interruption after captured Result promises resolve.
  Prevent execution options from widening the task's declared service requirements.
  Keep checker recognition aligned with the supported API without treating a Task
  as awaitable unless its type actually exposes a `then` method.

- bfe38b4: Preserve eager shared execution, awaited mapping and validation callbacks, best-effort
  observation, and Promise-returning boundary matching in `resultar`, along with explicit Task bridges.

  Keep tasks lazy and non-thenable, with explicit runners and a structural incoming bridge.
  Preserve the concurrent runtime and create complete clock and scheduler contexts at
  the public execution boundaries.

  Preserve the legacy fluent partial-match fallback type. Avoid generator diagnostics when
  the inferred success channel does not contain a nested Result or async workflow.
  Recognize `ResultTask.fromResultAsync` as consuming its eager async input in the checker.

- 37e8a0f: Recognize createTaggedError(...).withProps<Props>() class bases in the
  tagged-error-name-match and no-tagged-error-constructor-override rules.
  Preserve the existing checks for factory options without treating unrelated
  withProps methods or unsupported transformations as Resultar tagged errors.
- c6aed8b: Return `ResultAsync<A, E | ScopeError<R>>` from `ResultTask.runResult` and `task.runResult` as the official in-flight `Result` representation (`PromiseLike<Result<T, E>>`).

  - Un-deprecate `ResultAsync` and `StrictResultAsync` for consuming and transforming in-flight `Result` values before `await`, as well as in-flight value/Promise constructors (`ResultAsync.ok`, `ResultAsync.err`, `ResultAsync.unit`, `ResultAsync.fromPromise`, `ResultAsync.fromSafePromise`, `ResultAsync.try`, `okAsync`, `errAsync`, `unitAsync`, `fromPromise`, `fromSafePromise`, and `tryResultAsync`).
  - Unify `.try` across namespaces (`Result.try`, `ResultAsync.try`, `ResultTask.try`, `ResultTask.tryPromise`) supporting both positional `(fn, catchFn)` and object `{ try, catch }` signatures, while marking `*tryCatch*` (`Result.tryCatch`, `ResultAsync.tryCatch`, `tryCatch`, `tryCatchAsync`, `tryAsync`) as `@deprecated`.
  - Make `task.toResultAsync()`, `ResultTask.toResultAsync(task)`, and `ResultAsync.fromTask(task)` deprecated aliases of `runResult()`.
  - Mark static workflow/orchestration methods on `ResultAsync` (`retry`, `retryOrElse`, `race`, `raceAll`, `raceFirst`, `raceWith`, `timeout`, `withResource`, `forEach`, `validateAll`, `loop`, `iterate`, `firstSuccessOf`, `all`, `combine`, `combineWithAllErrors`, `zip`) as `@deprecated` in favor of `ResultTask`.
  - Delegate `ResultAsync` resolution transformation and consumption methods (`andThen`, `orElse`, `catchTag`, `catchTags`, `catchReason`, `catchReasons`, `as`, `unwrapReason`, `match`, `matchTags`, `matchTagsPartial`, `unwrapOr`, `unwrapOrThrow`) to `Result` and eliminate redundant wrapper allocations in `map`, `mapErr`, `filterOrElse`, `if`, `orElseSucceed`, `log`, `inspect`, `inspectError`, and `inspectBoth`.
  - Transfer `resultar-check` `no-discard` tracking when awaiting a `ResultAsync` variable into a `Result` binding (`const res = await pending`) or passing it through `Promise.resolve(pending)` / `Promise.all([pending])`, flag bare `await pending;` statements, prevent recursion cycles on self-referential variables, and tighten `.then` / tuple index / destructuring handling.
  - Fix `ResultAsync.then` single-callback return type inference, allow `.bind(task)` on `ResultTask` instance runners (`runResult`, `runPromise`, `runExit`, `runFork`, `toResultAsync`), and make `Redacted<T>` an opaque object type instead of intersecting with `string`.
  - Return `ResultAsync<void, CloseError>` from `HonoApplication.close()` and `HonoServices.close()` in `resultar-hono`.

## 3.3.0

### Minor Changes

- 631fea2: Add root pipe, flow, identity, and constant helpers; share private direct/curried dispatch and pipeline execution. Add lazy ResultTask.fn, typed catchTag/catchTags recovery, and scoped acquireDisposable with awaited cleanup.

  Protect task requirements from unknown/any types and unsafe assertions, and report unused suppression entries (both new rules default to suggestion). Analyze unsaved editor buffers with versioned UTF-16 fixes, channel/service hover, and conservative recovery/generator refactors. Add read-only overview and quickfixes CLI previews.

  Preserve eager ResultAsync, repeatable lazy ResultTask, runners, and existing cause/cleanup policies. Fibers and task concurrency remain deferred.

  Expand the executable checker examples to all 30 rules, covering requirement erasure, obsolete suppressions, parameterized generators, and native disposable scopes alongside zero-diagnostic corrected patterns. Compile all three fixture projects with the installed TypeScript compiler before the native CLI checks in smoke tests and CI.

  Compose the checker configuration schema with the standard tsconfig schema, preserving editor completion and validation for TypeScript options alongside Resultar rules. Add JSON language-service tests to the checker validation suite.

## 3.2.0

### Minor Changes

- c823e56: Add prefer-result-async diagnostics for Promise<Result> and Promise<StrictResult> type contracts
  and inferred function returns. Support configurable severity, aliases and line suppressions;
  provide migration guidance without applying unsafe annotation-only edits. Add the opt-in
  preferResultAsyncMode: "all" policy to also catch raw Promise<T> contracts and inferred returns.
  Update the Fastify repository and service example to return StrictResultAsync directly, preserve
  repository errors, and enforce the all-mode policy with explicit native framework boundaries.

### Patch Changes

- 8bf0d07: Resolve Result.gen and ResultTask diagnostics through imported symbols, including renamed
  imports and reexports. Classify intentional-discard suggestions separately from composition
  corrections in JSONL and LSP output.

  Keep ResultTask continuation helpers private and bundle versioned coding-agent guidance with
  a compiled workflow example. Clarify eager/lazy execution, generator returns, tap failures,
  resource ownership, and runResult rejection semantics.

## 3.1.0

### Minor Changes

- 28ec63c: Add five ResultTask and DI diagnostics: no-invalid-lifetime rejects longer-lived services capturing shorter-lived dependencies, no-unscoped-acquire-release requires acquireRelease workflows in ResultTask.gen to run under ResultTask.scoped, no-result-in-task-gen requires plain success returns, no-await-in-result-task-gen keeps gen bodies lazy with yield*, and no-throw-in-task-sync directs sync throws to ResultTask.try with a catch mapper. Suppression directives also match case-insensitively so sentence-case formatters cannot break them.

### Patch Changes

- fcf0f14: Recognize ResultTask.runExit as a safe await boundary in no-unsafe-await. Keep diagnostics for
  runPromise and unrelated APIs named runExit. Discovered while adopting ResultTask scopes in a private consumer.

## 3.0.0

### Major Changes

- 7fc3a84: Add the TypeScript-Go native checker pilot with Go implementations of
  `no-discard`, `no-promise-in-result-success`, `no-unknown-result-error`,
  `prefer-map-err`, `prefer-and-then`, `typed-catch-mapper`, `prefer-map`, and
  `prefer-first-success-of`, plus the structural rules `prefer-result-for-each`,
  `prefer-catch-reason`, `no-throw`, `no-try-catch`, and
  `yield-star-in-safe-try`, together with the `safeTry` and tagged-error rules
  `no-await-in-safe-try`, `no-try-catch-in-safe-try`, `prefer-tagged-error`,
  `tagged-error-name-match`, and `no-tagged-error-constructor-override`, including
  the final semantic rules `no-useless-recovery`, `unsafe-result-type-assertion`,
  and `no-unsafe-await`, plus ResultTask-aware diagnostics including
  `yield-star-in-result-task-gen`, full tsconfig option parity, tests, development
  commands, and a comparative benchmark.

  Add the lazy `ResultTask<A, E, R>` core with explicit execution boundaries,
  typed services, generator composition, and `Result.gen` as an exact alias for
  `safeTry`.

  Make the native TypeScript-Go executable the public `resultar-check` CLI with
  platform-specific optional npm packages for macOS, Linux, and Windows.

  Remove the legacy JavaScript checker, editor plugin implementation,
  programmatic API, and syntax-only host adapters. The Go
  analyzer is now the single implementation of Resultar diagnostics, and the npm
  package exposes only the native CLI launcher and configuration schema. The
  package no longer has a TypeScript peer dependency or JSR release.

  Replace the former lint-adapter example with a native `examples/check` fixture
  that asserts exact counts for all 22 Resultar rules and verifies a separate
  clean project produces no diagnostics.

  Add shared diagnostic output formats (JSON Lines, SARIF, and JUnit), stable
  severity maps with file overrides and CI `failOn` policy, local line
  suppression comments, and a stdio LSP surface with inline diagnostics and
  quick fixes for safe Resultar composition renames.

## 2.2.2

### Patch Changes

- 93b11c1: Document every JSR entrypoint and exported symbol so the registry can generate complete API documentation.

## 2.2.1

### Patch Changes

- 8ab30ff: Clarify the recommended validation workflow, request examples, runtime requirements, and published
  documentation links across the checker and request packages.

## 2.2.0

### Minor Changes

- Add the opt-in `resultar/no-try-catch` rule for the CLI, TypeScript language-service plugin,
  Oxlint, ESLint, and Deno Lint. The rule directs expected failures to `tryResult` or
  `tryResultAsync` while continuing to allow `try/finally` cleanup.

## 2.1.1

### Patch Changes

- Rewrite the package guide around Oxlint-first adoption, full type-aware enforcement, and deterministic guardrails for AI-assisted development.

## 2.1.0

### Minor Changes

- dfbfcb3: Pin the workspace and Resultar diagnostics workflow to the published TypeScript 7 compiler package.
  Fold the AST-only Oxlint, ESLint, and Deno Lint adapters into `resultar-check`.

## 2.0.0

### Major Changes

- ef3e628: Add stricter Resultar diagnostics for `safeTry` and thrown errors.

  `resultar/no-await-in-safe-try` now defaults to an error so `safeTry` bodies compose Resultar values with `yield*` instead of raw `await`. The new opt-in `resultar/no-throw` rule lets projects enforce expected failures through `Err`/`errAsync` rather than thrown exceptions.

## 1.1.2

### Patch Changes

- 1f2fa5d: Report `throw new Error(...)` through `resultar/prefer-tagged-error` so raw thrown failures are caught alongside plain Error subclasses and `err(new Error(...))`.
- dcb03fe: Report `await` on Resultar async values inside raw `Promise<T>` functions when `noUnsafeAwaitMode` is `all`, so application boundaries preserve `ResultAsync` or `Promise<Result>` error channels instead of unwrapping and throwing.
- 1f2fa5d: Add `ignoreFilePatterns` so projects can suppress Resultar diagnostics for files such as `*.test.ts` while keeping TypeScript checks intact.

## 1.1.1

### Patch Changes

- Allow `noUnsafeAwaitIgnoreCalls` entries to be bare function identifiers such as `startServer`,
  in addition to dotted call paths such as `fastify.after`.

## 1.1.0

### Minor Changes

- 1e558ec: Add `runSync` and `runPromise` helpers for explicit final Resultar boundaries.

  Add `noUnsafeAwaitIgnoreCalls` to `resultar-check` so projects can configure exact call paths, such as `fastify.after`, that should be ignored by `resultar/no-unsafe-await`.

## 1.0.0

### Minor Changes

- Standardize the public Resultar check path around `resultar-check`, add the opt-in unsafe await diagnostic, and include the runtime performance and mutation-testing updates.

## 3.1.0

### Minor Changes

- 71acacb: Release the Resultar 3.1 lint package with stable npm and JSR metadata.

## 3.1.0-beta.1

### Minor Changes

- Prepare the Resultar 3.1 beta release candidate.

## 3.0.0

### Major Changes

- a65670f: Release v3: split the project into publishable workspace packages, add Resultar no-discard language-service tooling and the tsgo wrapper, remove TypeDoc docs generation, and expand the README/DOCUMENTATION guides.
- 45f75f2: Rename the public no-discard command surface to the generic `resultar-lint` CLI.
  `resultar-lint check` now runs the compiler-backed diagnostics, `resultar-lint doctor`
  checks TypeScript patch status, and the legacy `resultar-no-discard` binary plus
  `resultar-lint/no-discard` package subpath are no longer public entrypoints.

### Patch Changes

- c2023ff: Fix must-use no-discard false positives for function and object types whose rendered type mentions
  Result, and treat returned object or array literal references as handled.

## 3.0.0-alpha.3

### Major Changes

- 45f75f2: Rename the public no-discard command surface to the generic `resultar-lint` CLI.
  `resultar-lint check` now runs the compiler-backed diagnostics, `resultar-lint doctor`
  checks TypeScript patch status, and the legacy `resultar-no-discard` binary plus
  `resultar-lint/no-discard` package subpath are no longer public entrypoints.

## 3.0.0-alpha.2

### Major Changes

- a65670f: Release v3: split the project into publishable workspace packages, add Resultar no-discard language-service tooling and the tsgo wrapper, remove TypeDoc docs generation, and expand the README/DOCUMENTATION guides.
