# resultar-check-win32-arm64

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

## 3.3.0

No changes in this release.

## 3.2.0

No changes in this release.

## 3.1.0

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
