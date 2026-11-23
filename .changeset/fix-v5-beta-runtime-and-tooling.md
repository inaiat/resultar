---
"resultar": patch
"resultar-check": patch
"resultar-di": patch
"resultar-hono": patch
"resultar-request": patch
"resultar-request-zod": patch
"resultar-fastify": patch
"resultar-nestjs": patch
"resultar-request-typebox": patch
---

Fix duplicate execution in `ResultTask.runResult()`, native Promise adoption, tagged error formatting, and parity between compiled and interpreted Tasks. Synchronous runners now handle pure workflows through collection, recovery, and cleanup operators. Preserve cancellation and failure spans across scopes and deferred observers.

Align request error causes and cancellation signals across HTTP adapters, defer TypeBox compilation until decoding, and synchronize dependency mappings in the JSR manifests.

Keep Resultar quick fixes available alongside TypeScript semantic diagnostics, preserve callback semantics in tap suggestions, and apply nested v5 migrations to convergence. Editor setup supports JSONC.

Preserve the original rejection reason from a failing `tryPromise` error mapper. Apply synchronous retry and repeat hooks without introducing a Promise. Honor deadline order across concurrent virtual clock drivers, retain nested composite span frames, and support tagged enum variants named after Object prototype properties.

Exclude default and rest parameters from tap and tapError suggestions to preserve callback return values when applying fixes.

Keep callback exceptions observable by withholding inspect autofixes for property access and destructuring, and skip tap suggestions for generator callbacks.

Observe interruption between `ResultTask.iterate` steps that return synchronous Results. Honor custom clock sleeps when repeating with zero delay, including during `runSync()`.

Preserve the original rejection reason when migrating to `runPromise()`, and honor scheduler budgets for synchronous `loop` and `firstSuccessOf` steps. Limit automatic `inspect` conversions to simple local writes. Migrate nested chains to convergence and generate fresh callback parameter names without shadowing handler bindings.

Preserve composite failure typing, span outcomes, finalizer defects, and scheduler yields across Task execution modes. Support synchronous service resolution and disposal, and preserve object receivers in synchronous Result callbacks. Keep tagged enum factories compatible with Promise resolution and retain own metadata during serialization.

Stop Fastify routes and subsequent hooks when a service hook fails with a falsy value or the request disconnects while resolving locals. Align locked response stream failures across DI execution paths. Skip schema compilation when TypeBox acceleration is unavailable. Preserve explicit eager types, optional execution, import bindings, and nested getters in migration and editor fixes.

Report an invalid `catchReason` or `catchReasons` handler return as a defect when the reason matches.

Check cancellation before computing a repeat delay when the clock aborts while reading the elapsed budget.
Recognize Promise-like values returned by Task inspectors consistently with the retry and repeat hooks.
