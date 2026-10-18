---
"resultar": patch
---

Concentrate eager Async factories, generator completion, composition, adapters and
Async-only types in `src/resultar-async`. Keep the existing root and module paths
as compatibility exports with shared identities. Existing Result and Task Async
methods delegate to the legacy implementation without changing execution,
callback, matching or generator contracts.

Mark exported eager factories such as `okAsync`, `errAsync` and `tryResultAsync`
deprecated, directing new workflows to the corresponding ResultTask APIs.
