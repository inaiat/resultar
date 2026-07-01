---
"resultar-check": patch
---

Report `throw new Error(...)` through `resultar/prefer-tagged-error` so raw thrown failures are caught alongside plain Error subclasses and `err(new Error(...))`.
