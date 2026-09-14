---
"resultar-fastify": patch
---

Use ResultAsync for internal service readiness, completion and shutdown. Adapt lifecycle signals
with fromCallback, preserve eager shared execution and complete failure causes, and convert results
to rejected promises only at native Fastify hook boundaries.

Simplify the Fastify example: createApplication() synchronously returns the native server with
default services. Keep application creation and guarded startup in main.ts so tests can import
the factory without opening a port; test repository overrides through native plugin registration.
