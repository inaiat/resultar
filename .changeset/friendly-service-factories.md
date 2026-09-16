---
"resultar-di": minor
"resultar-fastify": minor
"resultar-hono": minor
"resultar": patch
---

Allow class services with `requires` to return synchronous service values directly from `make`,
without wrapping ordinary object construction in `ResultTask.sync`.

Keep task-returning factories and generator-based definitions compatible. Normalize construction
to a lazy `ResultTask`, preserving dependency inference, explicit contracts, lifetimes and cleanup.
Reject Promise and callable-then factory returns, including unions with synchronous values.
Update the adapter examples and bundled agent guide to demonstrate the simpler factory form.
Add optional application startup tasks to the Fastify and
Hono adapters, with `R` validation, one-time lazy execution and rollback on failure.
Run Fastify startup in `onReady`, supporting a native application factory. Retain startup resources
until shutdown through a shared DI session, release them before singleton dependencies, and preserve
initialization and cleanup failures. Hono close cancels pending startup and blocks waiting requests.
Expose `startServiceTask`, `ServiceTaskSession` and `ServiceTaskRequirements` from DI for adapters
that need the same task lifecycle and dependency validation.

Consolidate the DI documentation into its README, removing the separate advanced guide and updating
package contents and agent documentation links.
