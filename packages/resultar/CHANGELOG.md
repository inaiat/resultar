# resultar

## 4.0.1

### Patch Changes

- 7684e1e: Add official `resultar-nestjs` integration package with `createNestModule`, `createNestApp`, `@Services()` parameter decorator, `APP_SERVICES` token, `InferRequestServices`, `InferAppServices`, per-request DI resource scopes, cancellation propagation, and startup tasks (defaulting to `@nestjs/platform-fastify`). Update the bundled Resultar agent guide and documentation with `resultar-nestjs`.

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
- f8458ae: Make `ResultTask` the preferred asynchronous workflow API and unify `ResultAsync` as the in-flight `Result` returned by `task.runResult()` in `resultar`.
  
  - Keep tasks lazy and repeatable, with explicit `runResult`, `runExit`, `runPromise`, and `runFork` boundaries. Tasks are not thenable; `map` remains synchronous.
  - Export `ResultAsync`, `StrictResultAsync`, and eager helpers from `resultar`. Preserve shared single execution, awaited callbacks, native Promise terminals and best-effort observation.
  - Preserve Async-producing compatibility methods on Result and tagged errors, plus explicit Task bridges.
  - `Result.gen` and `Result.fn` support synchronous and eager asynchronous generators with plain returns. The retained legacy `safeTry` preserves final-Result returns in both execution modes.
  - Keep `ResultTask.fromResultAsync` as a structural bridge accepting a Result-producing thenable or signal-aware factory.
  - HTTP request and lifecycle adapters preserve their eager public behavior using `resultar`.

### Minor Changes

- b15966d: Add runResult, runPromise, runExit, and runFork instance methods to ResultTask with the same
  execution, required services, cancellation, and scoped error contracts as the static runners.
  Keep both entry points supported, recognize the fluent boundaries in Resultar diagnostics, and
  adopt the instance methods in runnable examples and agent documentation.
- 37e8a0f: Add direct and curried functional Result composition operators for pipe-based workflows while preserving existing fluent, generator, exception and observation behavior.
- 37e8a0f: Add direct and curried functional operators to ResultAsync: `map`, `mapErr`, `andThen`, `orElse`, `inspect`, `inspectError`, `match`, `as`, and `filterOrElse`. The operators preserve the existing eager execution, precise error unions, refinement narrowing, callback rejection, and best-effort observation contracts of their fluent counterparts.
- 37e8a0f: Add Result.fromNullishOr and Result.liftPredicate with direct and curried forms,
  preserving non-nullable success types, refinements, and concrete error types.
  Add Cause.hasFails, hasDies, hasInterrupts, findError, and pretty for inspecting
  and formatting the existing sequential failure tree without changing task runners.
- 37e8a0f: Add a typed Match API for values, reusable functions and HTTP boundaries.
  Support fluent and pipe composition, tags and discriminators, positive/negative patterns, safe
  refinements, selector arguments, exhaustive/fallback completion, native Resultar Result outputs,
  optional matches and declared return types. Preserve Hono RPC status/payload inference and native
  Fastify reply schemas with runnable examples and runtime/type regression tests.
- 37e8a0f: Add lazy Fiber.await to observe a child's complete Exit after cleanup without
  interrupting it, while preserving existing structural Fiber handles.
  
  Add opt-in interruption: "detach" to object-form ResultTask.tryPromise so abort
  can stop waiting for foreign promises. The default still waits for settlement.
  Detached waits observe late rejection, stop continuations, and retain normal
  owned finalization; underlying work can continue if it ignores the signal.
- 37e8a0f: Add `Retry.policy` for immutable, reusable retry options shared by ResultAsync and ResultTask. Canonical policies use the same zero-based context, exponential backoff, numeric symmetric jitter, asynchronous predicates, and best-effort retry observers in both models. Task closes each attempt scope before retrying. Existing Task and eager Async options retain their callback signatures and jitter behavior.
  
  ResultTask can interrupt its wait for canonical asynchronous retry hooks after closing the attempt scope. Late hook completion or rejection is consumed without scheduling another attempt; the foreign Promise's underlying work can continue.
