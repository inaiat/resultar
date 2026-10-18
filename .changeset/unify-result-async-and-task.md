---
"resultar": major
"resultar-di": patch
"resultar-fastify": patch
"resultar-hono": patch
"resultar-request": patch
"resultar-request-typebox": patch
"resultar-request-zod": patch
---

Make `ResultTask` the preferred asynchronous API and extract deprecated eager workflows into `resultar/async`.

- Keep tasks lazy and repeatable, with explicit `runResult`, `runExit`, `runPromise`, and `runFork` boundaries. Tasks are not thenable; `map` remains synchronous.
- Prefer `resultar/async` for `ResultAsync`, `StrictResultAsync` and eager helpers, retaining their root imports for compatibility. Preserve shared single execution, awaited callbacks, native Promise terminals and best-effort observation.
- Preserve Async-producing compatibility methods on Result and tagged errors, plus explicit Task bridges. Keep the eager implementation organized under the Async subpath without patching prototypes.
- `Result.gen` and `Result.fn` support synchronous and eager asynchronous generators with plain returns. The retained legacy `safeTry` preserves final-Result returns in both execution modes.
- Keep `ResultTask.fromResultAsync` as a structural bridge accepting a Result-producing thenable or signal-aware factory.
- HTTP request and lifecycle adapters preserve their eager public behavior and import the separate compatibility implementation explicitly.
