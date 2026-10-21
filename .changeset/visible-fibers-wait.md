---
"resultar": minor
---

Expose native fiber IDs, synchronous polling after cleanup, and removable best-effort
exit observers. These diagnostics preserve owned child failure reporting.

Add opt-in `interruption: "detach"` to native and namespace fiber joins. Default
joins retain their existing waiting behavior; detached cancellation stops only the
waiter and leaves undelivered child failures owned by their parent scope.