- 37e8a0f: Add ResultTask.runFork for immediate root execution with a native fiber handle. Root fibers preserve typed requirements and release errors, own cancellation, and publish their complete Exit only after child and resource cleanup.
  
  Prevent run options from widening a task's declared service requirements to accept incompatible service values.
- 37e8a0f: Yield the ResultTask interpreter cooperatively after an operation budget, allowing timers and other event-loop work to proceed during long task chains and generators. Add an injectable TaskScheduler and yieldEvery run option; child fibers have independent budgets, and callers can use Infinity to disable automatic yields.
  
  A failed dispatcher records a defect and switches its fiber to Scheduler.live so owned cleanup still runs, including after a dispatcher failure during cleanup. Release failures remain preserved as sequential causes.
- 37e8a0f: Add `createTaggedError(...).withProps<Props>()` for precise template fields and structured error metadata while preserving existing inference defaults. Each specialization creates a distinct constructor so nominal guards cannot confuse incompatible metadata views.
  
  Specialized constructors preserve readonly string metadata from getters, inherited properties, and non-enumerable fields. The original factory keeps its existing own-enumerable copy behavior. Error fields and helpers are protected; cause remains in the existing constructor channel, preserving any cause type declared by a custom base.
- 37e8a0f: Expose native fiber IDs, synchronous polling after cleanup, and removable best-effort
  exit observers. These diagnostics preserve owned child failure reporting.
  
  Add opt-in `interruption: "detach"` to native and namespace fiber joins. Default
  joins retain their existing waiting behavior; detached cancellation stops only the
  waiter and leaves undelivered child failures owned by their parent scope.

### Patch Changes

- 37e8a0f: Separate the public Fiber API and internal child-fiber runtime into dedicated modules. Preserve existing exports, structural handles, execution timing, cancellation, observation and scope cleanup without adding runtime dependencies.
- 37e8a0f: Correct ResultAsync race documentation: race and raceAll return the first Ok,
  or the last completed Err when every task fails; raceFirst returns the first
  completed Result. Clarify that ResultAsync aborts pending losers without waiting
  for cleanup, while ResultTask races and timeouts await owned child cleanup.
  Runtime behavior and public signatures are unchanged.
- bfe38b4: Reduce allocations in ResultTask collections by creating child scopes and runtime contexts
  only when an item needs them. Immediately successful tasks retain their scheduling budget,
  parallel execution boundaries, cancellation checks, and per-item cleanup behavior.
  Allocate failure and validation-error storage only after a failure occurs.
- bfe38b4: Concentrate eager Async factories, generator completion, composition, adapters and
  Async-only types in `src/resultar-async`. Keep the existing root and module paths
  as compatibility exports with shared identities. Existing Result and Task Async
  methods delegate to the legacy implementation without changing execution,
  callback, matching or generator contracts.
  
  Mark exported eager factories such as `okAsync`, `errAsync` and `tryResultAsync`
  deprecated, directing new workflows to the corresponding ResultTask APIs.
- 40b76f2: - Expose `string | number | Redacted<unknown>` on unspecialized `TaggedError` instance template properties so passing `Redacted` values without `.withProps<...>()` preserves sound property types.
  - Recognize `+0`/`-0` unary numeric literals, literal-typed index expressions, passthrough `.then()` calls, named/curried/flow/identity wrapper callbacks, recursive callbacks, and nested `Promise.resolve(results)` tuple forwarding in `resultar-check` `no-discard` handling while guarding against mutated callback aliases, overridden class methods, non-Resultar shadowed symbols, non-`.then` zero-arg method calls (e.g. `.toString()`), and shadowed `undefined` identifiers.
  - Align JSDoc and guide documentation with current `resultar` exports, `ResultTask.forkChild` static usage, `ResultTask` constructors, and `ResultTask.forEach` options.
- 37e8a0f: Preserve required, optional and rest context arguments in piped Match combinators when handlers omit parameters. Keep undefined and never table entries out of the inferred return union without treating absent handlers as exhaustive coverage.
- bfe38b4: Keep one deprecated `safeTry` implementation and its legacy types in the Async
  compatibility layer. Preserve the root and old module exports as re-exports, with
  the same synchronous and asynchronous final-Result behavior. Task generators use
  `ResultTask.gen` independently of the legacy helper.
