---
"resultar": minor
---

Add direct and curried functional operators to ResultAsync: `map`, `mapErr`, `andThen`, `orElse`, `inspect`, `inspectError`, `match`, `as`, and `filterOrElse`. The operators preserve the existing eager execution, precise error unions, refinement narrowing, callback rejection, and best-effort observation contracts of their fluent counterparts.
