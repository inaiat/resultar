---
"resultar": patch
---

Simplify redundant callback settlement and cancellation bookkeeping while preserving
lazy execution, first-callback-wins semantics and cleanup defects. Add regression
coverage for abort-listener removal and cleanup failures from interrupted race losers.
