# Resultar Cookbook Example

This package is a runnable cookbook for the core `resultar` package. The lint examples show how to
enforce Resultar rules; this package shows the application patterns those rules protect.

Run it from the repository root:

```sh
pnpm run example:resultar
```

Or run the package directly:

```sh
pnpm --filter resultar-example check
pnpm --filter resultar-example smoke
pnpm --filter resultar-example start
```

The `check` script runs Vite+ with every Resultar lint rule configured as an error through
`resultar-lint/oxlint`. The same rule set is also enabled in `tsconfig.json` for editor diagnostics.

## Samples

- `src/sync-validation.ts`: field validation with `Result.validateAll`, tagged errors, redacted
  props, validation adapter issues, and HTTP-style boundary mapping.
- `src/domain-workflow.ts`: a linear domain flow using `andThen`, `mapErr`, and `safeTry` with
  typed error unions.
- `src/tagged-enum.ts`: lightweight tagged unions with `taggedEnum`, `$is`, and exhaustive
  `$match`.
- `src/edge-wrapping.ts`: `tryResult`, `tryResultAsync`, reusable throwing wrappers, safe promises,
  direct error matching, and intentional unwrapping at edges.
- `src/recovery-and-fallbacks.ts`: `catchTag`, `catchTags`, reasoned errors, `unwrapReason`,
  `orElse`, `firstSuccessOf`, and partial boundary matching.
- `src/collections-and-control-flow.ts`: `filterOrElse`, `as`, `unit`, `asyncMap`,
  `asyncAndThen`, `zip`, `combine`, `combineWithAllErrors`, mapped validation, loops,
  conditionals, async concurrency, observation, and disposable cleanup.
- `src/async-resilience.ts`: `ResultAsync.fromPromise`, cooperative `timeout`, retry policies,
  race variants, custom race handling, and abort detection.
- `src/resource-cleanup.ts`: `ResultAsync.withResource` with release assertions for success and
  failure paths.

The smoke script checks the expected `Ok` and `Err` branches so this example stays executable as the
library evolves.
