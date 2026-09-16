# resultar-fastify

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
  - resultar-di@0.4.0
  - resultar@3.9.1

## 0.3.0

### Minor Changes

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
- 2fc19dd: Add `createFastifyApp(options, configure)` to create a native Fastify instance, register the existing Resultar services plugin and configure routes synchronously. It preserves binding validation and lazy provider initialization; Fastify still owns startup, requests and shutdown. Simplify the Fastify example to match Hono's application factory.
  
  Preserve selected service types on the returned `FastifyServicesApplication` so `InferRequestServices<typeof createApplication>` and `InferAppServices` derive declarations from the bindings or custom exposed views. The type metadata adds no runtime properties, and native route plugins and autoload remain compatible.
  
  Allow both inference helpers to accept factory functions directly, preserving inference from application instances and callable service plugins.
- 2fc19dd: Reexport the Resultar DI application helpers from both framework integrations: `createModule`, `Service`, `service`, `resource`, and their public types. Applications can declare and register services without importing or directly installing `resultar-di`. Framework-independent shared code can continue using `resultar-di` directly.

### Patch Changes

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
- Updated dependencies [2fc19dd]
- Updated dependencies [2fc19dd]
- Updated dependencies [2fc19dd]
  - resultar@3.9.0
  - resultar-di@0.3.0

## 0.2.1

### Patch Changes

- e31669c: Keep request service scopes alive when Fastify signals a generic abort after a complete HTTP request body. Real client disconnects and response transport errors still cancel the scope, and explicit native timeout reasons remain forwarded. Add real-network JSON and streaming-response regression tests.

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
