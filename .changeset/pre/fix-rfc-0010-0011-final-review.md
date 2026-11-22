---
"resultar": patch
"resultar-di": patch
"resultar-config": patch
"resultar-app": patch
---

Resolve all 12 final-review findings across RFC 0010 and RFC 0011:

- **`resultar`**:
  - Interrupt and clean up asynchronous steps (detaching waiters and suppressing pending continuations such as `.map()`) when `runSync` / `runSyncExit` encounters an asynchronous boundary.
  - Preserve explicit `null` abort reasons in `FiberSignal.abort` (only synthesizing default `DOMException('AbortError')` when `reason === undefined`), matching `runExit` in `runSyncExit` across JIT modes.
  - Isolate `TaskLocal` bindings per item in `ResultTask.all` / `forEach` / `validateAll` while preserving the worker's `scheduling.remaining` yield budget across items.
  - Preserve the `this` receiver for `try` and `catch` methods in JIT-compiled `ResultTask.try` chains.
  - Replace the growing array in `Queue.bounded` with a fixed-capacity circular ring buffer (and periodic compaction in `Queue.unbounded`) so long-running non-empty queues stay O(capacity) in memory.
  - Keep driving `VirtualClock.runToCompletion` automatically when virtual sleeps are scheduled after external Promises during normal execution (success or domain failure) as well as during post-`maxSteps` cleanup (including delayed timers and >10,000 finite sleeps), aborting and draining finalizers before throwing `RangeError`.
  - Clone failure `Cause` values per observer in `Deferred` while preserving origin span traces via `copyCauseSpans`, preventing cross-consumer span contamination.
  - Snapshot input iterables eagerly in `ResultTask.raceAll` and `ResultTask.raceFirstAll` (with an empty-list runtime guard) so post-construction array mutations cannot yield `Success(undefined)`.
  - Interrupt blocked producers waiting in `Queue.shutdown()` (matching RFC 0010 §4) while continuing to resolve subsequent `offer()` calls after shutdown with `Success(false)`.
  - Handle numeric `NaN` tags identically to the interpreter in compiled `Match.discriminator` for both `<= 4` and `> 4` tag lists.
- **`resultar-di`**:
  - Propagate `request.signal` aborts after `scope.fetch` delivers a sync or async `Response` on the Tier 0 / Tier 1 fast path, coordinating overlapping or re-entrant `reader.cancel()` and `request.signal` aborts onto a single shared cancellation promise published synchronously before invoking the producer's `cancel()` (across both fast-path and resource-scoped `fetch`), keeping scopes open until producer cleanup finishes, and rejecting already-locked response bodies consistently while releasing the scope once.
  - Preserve services named `"__proto__"` as own enumerable properties across compiled plans, interpreted fallbacks, and service resolvers without prototype mutation.
- **`resultar-config` & `resultar-app`**:
  - Remove the top-level `env-schema` dependency whose module initialization invoked `new Function` via AJV on import, so all workspace packages import and construct lazy definitions cleanly under `node --disallow-code-generation-from-strings`, and document that AJV compilation still applies lazily at `appConfig` / `load()` resolution time.
