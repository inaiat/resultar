---
"resultar": minor
---

Add lazy Fiber.await to observe a child's complete Exit after cleanup without
interrupting it, while preserving existing structural Fiber handles.

Add opt-in interruption: "detach" to object-form ResultTask.tryPromise so abort
can stop waiting for foreign promises. The default still waits for settlement.
Detached waits observe late rejection, stop continuations, and retain normal
owned finalization; underlying work can continue if it ignores the signal.
