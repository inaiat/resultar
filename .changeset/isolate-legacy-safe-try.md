---
"resultar": patch
---

Keep one deprecated `safeTry` implementation and its legacy types in the Async
compatibility layer. Preserve the root and old module exports as re-exports, with
the same synchronous and asynchronous final-Result behavior. Task generators use
`ResultTask.gen` independently of the legacy helper.
