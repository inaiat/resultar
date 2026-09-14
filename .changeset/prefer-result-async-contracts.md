---
"resultar-check": minor
"resultar": patch
---

Add prefer-result-async diagnostics for Promise<Result> and Promise<StrictResult> type contracts
and inferred function returns. Support configurable severity, aliases and line suppressions;
provide migration guidance without applying unsafe annotation-only edits. Add the opt-in
preferResultAsyncMode: "all" policy to also catch raw Promise<T> contracts and inferred returns.
Update the Fastify repository and service example to return StrictResultAsync directly, preserve
repository errors, and enforce the all-mode policy with explicit native framework boundaries.
