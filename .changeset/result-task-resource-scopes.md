---
'resultar': minor
---

Add ResultTask resource scopes with acquireRelease and scoped, LIFO asynchronous finalizers,
deferred release error inference, and cooperative interruption. runExit preserves sequential
execution and cleanup causes; runResult rejects composite causes with ResultTaskCauseError.
Keep ResultAsync.withResource behavior unchanged and document the application lifecycle pattern.
Add a lazy ResultTask service resolver for dependency-injection adapters.
