# Resultar Cookbook Example

This package is a runnable cookbook for the core `resultar` package. It uses the native
`resultar-check` command to type-check with TypeScript-Go and enforce Resultar rules.

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

- [`src/sync-validation.ts`](src/sync-validation.ts): field validation with `Result.validateAll`,
  tagged errors, redacted props, validation adapter issues, and HTTP-style boundary mapping.
- [`src/domain-workflow.ts`](src/domain-workflow.ts): a linear domain flow using `andThen`, `mapErr`,
  and `safeTry` with typed error unions.
- [`src/tagged-enum.ts`](src/tagged-enum.ts): lightweight tagged unions with `taggedEnum`, `$is`,
  and exhaustive `$match`.
- [`src/edge-wrapping.ts`](src/edge-wrapping.ts): `tryResult`, `tryResultAsync`, reusable throwing
  wrappers, safe promises, direct error matching, and intentional unwrapping at edges.
- [`src/recovery-and-fallbacks.ts`](src/recovery-and-fallbacks.ts): `catchTag`, `catchTags`, reasoned
  errors, `unwrapReason`, `orElse`, `firstSuccessOf`, and partial boundary matching.
- [`src/collections-and-control-flow.ts`](src/collections-and-control-flow.ts): `filterOrElse`, `as`,
  `unit`, `asyncMap`, `asyncAndThen`, `zip`, `combine`, `combineWithAllErrors`, mapped validation,
  loops, conditionals, async concurrency, observation, and disposable cleanup.
- [`src/async-resilience.ts`](src/async-resilience.ts): `ResultAsync.fromPromise`, cooperative
  `timeout`, retry policies, race variants, custom race handling, and abort detection.
- [`src/resource-cleanup.ts`](src/resource-cleanup.ts): `ResultAsync.withResource` with release
  assertions for success and failure paths.

The smoke script checks the expected `Ok` and `Err` branches so this example stays executable as the
library evolves.

## Resultar 3.6 Additions

`Result.gen` is now the canonical name for generator-based Result composition; `safeTry` remains an
exact compatibility alias, so the cookbook's existing sample keeps the same behavior and inference.

The new `ResultTask<T, E, R>` surface adds reusable lazy workflows, typed services, cooperative
abort signals, generator composition, and explicit `runExit`, `runResult`, and `runPromise`
boundaries:

```ts
import { ResultTask } from 'resultar'

const task = ResultTask.gen(function* () {
  return yield* ResultTask.tryPromise({
    try: (signal) => fetch('https://example.com/users/123', { signal }),
    catch: (cause) => new Error(`Could not load user: ${String(cause)}`),
  })
})

const result = await ResultTask.runResult(task)
```

See the [ResultTask package guide](../../packages/resultar/README.md#lazy-workflows-with-resulttask)
and the [core RFC](../../packages/resultar/RESULT-TASK-CORE-RFC.md) for the complete API and the
planned runtime phases.
