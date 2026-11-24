---
"resultar-fastify": patch
"resultar-hono": patch
"resultar-nestjs": patch
---

Register active request scopes before synchronous plan resolution in `resultar-hono`, `resultar-fastify`, and `resultar-nestjs` so shutdown initiated inside a synchronous factory waits for in-flight handlers and response streams before releasing singletons, and require `settleResponse` on the `resultar-di` fast-path bridge in `resultar-hono` so partial upgrades fall back cleanly to `scope.fetch`.
