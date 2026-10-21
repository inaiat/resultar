# resultar-check

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
