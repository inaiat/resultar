---
"resultar": minor
"resultar-check": patch
"resultar-hono": minor
---

Add lazy `ResultTask.fromCallback` subscriptions with per-execution cancellation, synchronous cleanup and preserved failure causes. Keep the legacy eager adapter unchanged.

Accept resource factories that propagate `ResultTaskScope` across functions and files, including workflows executed by root runners or explicit scope owners.

Add `runTaskJson` for materialized Hono JSON responses with request cancellation, typed error mapping and preserved RPC/OpenAPI response inference. Services must be provided before execution; task resources close before response mapping.
