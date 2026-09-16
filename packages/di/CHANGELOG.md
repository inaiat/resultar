# resultar-di

## 0.4.1

### Patch Changes

- d6eefe0: Allow Service factories to omit requires when they do not declare injected dependencies. Preserve lazy construction, explicit contracts, inferred task requirements and errors, and rejection of Promise factories.

## 0.4.0

### Minor Changes

- 9f5fa1f: Allow class services with `requires` to return synchronous service values directly from `make`,
  without wrapping ordinary object construction in `ResultTask.sync`.
  
  Keep task-returning factories and generator-based definitions compatible. Normalize construction
  to a lazy `ResultTask`, preserving dependency inference, explicit contracts, lifetimes and cleanup.
  Reject Promise and callable-then factory returns, including unions with synchronous values.
  Update the adapter examples and bundled agent guide to demonstrate the simpler factory form.
  Add optional application startup tasks to the Fastify and
  Hono adapters, with `R` validation, one-time lazy execution and rollback on failure.
  Run Fastify startup in `onReady`, supporting a native application factory. Retain startup resources
  until shutdown through a shared DI session, release them before singleton dependencies, and preserve
  initialization and cleanup failures. Hono close cancels pending startup and blocks waiting requests.
  Expose `startServiceTask`, `ServiceTaskSession` and `ServiceTaskRequirements` from DI for adapters
  that need the same task lifecycle and dependency validation.
  
  Consolidate the DI documentation into its README, removing the separate advanced guide and updating
  package contents and agent documentation links.

### Patch Changes

- Updated dependencies [9f5fa1f]
  - resultar@3.9.1

## 0.3.0

### Minor Changes

- 2fc19dd: Infer literal service identifiers with `ResultTask.service<Contract>()("name")` while retaining the direct overload.
  
  Add `Service.require<Contract>()("name")` and optional `Service` dependency maps through `requires`. Construction factories receive inferred readonly dependencies and return a lazy ResultTask. Existing generator-only definitions, token identity, typed requirements and scope lifetimes remain supported.
  
  Require Resultar 3.9 or newer in the DI package's JSR import map so the curried service primitive is available.
  
  Make the Fastify and Hono examples self-contained, with class services using explicit `requires` maps, a repository, cache and function-based health service. Import the primary DI API through each framework integration and keep matching file layouts for services, routes and server startup. Omit optional bindings in both examples to expose all registered services.
- 2fc19dd: BREAKING: remove the `resultar-di/advanced` entry point. Replace all imports from
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

### Patch Changes

- 2fc19dd: Allow omitting `bindings` in `createFastifyApp`, `createFastifyPlugin` and `createHonoApp`.
  Omission selects all registered services, validates their requirements and infers their
  readonly request view. Explicit selections and `bindings: []` retain their existing behavior;
  Fastify `appBindings` still defaults to an empty selection. Request locals satisfy dependencies
  but are not automatically exposed as registered services.
  Explicit selections must be literal tuples; ambiguous tuple unions and widened arrays are
  rejected so request types cannot promise services absent from the runtime selection.
  
  Selected services are resolved before the handler, preserving lazy application construction,
  scope lifetimes, failure propagation and cleanup. This is not property-based lazy resolution:
  a failure acquiring any default-selected service prevents the handler from executing.
  
  Use the Fastify and Hono example applications as integration cases in each package's test suite,
  covering their real service graph, native routes, overrides and application isolation without
  starting a listener. Both examples demonstrate omitted bindings and inferred application types.
- Updated dependencies [2fc19dd]
  - resultar@3.9.0

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
