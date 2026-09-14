# resultar-di

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

- Updated dependencies [8bf0d07]
- Updated dependencies [c823e56]
- Updated dependencies [c823e56]
  - resultar@3.8.0

## 0.1.0

### Minor Changes

- fcf0f14: Introduce typed, immutable service modules with explicit dependencies, lazy graph selection,
  dedicated singleton/scoped/transient registration methods, long-lived roots, task and resource providers, and value
  overrides for tests. Delegate execution and resource finalization to ResultTask scopes, preserving
  typed errors and failure causes. Add class-shaped `Service` tokens whose dependencies are resolved
  with `yield*`, including singleton, scoped, and transient lifetimes.
  
  Require synchronous creation functions to declare a dependency parameter when their registration
  selects dependencies, reporting accidental zero-argument callbacks at the registration.
  
  Validate registered service contracts, resolve tokens inside use callbacks and finalizers, and
  detect dependency cycles. Share concurrent singleton initialization with retry after failure,
  retain class resources until their owning scope closes, and roll back partial acquisitions.
  Make close lazy and idempotent, wait for active child scopes, and retain all cleanup causes.
- fcf0f14: Add module.http() to acquire a Fetch application with automatic root ownership and response
  scopes. Simplify the Hono example to reuse one router with request services in typed bindings.
  Move class-shaped Service exports to resultar-di/advanced and separate the advanced reference
  from the main API guide. Add a repeatable local comparison of shared and per-request routers.
- fcf0f14: Prune overridden provider errors and requirements from the type graph. Replace branching type
  traversal with dependency-set traversal to prevent excessive instantiation in larger graphs.
  Add repeatable public-declaration scale checks and improve resolution-path diagnostics.
- fcf0f14: Keep token registration in the primary autocomplete throughout fluent composition. Move named registration overloads and module-level task/resource typing to the advanced entry point. Explain duplicate registrations and asynchronous factory mistakes in compiler diagnostics.
- fcf0f14: Add inferred service and resource tokens that share singleton/scoped/transient registration,
  immutable module merging, and typed request-local values. Add a Fetch-compatible scope adapter
  that retains resources through response streaming and cancellation, with a Hono example using
  one child per request. Infer errors and requirements from selected dependencies with bounded
  type traversal, improve incompatible-contract diagnostics, and preserve close error types.

### Patch Changes

- 28ec63c: Name unregistered dependencies in registration type errors. Singleton, scoped, transient, task, and resource dependency lists now report `Service "x" is not registered; register it before listing it as a dependency` instead of collapsing to an unreadable `never` mismatch.
- fcf0f14: Add typed Hono bindings, response-scoped service ownership and explicit application shutdown. Provide a runnable Deno example without runtime-specific adapters. Export adapter type helpers from DI's advanced entry point and generate declaration imports that resolve in Deno workspace consumers.
- Updated dependencies [fcf0f14]
- Updated dependencies [fcf0f14]
- Updated dependencies [fcf0f14]
  - resultar@3.7.0
