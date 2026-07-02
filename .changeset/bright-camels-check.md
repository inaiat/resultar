---
"resultar-check": major
---

Add stricter Resultar diagnostics for `safeTry` and thrown errors.

`resultar/no-await-in-safe-try` now defaults to an error so `safeTry` bodies compose Resultar values with `yield*` instead of raw `await`. The new opt-in `resultar/no-throw` rule lets projects enforce expected failures through `Err`/`errAsync` rather than thrown exceptions.
