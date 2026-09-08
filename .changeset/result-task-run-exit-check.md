---
'resultar-check': patch
---

Recognize ResultTask.runExit as a safe await boundary in no-unsafe-await. Keep diagnostics for
runPromise and unrelated APIs named runExit. Discovered while adopting ResultTask scopes in a private consumer.
