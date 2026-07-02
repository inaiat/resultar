---
"resultar-check": patch
---

Report `await` on Resultar async values inside raw `Promise<T>` functions when `noUnsafeAwaitMode` is `all`, so application boundaries preserve `ResultAsync` or `Promise<Result>` error channels instead of unwrapping and throwing.
