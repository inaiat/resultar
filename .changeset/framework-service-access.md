---
"resultar": minor
"resultar-di": minor
"resultar-fastify": minor
---

Support framework facades that retain synchronous, lazy service access while sharing Resultar DI's
resolution cache, lifetime checks and resource ownership. Add advanced provider registration,
module metadata and scoped service access, backed by synchronous finalizer registration on a
ResultTask scope owner. Existing native module factory timing remains unchanged.

Allow Fastify facades to choose onRequest registration, expose application/request service views
and map terminal lifecycle errors. Native selected-service defaults remain in preHandler. Facades
can opt to report rollback failures only at startup without repeating them on subsequent close.
