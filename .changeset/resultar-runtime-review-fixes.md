---
"resultar": patch
---

Preserve cooperative scheduling budgets across chained `tryPromise`/`andThen` fast paths in `ResultTask.runResult()`, restore `Error.stackTraceLimit` via `try`/`finally` while preserving absent limits when a tagged error base constructor throws, deliver `options.services` getter failures through the returned fiber in `ResultTask.runFork()` while disposing external abort listeners, and keep inherited/subclass methods intact during single-key tagged-error metadata copying. Also align URL creation validation and insert-time alias collision handling in `url-shortener-effect` and use graceful `worker.close()` during shutdown in `url-shortener-resultar`.
