---
"resultar": major
"resultar-di": patch
"resultar-fastify": patch
"resultar-hono": patch
"resultar-request": patch
"resultar-request-typebox": patch
"resultar-request-zod": patch
---

Make `ResultTask` the preferred asynchronous workflow API and unify `ResultAsync` as the in-flight `Result` returned by `task.runResult()` in `resultar`.

- Keep tasks lazy and repeatable, with explicit `runResult`, `runExit`, `runPromise`, and `runFork` boundaries. Tasks are not thenable; `map` remains synchronous.
- Export `ResultAsync`, `StrictResultAsync`, and eager helpers from `resultar`. Preserve shared single execution, awaited callbacks, native Promise terminals and best-effort observation.
- Preserve Async-producing compatibility methods on Result and tagged errors, plus explicit Task bridges.
- `Result.gen` and `Result.fn` support synchronous and eager asynchronous generators with plain returns. The retained legacy `safeTry` preserves final-Result returns in both execution modes.
- Keep `ResultTask.fromResultAsync` as a structural bridge accepting a Result-producing thenable or signal-aware factory.
- HTTP request and lifecycle adapters preserve their eager public behavior using `resultar`.
