---
'resultar-di': patch
---

Name unregistered dependencies in registration type errors. Singleton, scoped, transient, task, and resource dependency lists now report `Service "x" is not registered; register it before listing it as a dependency` instead of collapsing to an unreadable `never` mismatch.
