# resultar-check

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
