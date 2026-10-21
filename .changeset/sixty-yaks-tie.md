---
---

Migrate every asynchronous cookbook recipe to ResultTask, with explicit runners, fresh per-run
state, cooperative callback cancellation and scoped resource cleanup. Update smoke coverage and
document the compositions replacing eager helpers and the preserved release-failure semantics.

Correct the package smoke assertion for the retained eager instance matching contract, which
returns the handler output directly.
