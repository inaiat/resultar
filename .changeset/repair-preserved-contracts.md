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

Preserve existing Async root exports and module paths while keeping the eager
implementation organized under `src/resultar-async`. Restore asynchronous Result
composition, generator support, tagged-error helpers and explicit Task bridges.

Retain Task composition aliases, supported matching and retry forms, and internal
execution contracts. Handle interruption after captured Result promises resolve.
Prevent execution options from widening the task's declared service requirements.
Keep checker recognition aligned with the supported API without treating a Task
as awaitable unless its type actually exposes a `then` method.
