# resultar-app

## 0.1.0

### Minor Changes

- 6d50af4: Add resultar-app as the unified entry point for Resultar workflows, dependency
  injection and configuration. Reexport the existing implementations and types,
  including the TypeBox t alias, preserving runtime identity and execution semantics.
  Applications can install resultar-app and keep framework adapters as explicit
  integrations. Migrate the Hono example to the unified entry point.

### Patch Changes

- Updated dependencies [72e8b81]
- Updated dependencies [6d50af4]
  - resultar@4.1.1
  - resultar-config@0.3.0