- bfe38b4: Reduce ResultTask retry overhead by avoiding Promise allocation for synchronous cleanup,
  completed retry loops, and synchronous policy hooks when the run cannot be interrupted.
  Reuse untouched attempt scopes without retaining acquired resources across attempts.
  Preserve per-attempt resource cleanup, cancelable hooks, asynchronous hook adoption,
  retry delays, and legacy callback contracts.
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
- bfe38b4: Avoid scheduling a live-clock timer for ResultTask retries whose computed delay is zero.
  Skip asynchronous retry-hook handling when no predicate or observer is configured.
  Preserve attempt cleanup, retry hooks, cooperative scheduling, cancellation, positive delays,
  and custom or virtual clock sleep behavior.
- c6aed8b: Return `ResultAsync<A, E | ScopeError<R>>` from `ResultTask.runResult` and `task.runResult` as the official in-flight `Result` representation (`PromiseLike<Result<T, E>>`).
  
  - Un-deprecate `ResultAsync` and `StrictResultAsync` for consuming and transforming in-flight `Result` values before `await`, as well as in-flight value/Promise constructors (`ResultAsync.ok`, `ResultAsync.err`, `ResultAsync.unit`, `ResultAsync.fromPromise`, `ResultAsync.fromSafePromise`, `ResultAsync.try`, `okAsync`, `errAsync`, `unitAsync`, `fromPromise`, `fromSafePromise`, and `tryResultAsync`).
  - Unify `.try` across namespaces (`Result.try`, `ResultAsync.try`, `ResultTask.try`, `ResultTask.tryPromise`) supporting both positional `(fn, catchFn)` and object `{ try, catch }` signatures, while marking `*tryCatch*` (`Result.tryCatch`, `ResultAsync.tryCatch`, `tryCatch`, `tryCatchAsync`, `tryAsync`) as `@deprecated`.
  - Make `task.toResultAsync()`, `ResultTask.toResultAsync(task)`, and `ResultAsync.fromTask(task)` deprecated aliases of `runResult()`.
  - Mark static workflow/orchestration methods on `ResultAsync` (`retry`, `retryOrElse`, `race`, `raceAll`, `raceFirst`, `raceWith`, `timeout`, `withResource`, `forEach`, `validateAll`, `loop`, `iterate`, `firstSuccessOf`, `all`, `combine`, `combineWithAllErrors`, `zip`) as `@deprecated` in favor of `ResultTask`.
  - Delegate `ResultAsync` resolution transformation and consumption methods (`andThen`, `orElse`, `catchTag`, `catchTags`, `catchReason`, `catchReasons`, `as`, `unwrapReason`, `match`, `matchTags`, `matchTagsPartial`, `unwrapOr`, `unwrapOrThrow`) to `Result` and eliminate redundant wrapper allocations in `map`, `mapErr`, `filterOrElse`, `if`, `orElseSucceed`, `log`, `inspect`, `inspectError`, and `inspectBoth`.
  - Transfer `resultar-check` `no-discard` tracking when awaiting a `ResultAsync` variable into a `Result` binding (`const res = await pending`) or passing it through `Promise.resolve(pending)` / `Promise.all([pending])`, flag bare `await pending;` statements, prevent recursion cycles on self-referential variables, and tighten `.then` / tuple index / destructuring handling.
  - Fix `ResultAsync.then` single-callback return type inference, allow `.bind(task)` on `ResultTask` instance runners (`runResult`, `runPromise`, `runExit`, `runFork`, `toResultAsync`), and make `Redacted<T>` an opaque object type instead of intersecting with `string`.
  - Return `ResultAsync<void, CloseError>` from `HonoApplication.close()` and `HonoServices.close()` in `resultar-hono`.

## 3.10.0

### Minor Changes

