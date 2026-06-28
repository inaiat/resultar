# resultar

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
