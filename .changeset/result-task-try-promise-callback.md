---
"resultar": minor
---

Add a lazy callback overload to ResultTask.tryPromise with unknown failures and the runtime AbortSignal. Keep the explicit error-mapping overload and simplify the Deno bootstrap to use the new API directly.
