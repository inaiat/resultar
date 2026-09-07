---
'resultar-di': minor
---

Introduce typed, immutable service modules with explicit dependencies, lazy graph selection,
dedicated singleton/scoped/transient registration methods, long-lived roots, task and resource providers, and value
overrides for tests. Delegate execution and resource finalization to ResultTask scopes, preserving
typed errors and failure causes. Add class-shaped `Service` tokens whose dependencies are resolved
with `yield*`, including singleton, scoped, and transient lifetimes.

Require synchronous creation functions to declare a dependency parameter when their registration
selects dependencies, reporting accidental zero-argument callbacks at the registration.

Validate registered service contracts, resolve tokens inside use callbacks and finalizers, and
detect dependency cycles. Share concurrent singleton initialization with retry after failure,
retain class resources until their owning scope closes, and roll back partial acquisitions.
Make close lazy and idempotent, wait for active child scopes, and retain all cleanup causes.
