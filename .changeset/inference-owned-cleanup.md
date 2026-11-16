---
"resultar": minor
---

Preserve indexed generic returns at synchronous Result.try/tryResult boundaries. Add invariant makeScope<CloseError>() owners that check acquired and direct finalizer error bounds and expose failed-attempt cleanup errors from use(). Existing unparameterized owners retain unknown closure errors.