- 631fea2: Add root pipe, flow, identity, and constant helpers; share private direct/curried dispatch and pipeline execution. Add lazy ResultTask.fn, typed catchTag/catchTags recovery, and scoped acquireDisposable with awaited cleanup.
  
  Protect task requirements from unknown/any types and unsafe assertions, and report unused suppression entries (both new rules default to suggestion). Analyze unsaved editor buffers with versioned UTF-16 fixes, channel/service hover, and conservative recovery/generator refactors. Add read-only overview and quickfixes CLI previews.
  
  Preserve eager ResultAsync, repeatable lazy ResultTask, runners, and existing cause/cleanup policies. Fibers and task concurrency remain deferred.
  
  Expand the executable checker examples to all 30 rules, covering requirement erasure, obsolete suppressions, parameterized generators, and native disposable scopes alongside zero-diagnostic corrected patterns. Compile all three fixture projects with the installed TypeScript compiler before the native CLI checks in smoke tests and CI.
  
  Compose the checker configuration schema with the standard tsconfig schema, preserving editor completion and validation for TypeScript options alongside Resultar rules. Add JSON language-service tests to the checker validation suite.

## 3.9.1

### Patch Changes

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

## 3.9.0

### Minor Changes

- 2fc19dd: Infer literal service identifiers with `ResultTask.service<Contract>()("name")` while retaining the direct overload.
  
  Add `Service.require<Contract>()("name")` and optional `Service` dependency maps through `requires`. Construction factories receive inferred readonly dependencies and return a lazy ResultTask. Existing generator-only definitions, token identity, typed requirements and scope lifetimes remain supported.
  
  Require Resultar 3.9 or newer in the DI package's JSR import map so the curried service primitive is available.
  
  Make the Fastify and Hono examples self-contained, with class services using explicit `requires` maps, a repository, cache and function-based health service. Import the primary DI API through each framework integration and keep matching file layouts for services, routes and server startup. Omit optional bindings in both examples to expose all registered services.

## 3.8.0

### Minor Changes

- c823e56: Support framework facades that retain synchronous, lazy service access while sharing Resultar DI's
  resolution cache, lifetime checks and resource ownership. Add advanced provider registration,
  module metadata and scoped service access, backed by synchronous finalizer registration on a
  ResultTask scope owner. Existing native module factory timing remains unchanged.

  Allow Fastify facades to choose onRequest registration, expose application/request service views
  and map terminal lifecycle errors. Native selected-service defaults remain in preHandler. Facades
  can opt to report rollback failures only at startup without repeating them on subsequent close.

### Patch Changes

- 8bf0d07: Resolve Result.gen and ResultTask diagnostics through imported symbols, including renamed
  imports and reexports. Classify intentional-discard suggestions separately from composition
  corrections in JSONL and LSP output.

  Keep ResultTask continuation helpers private and bundle versioned coding-agent guidance with
  a compiled workflow example. Clarify eager/lazy execution, generator returns, tap failures,
  resource ownership, and runResult rejection semantics.
- c823e56: Add prefer-result-async diagnostics for Promise<Result> and Promise<StrictResult> type contracts
  and inferred function returns. Support configurable severity, aliases and line suppressions;
  provide migration guidance without applying unsafe annotation-only edits. Add the opt-in
  preferResultAsyncMode: "all" policy to also catch raw Promise<T> contracts and inferred returns.
  Update the Fastify repository and service example to return StrictResultAsync directly, preserve
  repository errors, and enforce the all-mode policy with explicit native framework boundaries.

## 3.7.0

### Minor Changes

- fcf0f14: Use typed lazy provider maps in provideServiceResolver, preserving provider errors and external
  requirements. Add explicit resource scope ownership and task memoization for DI adapters.
  Ensure throwing service providers still execute generator cleanup.
- fcf0f14: Add ResultTask resource scopes with acquireRelease and scoped, LIFO asynchronous finalizers,
  deferred release error inference, and cooperative interruption. runExit preserves sequential
  execution and cleanup causes; runResult rejects composite causes with ResultTaskCauseError.
  Keep ResultAsync.withResource behavior unchanged and document the application lifecycle pattern.
  Add a lazy ResultTask service resolver for dependency-injection adapters.
- fcf0f14: Add a lazy callback overload to ResultTask.tryPromise with unknown failures and the runtime AbortSignal. Keep the explicit error-mapping overload and simplify the Deno bootstrap to use the new API directly.

## 3.6.0

### Minor Changes

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

## 3.5.2

### Patch Changes

