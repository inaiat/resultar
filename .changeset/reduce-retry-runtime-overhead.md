---
'resultar': patch
---

Reduce ResultTask retry overhead by avoiding Promise allocation for synchronous cleanup,
completed retry loops, and synchronous policy hooks when the run cannot be interrupted.
Reuse untouched attempt scopes without retaining acquired resources across attempts.
Preserve per-attempt resource cleanup, cancelable hooks, asynchronous hook adoption,
retry delays, and legacy callback contracts.
