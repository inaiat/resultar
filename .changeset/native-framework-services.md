---
"resultar-di": minor
"resultar-hono": minor
"resultar-fastify": minor
---

Add a native Fastify plugin with typed application and request service selections, request locals,
startup rollback, cancellation and resource cleanup through streamed responses. Add per-route
Hono services middleware that preserves native bindings and RPC inference. Both integrations
reuse Resultar DI scopes; application callbacks can explicitly restrict resolution to singletons
with useSingletons. Existing createHonoApp behavior remains compatible.
Compose Fastify lifecycle recovery with Resultar while preserving original failures and awaited rollback.
