# resultar-fastify

## 0.2.0

### Minor Changes

- c823e56: Support framework facades that retain synchronous, lazy service access while sharing Resultar DI's
  resolution cache, lifetime checks and resource ownership. Add advanced provider registration,
  module metadata and scoped service access, backed by synchronous finalizer registration on a
  ResultTask scope owner. Existing native module factory timing remains unchanged.

  Allow Fastify facades to choose onRequest registration, expose application/request service views
  and map terminal lifecycle errors. Native selected-service defaults remain in preHandler. Facades
  can opt to report rollback failures only at startup without repeating them on subsequent close.
- 1ffab20: Add a native Fastify plugin with typed application and request service selections, request locals,
  startup rollback, cancellation and resource cleanup through streamed responses. Add per-route
  Hono services middleware that preserves native bindings and RPC inference. Both integrations
  reuse Resultar DI scopes; application callbacks can explicitly restrict resolution to singletons
  with useSingletons. Existing createHonoApp behavior remains compatible.
  Compose Fastify lifecycle recovery with Resultar while preserving original failures and awaited rollback.

### Patch Changes

- c823e56: Use ResultAsync for internal service readiness, completion and shutdown. Adapt lifecycle signals
  with fromCallback, preserve eager shared execution and complete failure causes, and convert results
  to rejected promises only at native Fastify hook boundaries.

  Simplify the Fastify example: createApplication() synchronously returns the native server with
  default services. Keep application creation and guarded startup in main.ts so tests can import
  the factory without opening a port; test repository overrides through native plugin registration.
- Updated dependencies [8bf0d07]
- Updated dependencies [c823e56]
- Updated dependencies [1ffab20]
- Updated dependencies [c823e56]
  - resultar@3.8.0
  - resultar-di@0.2.0
