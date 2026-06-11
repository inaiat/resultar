# resultar-tsgo

## 3.0.0

### Major Changes

- a65670f: Release v3: split the project into publishable workspace packages, add Resultar no-discard language-service tooling and the tsgo wrapper, remove TypeDoc docs generation, and expand the README/DOCUMENTATION guides.

### Patch Changes

- 45f75f2: Rename the public no-discard command surface to the generic `resultar-lint` CLI.
  `resultar-lint check` now runs the compiler-backed diagnostics, `resultar-lint doctor`
  checks TypeScript patch status, and the legacy `resultar-no-discard` binary plus
  `resultar-lint/no-discard` package subpath are no longer public entrypoints.
- Updated dependencies [c2023ff]
- Updated dependencies [a65670f]
- Updated dependencies [45f75f2]
  - resultar-lint@3.0.0

## 3.0.0-alpha.3

### Patch Changes

- 45f75f2: Rename the public no-discard command surface to the generic `resultar-lint` CLI.
  `resultar-lint check` now runs the compiler-backed diagnostics, `resultar-lint doctor`
  checks TypeScript patch status, and the legacy `resultar-no-discard` binary plus
  `resultar-lint/no-discard` package subpath are no longer public entrypoints.
- Updated dependencies [45f75f2]
  - resultar-lint@3.0.0-alpha.3

## 3.0.0-alpha.2

### Major Changes

- a65670f: Release v3: split the project into publishable workspace packages, add Resultar no-discard language-service tooling and the tsgo wrapper, remove TypeDoc docs generation, and expand the README/DOCUMENTATION guides.

### Patch Changes

- Updated dependencies [a65670f]
  - resultar-lint@3.0.0-alpha.2
