# Resultar Check native backend

This directory contains the Go implementation of all current Resultar rules on
the TypeScript 7 native compiler. It pins the same `typescript-go` revision as
TypeScript `7.0.2` and opens each project only once for TypeScript diagnostics
and Resultar analysis.

The native backend ports these stable rule IDs and their existing tsconfig options:

- `resultar/no-discard` (`noDiscard`, `noDiscardMode`)
- `resultar/no-promise-in-result-success` (`noPromiseInResultSuccess`)
- `resultar/no-unknown-result-error` (`noUnknownResultError`)
- `resultar/prefer-map-err` (`preferMapErr`)
- `resultar/prefer-and-then` (`preferAndThen`)
- `resultar/typed-catch-mapper` (`typedCatchMapper`)
- `resultar/prefer-map` (`preferMap`)
- `resultar/prefer-first-success-of` (`preferFirstSuccessOf`)
- `resultar/prefer-result-for-each` (`preferResultForEach`)
- `resultar/prefer-catch-reason` (`preferCatchReason`)
- `resultar/no-throw` (`noThrow`)
- `resultar/no-try-catch` (`noTryCatch`)
- `resultar/yield-star-in-safe-try` (`yieldStarInSafeTry`)
- `resultar/no-await-in-safe-try` (`noAwaitInSafeTry`)
- `resultar/no-try-catch-in-safe-try` (`noTryCatchInSafeTry`)
- `resultar/prefer-tagged-error` (`preferTaggedError`)
- `resultar/tagged-error-name-match` (`taggedErrorNameMatch`)
- `resultar/no-tagged-error-constructor-override` (`noTaggedErrorConstructorOverride`)
- `resultar/no-useless-recovery` (`noUselessRecovery`)
- `resultar/unsafe-result-type-assertion` (`unsafeResultTypeAssertion`)
- `resultar/no-unsafe-await` (`noUnsafeAwait`, `noUnsafeAwaitMode`, `noUnsafeAwaitIgnoreCalls`)
- shared `ignoreFilePatterns`, `diagnosticSeverity`, `overrides`, and `failOn`

Run it from `packages/check`:

```sh
pnpm native:check
pnpm native:test
pnpm native:build
resultar-check lsp
```

`native:check` targets the package's `../tsconfig.json` by default because Go's
`-C native` option changes the development command's working directory. The
compiled `resultar-check-native` binary resolves `--project` from the caller's
working directory like the public CLI.

The Go module path intentionally lives below `github.com/microsoft/typescript-go`.
TypeScript-Go does not publish a public Go plugin API yet, and Go only permits
imports of its `internal` compiler packages from that namespace. Unlike a fork,
this approach does not patch compiler sources; upgrading is an explicit change
to the single revision in `go.mod`.

All current Resultar rule IDs have a native implementation, and this executable
is the public `resultar-check` CLI backend, including the JSONL, SARIF, JUnit,
and stdio LSP surfaces. npm distributes it through optional
platform packages for macOS, Linux, and Windows on ARM64 and x64. The Node entry
point only selects and executes the matching binary; it has no TypeScript
fallback.
