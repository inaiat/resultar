---
"resultar": minor
---

Preserve indexed generic returns at synchronous Result.try/tryResult boundaries. Add invariant makeScope<CloseError>() owners that check acquired and direct finalizer error bounds and expose failed-attempt cleanup errors from use(). Existing unparameterized owners retain unknown closure errors.

Compatibility note for 4.1: `makeScope().use(task)` now includes errors from the
adopted task's cleanup in its return type, including when `makeScope()` is called
without a type parameter. Explicit annotations that previously declared only the
body error (or `never`) may no longer compile. Prefer inference or include the
cleanup error in the annotated error union. This corrects an omitted failure
channel; it does not change eager/lazy execution semantics.
