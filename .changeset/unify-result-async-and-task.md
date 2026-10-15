---
"resultar": major
"resultar-di": patch
"resultar-fastify": patch
"resultar-hono": patch
---

Unify `ResultAsync<T, E>` with `ResultTask<T, E, never>`:

- Make `ResultTask<A, E, never>` directly `PromiseLike<Result<A, E>>` when all dependencies are satisfied (`R = never`), blocking `await` at compile time when unsatisfied `ServiceTag` requirements remain (`R !== never`).
- Define `ResultAsync<T, E = never>` as `ResultTask<T, E, never>` and unify its runtime prototype with `ResultTask` so `instanceof ResultAsync` and `instanceof ResultTask` are equivalent.
- Preserve `ResultAsync` constructors (`fromPromise`, `fromSafePromise`, `fromThrowable`, `safeTry`) and curried/data-first module functions while executing under the unified `ResultTask` fiber runtime.
