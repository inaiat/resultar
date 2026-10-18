---
'resultar': patch
---

Reduce allocations in ResultTask collections by creating child scopes and runtime contexts
only when an item needs them. Immediately successful tasks retain their scheduling budget,
parallel execution boundaries, cancellation checks, and per-item cleanup behavior.
Allocate failure and validation-error storage only after a failure occurs.
