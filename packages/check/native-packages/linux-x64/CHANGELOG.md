# resultar-check-linux-x64

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
