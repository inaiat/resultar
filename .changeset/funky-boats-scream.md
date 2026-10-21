---
"resultar": minor
---

Add Result.fromNullishOr and Result.liftPredicate with direct and curried forms,
preserving non-nullable success types, refinements, and concrete error types.
Add Cause.hasFails, hasDies, hasInterrupts, findError, and pretty for inspecting
and formatting the existing sequential failure tree without changing task runners.


