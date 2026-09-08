---
'resultar-check': minor
---

Add five ResultTask and DI diagnostics: no-invalid-lifetime rejects longer-lived services capturing shorter-lived dependencies, no-unscoped-acquire-release requires acquireRelease workflows in ResultTask.gen to run under ResultTask.scoped, no-result-in-task-gen requires plain success returns, no-await-in-result-task-gen keeps gen bodies lazy with yield*, and no-throw-in-task-sync directs sync throws to ResultTask.try with a catch mapper. Suppression directives also match case-insensitively so sentence-case formatters cannot break them.
