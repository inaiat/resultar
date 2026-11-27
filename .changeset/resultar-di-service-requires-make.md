---
"resultar-di": minor
---

Extend `service` with `{ requires?, make }` definitions (supporting both synchronous and `ResultTask` `make`), curried explicit contracts (`service<Contract>()(...)`), and `service.require<T>()(name)` alongside the existing `service(name, task)` and 3-argument `service(name, dependencies, syncFactory)` forms.
