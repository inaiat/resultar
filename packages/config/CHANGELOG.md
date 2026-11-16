# resultar-config

## 0.3.0

### Minor Changes

- 6d50af4: Reexport TypeBox's `Type` as `t` so configuration schemas and `defineAppConfig`
  can be imported from `resultar-config` together. Preserve schema inference and
  compatibility with direct TypeBox imports. Move TypeBox from a peer dependency to
  a runtime dependency with range `>=1.3.4 <2.0.0`, so using `t` requires no separate
  TypeBox installation.
  Update the Hono example and configuration recipe to use the new alias.

### Patch Changes

- Updated dependencies [72e8b81]
  - resultar@4.1.1

## 0.2.0

### Minor Changes

- cfb4f9c: Add lazy TypeBox environment configuration modules with isolated snapshots, finite-number validation, safe aggregated ConfigError issues and exact DI graph inference.

  Use the configuration module in the Hono example, validating PORT before listening
  and sharing the validated snapshot with request services. Include isolated-source
  and invalid-startup smoke coverage.

  Add `AppConfigModule.load()` for direct typed configuration loading as a lazy
  ResultTask, with a fresh isolated snapshot per execution. Simplify Hono startup
  and document how to reuse the validated value in application services.

### Patch Changes

- Updated dependencies [ca8a242]
- Updated dependencies [cfb4f9c]
- Updated dependencies [210f3a3]
- Updated dependencies [6f4712a]
- Updated dependencies [210f3a3]
  - resultar@4.1.0
