# resultar

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
