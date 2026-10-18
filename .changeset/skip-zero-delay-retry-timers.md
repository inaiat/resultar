---
'resultar': patch
---

Avoid scheduling a live-clock timer for ResultTask retries whose computed delay is zero.
Skip asynchronous retry-hook handling when no predicate or observer is configured.
Preserve attempt cleanup, retry hooks, cooperative scheduling, cancellation, positive delays,
and custom or virtual clock sleep behavior.
