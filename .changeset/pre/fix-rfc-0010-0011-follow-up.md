---
"resultar": patch
"resultar-fastify": patch
"resultar-nestjs": patch
---

Fix second-review RFC 0010 / RFC 0011 follow-up regressions:

- **`resultar`**: Restore `_tag`, `fingerprint`, `messageTemplate`, and `name` as own enumerable instance properties on `createTaggedError` instances (matching `cacb729` descriptors so `Object.keys(error)` and `{ ...error }` preserve discriminator and metadata) while keeping the shared frozen `fingerprint` tuple and 1-argument `super(message)` fast path when `cause` is omitted.
- **`resultar-fastify`**: Observe `reply.raw` `close` alongside `onResponse` and `onRequestAbort` via a single idempotent finalizer on Tier 0 / Tier 1 fast request hooks (both static bindings and per-request `locals`), removing the listener on settlement and calling `endChild()` exactly once so `app.close()` never hangs after client disconnects during streamed replies.
- **`resultar-nestjs`**: Apply the same idempotent `rawResponse` `close` finalizer to the Fastify-backed Tier 0 / Tier 1 fast request tracker so streamed client disconnects release child tracking cleanly without double-decrementing active requests.
