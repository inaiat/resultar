---
"resultar": patch
"resultar-check": patch
"resultar-check-darwin-arm64": patch
"resultar-check-darwin-x64": patch
"resultar-check-linux-arm64": patch
"resultar-check-linux-x64": patch
"resultar-check-win32-arm64": patch
"resultar-check-win32-x64": patch
---

Preserve eager shared execution, awaited mapping and validation callbacks, best-effort
observation, and Promise-returning boundary matching through the `resultar/async`
subpath in the same package. Preserve the existing root exports and explicit bridges.

Keep tasks lazy and non-thenable, with explicit runners and a structural incoming bridge.
Preserve the concurrent runtime and create complete clock and scheduler contexts at
the public execution boundaries.

Preserve the legacy fluent partial-match fallback type. Avoid generator diagnostics when
the inferred success channel does not contain a nested Result or async workflow.
Recognize `ResultTask.fromResultAsync` as consuming its eager async input in the checker.
