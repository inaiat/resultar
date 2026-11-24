---
"resultar-di": patch
"resultar-fastify": patch
"resultar-hono": patch
"resultar-nestjs": patch
---

Replace dynamic `new Function` code generation in `resultar-di` sync plans with a CSP-safe pure-JavaScript resolver, harden binding/resolver record construction against inherited `Object.prototype` setters, and fix HTTP adapter regressions:

- `resultar-hono`: keep fast-path middleware scopes open through response stream consumption or cancellation and cancel source streams on request abort.
- `resultar-nestjs`: keep Fastify 5 `request.signal` lazy (including on Node 26+ `IncomingMessage.prototype.signal`) while honoring own `request.signal` getters installed by hooks on routes without `handlerTimeout`.
- `resultar-fastify`: decrement the dynamic Tier 2 active counter on client disconnect and abort paths so subsequent unscoped responses skip `WeakMap` lookups.
