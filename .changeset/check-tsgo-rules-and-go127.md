---
"resultar-check": minor
"resultar-check-darwin-arm64": minor
"resultar-check-darwin-x64": minor
"resultar-check-linux-arm64": minor
"resultar-check-linux-x64": minor
"resultar-check-win32-arm64": minor
"resultar-check-win32-x64": minor
---

Expand `resultar-check` analyzer coverage, add `tsgo`-inspired rules and LSP refactors, and upgrade the native analyzer to Go 1.27 with the latest `github.com/microsoft/TypeScript/tsc` compiler package:

- Upgrade `packages/check/native` to Go 1.27 (`go1.27`) and migrate from `github.com/microsoft/typescript-go` to `github.com/microsoft/TypeScript/tsc` (`v0.0.0-20261015232437-0e081d6fb33d`).
- Complete Stage 1 branch feature coverage across `no-discard`, `no-unsafe-await`, `prefer-first-success-of`, `prefer-result-for-each`, `prefer-map`, `prefer-map-err`, and `no-result-in-task-gen` (including `ResultAsync` as `ResultTask<A, E, never>`, `Semaphore`, `Fiber`, `Result.fn`, `ResultTask.firstSuccessOf`, `ResultTask.forEach`, and static `Result` / `ResultAsync` / `ResultTask` / `TaggedError` constructors).
- Add 11 new `tsgo`-inspired rules with autofixes: `prefer-or-else-succeed`, `prefer-tap`, `prefer-tap-error`, `prefer-as-void`, `prefer-filter-or-else`, `prefer-acquire-disposable`, `no-fn-iife`, `require-return-yield-star`, `no-unnecessary-err-wrap-in-gen`, `unnecessary-pipe`, and `no-run-inside-gen`.
- Add 2 new LSP safe refactors: `Convert to ResultTask.fn` / `Convert to Result.fn` and `Convert to method .pipe()` / `Convert to pipe(...)`.
