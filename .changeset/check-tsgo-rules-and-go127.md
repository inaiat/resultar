---
"resultar-check": major
"resultar-check-darwin-arm64": major
"resultar-check-darwin-x64": major
"resultar-check-linux-arm64": major
"resultar-check-linux-x64": major
"resultar-check-win32-arm64": major
"resultar-check-win32-x64": major
---

Expand `resultar-check` analyzer coverage, add `tsgo`-inspired rules and LSP refactors, and upgrade the native analyzer to Go 1.27 with the latest `github.com/microsoft/TypeScript/tsc` compiler package:

- Upgrade `packages/check/native` to Go 1.27 (`go1.27`) and migrate from `github.com/microsoft/typescript-go` to `github.com/microsoft/TypeScript/tsc` (`v0.0.0-20261015232437-0e081d6fb33d`).
- Complete Stage 1 branch feature coverage across `no-discard`, `no-unsafe-await`, `typed-catch-mapper`, `no-run-inside-gen`, `prefer-first-success-of`, `prefer-result-for-each`, `prefer-map`, `prefer-and-then`, `prefer-map-err`, `prefer-catch-reason`, `no-useless-recovery`, and `no-result-in-task-gen` (including `ResultAsync` as `ResultTask<A, E, never>`, `MatchMatcher` finalizers, `Semaphore`, `Fiber`, `Result.fn`, `ResultTask.try` / `ResultTask.tryPromise`, `ResultAsync.fromTask`, `ResultTask.firstSuccessOf`, `ResultTask.forEach`, and static/curried `Result` / `ResultAsync` / `ResultTask` / `TaggedError` operators and constructors).
- Add 11 new `tsgo`-inspired rules with autofixes: `prefer-or-else-succeed`, `prefer-tap`, `prefer-tap-error`, `prefer-as-void`, `prefer-filter-or-else`, `prefer-acquire-disposable`, `no-fn-iife`, `require-return-yield-star`, `no-unnecessary-err-wrap-in-gen`, `unnecessary-pipe`, and `no-run-inside-gen`.
- Add 2 new LSP safe refactors: `Convert to ResultTask.fn` / `Convert to Result.fn` and `Convert to method .pipe()` / `Convert to pipe(...)`.
- Support `"diagnosticSeverity": "<severity>"` shorthand and `"*"` wildcard inside `diagnosticSeverity` (globally and in `overrides`) to set the baseline severity for all 41 rules at once.
