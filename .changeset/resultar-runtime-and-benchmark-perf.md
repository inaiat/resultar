---
"resultar": minor
"resultar-di": patch
---

Optimize async `ResultTask.gen` continuation fast paths, fuse `tryPromise` + `map`/`mapErr`/`andThen`/`orElse` combinator chains directly inside `runResult()`, pool root contexts and fiber handles in `ResultTask.runFork()` (plus fuse `inspectCause()` over `tryPromise` and reuse a shared closure in `asVoid()`), optimize `createTaggedError` metadata copying and add opt-in `captureStackTrace: false`, compile tree-shaped Tier 1 DI plans into allocation-free closures, and eliminate hot-path overhead in `benchmarks/comparison/url-shortener-resultar`.
