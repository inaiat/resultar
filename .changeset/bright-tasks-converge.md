---
"resultar": major
"resultar-check": major
"resultar-check-darwin-arm64": major
"resultar-check-darwin-x64": major
"resultar-check-linux-arm64": major
"resultar-check-linux-x64": major
"resultar-check-win32-arm64": major
"resultar-check-win32-x64": major
"resultar-di": major
"resultar-hono": major
"resultar-fastify": major
"resultar-request": major
"resultar-request-typebox": major
"resultar-request-zod": major
---

Prepare the next core major while preserving existing composition names,
safeTry Result-returning generators, tap observation behavior, exports and checker
configuration. Add best-effort task observation with inspect/inspectError.
Retain previous method names with deprecation annotations and equivalent
replacements so consumers can migrate gradually. Result/ResultAsync tap remains
best-effort observation; inspect provides the same behavior under the new name.

Add scope-owned child fibers, structured races and timeouts, bounded task
collections, per-attempt scoped retries, live/virtual clocks, and parallel causes.
Preserve eager ResultAsync and lazy, repeatable ResultTask execution.

Normalize asynchronous matching return types, narrow partial fallbacks safely,
retain errors for optional tagged recovery handlers and preserve union-table outputs,
add typed Match contexts, and improve finite object-pattern exhaustiveness.
Preserve native Hono response unions and Fastify response contracts.

Recognize yielded Results and task collection/fiber consumers in the checker,
and expose Match coverage in hover. Update companion cause inspection for
parallel failures. Existing APIs remain supported; exhaustive Cause consumers
must handle the new Parallel branch, and corrected tagged recovery types retain
errors that optional handlers do not guarantee to recover.
