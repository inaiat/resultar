---
'resultar': patch
---

Reduce worker startup overhead in `ResultTask.all`, `forEach`, and `validateAll` by filling the worker array directly before awaiting completion.

Resolve immediate successes directly in `ResultTask.runPromise` when called without run options.
