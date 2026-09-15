---
"resultar-di": minor
"resultar-fastify": patch
"resultar-hono": patch
---

BREAKING: remove the `resultar-di/advanced` entry point. Replace all imports from
`resultar-di/advanced` with `resultar-di` before upgrading. The pre-1.0 DI package
ships this breaking change in its next minor release.

Expose one `createModule` and `ServiceModule` supporting token/class registration,
named factories, task/resource registration, and fluent composition. Export
`inspectModule`, `withProvider`, `useServiceAccess`, `ServiceAccessError` and their
public types from the same entry point. Resolution, lazy initialization, lifetimes
and resource ownership remain unchanged. No compatibility alias is retained.

Update Fastify and Hono to use the unified entry point while preserving their
explicit application-facing DI reexports. External framework facades that
imported the removed subpath must migrate their imports when adopting this release.
