---
"resultar": minor
"resultar-check": patch
---

Add runResult, runPromise, runExit, and runFork instance methods to ResultTask with the same
execution, required services, cancellation, and scoped error contracts as the static runners.
Keep both entry points supported, recognize the fluent boundaries in Resultar diagnostics, and
adopt the instance methods in runnable examples and agent documentation.
