---
"resultar": minor
---

Add ResultTask.runFork for immediate root execution with a native fiber handle. Root fibers preserve typed requirements and release errors, own cancellation, and publish their complete Exit only after child and resource cleanup.

Prevent run options from widening a task's declared service requirements to accept incompatible service values.