- 93b11c1: Document the JSR entrypoints and exported symbols used by Resultar and its request packages.
- b913a80: - **resultar**: Corrected `ResultAsyncRetryContext.attempt` JSDoc starting value to 0, streamlined concurrent traversal scheduling to avoid duplicate finish invocations, and added timer cleanup validation on retry aborts.
  - **resultar-request**: Guarded response `text()` and `json()` against synchronous throws and promise rejections outside `ResultAsync`, implemented safe serialization for circular references and BigInt values in `RequestError.exception`, mapped `BodyTimeoutError` and `TimeoutError` to status 408, and updated internal dependencies to caret workspace ranges.
  - **resultar-request-typebox**: Preserved `code` and `path` in TypeBox validation error items, widened `typebox` peer dependency to `^1.3.4`, and updated internal dependencies to caret workspace ranges.
  - **resultar-request-zod**: Widened `zod` peer dependency to `^4.4.3` and updated internal dependencies to caret workspace ranges.

## 3.5.1

### Patch Changes

- 8ab30ff: Rewrite the package README as a product-first guide with a cohesive account workflow, clearer
  feature highlights, and focused links to the full Resultar documentation.

## 3.5.0

### Minor Changes

- Add `ResultAsync.fromCallback` for adapting callback and subscription APIs with typed failure
  mapping, cooperative cancellation, and deterministic unsubscribe cleanup.

### Patch Changes

- dfbfcb3: Pin the workspace and Resultar diagnostics workflow to the published TypeScript 7 compiler package.
  Fold the AST-only Oxlint, ESLint, and Deno Lint adapters into `resultar-check`.

## 3.4.0

### Minor Changes

- 1e558ec: Add `runSync` and `runPromise` helpers for explicit final Resultar boundaries.

  Add `noUnsafeAwaitIgnoreCalls` to `resultar-check` so projects can configure exact call paths, such as `fastify.after`, that should be ignored by `resultar/no-unsafe-await`.

## 3.3.1

### Patch Changes

- Refresh the README docs for the runtime package.

## 3.3.0

### Minor Changes

- Standardize the public Resultar check path around `resultar-check`, add the opt-in unsafe await diagnostic, and include the runtime performance and mutation-testing updates.

## 3.2.1

### Patch Changes

- Refresh the release after updating the publish install toolchain.

## 3.2.0

### Minor Changes

- Add opt-in numeric `jittered` retry support to `ResultAsync.retry` and `ResultAsync.retryOrElse`.

## 3.1.0

### Minor Changes

- 71acacb: Release Resultar 3.1 with ResultAsync concurrency, retry, race, timeout,
  and resource helpers, plus abort and redaction utilities for richer tagged errors.

## 3.1.0-beta.1

### Minor Changes

- Add ResultAsync concurrency, retry, race, timeout, and resource helpers, plus abort and redaction utilities for richer tagged errors.
- Prepare the Resultar 3.1 beta release candidate.

## 3.0.0

### Major Changes

- a65670f: Release v3: split the project into publishable workspace packages, add Resultar no-discard language-service tooling and the tsgo wrapper, remove TypeDoc docs generation, and expand the README/DOCUMENTATION guides.

### Patch Changes

- 45f75f2: Rename the public no-discard command surface to the generic `resultar-lint` CLI.
  `resultar-lint check` now runs the compiler-backed diagnostics, `resultar-lint doctor`
  checks TypeScript patch status, and the legacy `resultar-no-discard` binary plus
  `resultar-lint/no-discard` package subpath are no longer public entrypoints.

## 3.0.0-alpha.3

### Patch Changes

- 45f75f2: Rename the public no-discard command surface to the generic `resultar-lint` CLI.
  `resultar-lint check` now runs the compiler-backed diagnostics, `resultar-lint doctor`
  checks TypeScript patch status, and the legacy `resultar-no-discard` binary plus
  `resultar-lint/no-discard` package subpath are no longer public entrypoints.

## 3.0.0-alpha.2

### Major Changes

- a65670f: Release v3: split the project into publishable workspace packages, add Resultar no-discard language-service tooling and the tsgo wrapper, remove TypeDoc docs generation, and expand the README/DOCUMENTATION guides.
