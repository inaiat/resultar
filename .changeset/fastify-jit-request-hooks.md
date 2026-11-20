---
"resultar-di": patch
"resultar-fastify": patch
"resultar-nestjs": patch
---

Add Tier 0 / Tier 1 compiled synchronous request dispatch to `resultar-fastify` and `resultar-nestjs` via an internal `resultar-di` sync-plan bridge:

- **`resultar-di`**: Attach a non-enumerable internal sync-plan bridge on root `ServiceScope` instances so framework adapters can share the compiled Tier 0 / Tier 1 subgraph resolvers and counter-based in-flight request tracking with zero public API changes.
- **`resultar-fastify`**: Automatically run callback-style Fastify hooks backed by the compiled Tier 0 / Tier 1 resolver when no request-scoped resources, async tasks, or dynamic `exposeRequest` accessors are used (including single-slot local-key shape caching for synchronous and asynchronous `locals` factories), seamlessly falling back to the full `startSession` Tier 2 path otherwise. Reduces DI overhead per HTTP request by 16x–29x (reaching ~95% of raw Fastify throughput) while preserving abort, error identity, `ResultTaskCauseError`, shutdown draining, and `RESULTAR_JIT=0` parity.
- **`resultar-nestjs`**: Automatically run synchronous Tier 0 / Tier 1 request initialization in `APP_INTERCEPTOR` (returning `next.handle()` directly without `from(Promise).pipe(switchMap(...))`) and `APP_GUARD` (returning `true` synchronously) with shared Fastify `onResponse`/`onRequestAbort` drain hooks and single-slot local-key caching, falling back seamlessly to `startSession` for Tier 2 resources, `exposeRequest`, or `handlerTimeout`. Speeds up NestJS HTTP requests by 1.55x–2.51x (reaching ~84% of raw NestJS in default `interceptor` mode and ~92% with `requestHook: "guard"`), and fixes `app.inject({ signal })` on Node.js 26 where `IncomingMessage.prototype.signal` is a getter-only property.
