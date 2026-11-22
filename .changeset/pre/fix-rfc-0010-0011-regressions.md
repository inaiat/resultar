---
"resultar": patch
"resultar-di": patch
"resultar-hono": patch
---

Fix RFC 0010 and RFC 0011 runtime, concurrency, observability, and DI regressions:

- **`resultar`**:
  - Add a browser-compatible macrotask scheduler fallback (`setTimeout(..., 0)` / `clearTimeout` when `setImmediate` is unavailable) in `VirtualClock.flush()` and `Scheduler.live.yield()`, preserving FIFO wake order and abort cancellation across Node, browsers, and edge runtimes.
  - Allocate a distinct `Interrupt` `Cause` per operation on `Queue.shutdown()` and closed-queue `take()`, preventing span trace cross-contamination across queues and concurrent consumers.
  - Switch `Queue` waiter storage to FIFO `Set`s and immediately unlink and clear payload, callback, and signal references upon offer/take cancellation.
  - Remove consumer-exposed pooling from `OkResultIterator` and `ResultTaskIterator` so retained `.next()` results and simultaneous iterators never alias or mutate each other.
  - Ensure `Match` JIT evaluates property and array element getters strictly once in interpreter-identical order (fixing multi-read predicates such as `Match.nonEmptyString`, `Match.record`, `Match.defined`, zero-read `Match.any`, and `NaN` literals).
- **`resultar-di` & `resultar-hono`**:
  - Replace delimiter-joined sync plan cache keys in `RuntimeScope.getSyncPlan` with structural JSON tuple keys so service names containing NUL or control characters cannot collide.
  - Cache frozen middleware key selections and avoid unnecessary async microtask hops for synchronous `locals` factories in `createHonoServices().middleware()`.
