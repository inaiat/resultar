# resultar-check

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
