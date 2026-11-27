---
"resultar-fastify": patch
"resultar-nestjs": patch
---

Distribute `ModuleInfo<M>` over union `ServiceModule` branches (such as factories with conditional `.override(...)`) while still rejecting unions with any invalid module branch, fixing false `invalidModule` errors under TypeScript 5.x.
