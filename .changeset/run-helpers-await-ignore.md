---
"resultar": minor
"resultar-check": minor
---

Add `runSync` and `runPromise` helpers for explicit final Resultar boundaries.

Add `noUnsafeAwaitIgnoreCalls` to `resultar-check` so projects can configure exact call paths, such as `fastify.after`, that should be ignored by `resultar/no-unsafe-await`.
