# resultar-hono

## 0.2.0

### Minor Changes

- 1ffab20: Add a native Fastify plugin with typed application and request service selections, request locals,
  startup rollback, cancellation and resource cleanup through streamed responses. Add per-route
  Hono services middleware that preserves native bindings and RPC inference. Both integrations
  reuse Resultar DI scopes; application callbacks can explicitly restrict resolution to singletons
  with useSingletons. Existing createHonoApp behavior remains compatible.
  Compose Fastify lifecycle recovery with Resultar while preserving original failures and awaited rollback.

### Patch Changes

- Updated dependencies [8bf0d07]
- Updated dependencies [c823e56]
- Updated dependencies [1ffab20]
- Updated dependencies [c823e56]
  - resultar@3.8.0
  - resultar-di@0.2.0

## 0.1.0

### Minor Changes

- fcf0f14: Add typed Hono bindings, response-scoped service ownership and explicit application shutdown. Provide a runnable Deno example without runtime-specific adapters. Export adapter type helpers from DI's advanced entry point and generate declaration imports that resolve in Deno workspace consumers.

### Patch Changes

- Updated dependencies [fcf0f14]
- Updated dependencies [fcf0f14]
- Updated dependencies [fcf0f14]
- Updated dependencies [fcf0f14]
- Updated dependencies [fcf0f14]
- Updated dependencies [fcf0f14]
- Updated dependencies [fcf0f14]
- Updated dependencies [fcf0f14]
- Updated dependencies [28ec63c]
- Updated dependencies [fcf0f14]
  - resultar@3.7.0
  - resultar-di@0.1.0
