# Resultar Cookbook Example

This package is a runnable cookbook for the core `resultar` package. It uses `resultar-check` so the
same command type-checks with TypeScript 7 and enforces Resultar rules.

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

The `check` script runs `resultar-check`. The Resultar rule set is
configured in `tsconfig.json`.

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
