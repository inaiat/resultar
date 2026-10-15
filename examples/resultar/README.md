# Resultar Cookbook Example

This package is a runnable cookbook for the core `resultar` package. It uses the native
`resultar-check` command to type-check with TypeScript-Go and enforce Resultar rules.

Run it from the repository root:

```sh
pnpm run example:resultar
```

Or run the package directly:

```sh
pnpm --filter resultar-example build:deps
pnpm --filter resultar-example check
pnpm --filter resultar-example smoke
pnpm --filter resultar-example start
```

The `check` script runs `resultar-check`. The Resultar rule set is
configured in `tsconfig.json`. The `smoke` script runs both `scripts/smoke.ts` (the cookbook
branches) and `scripts/lifecycle-smoke.ts` (the `ResultTask` application-lifecycle fixture).
The `smoke` and `start` scripts build their workspace dependencies explicitly. Installation
does not build packages; run `build:deps` before a standalone `check`.

## Samples

For incremental adoption, follow the [Result-to-ResultTask guide](../../docs/gradual-adoption.md)
and use these samples in order:

1. `sync-validation.ts` and `domain-workflow.ts`: start with typed Results and composition.
2. `edge-wrapping.ts` and `async-resilience.ts`: adapt existing async work with `ResultAsync`.
3. `functional-ergonomics.ts`: build lazy task workflows, introduce service requirements, and use
   `.withProps<Props>()`, `Result.fromNullishOr`, `Result.liftPredicate`, `Result.fn`, `Result.gen`,
   and `Match` (`Match.context`, `Match.tagsExhaustive`, `Match.value`).
4. `task-resilience.ts`: add `Clock.virtual`, shared retry policies, `Semaphore`, `ensuring`,
   `sandbox`/`unsandbox`, `Cause.findError`, `yieldEvery`, and owned Fibers.
5. `application-lifecycle.ts`: extend scope ownership to resources and application shutdown.

These are independent adoption steps. Existing Result functions and ResultAsync adapters can
remain in use while a selected workflow moves to ResultTask.

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
- [`src/functional-ergonomics.ts`](src/functional-ergonomics.ts): `pipe`, `flow`, `Result.fn`,
  `Result.gen`, `Result.fromNullishOr`, `Result.liftPredicate`, `.withProps<Props>()`,
  `ResultTask.fn`, `ResultTask.acquireDisposable`, and `Match` (`Match.context`,
  `Match.tagsExhaustive`, `Match.value`).
- [`src/async-resilience.ts`](src/async-resilience.ts): `ResultAsync.fromPromise`, cooperative
  `timeout`, retry policies, race variants, custom race handling, and abort detection.
- [`src/task-resilience.ts`](src/task-resilience.ts): portable `Retry.policy`, scoped retry,
  bounded collections, `Semaphore.make` (`withPermit`), `ensuring`, `sandbox`/`unsandbox`,
  `Cause.findError`, `yieldEvery`, `Fiber.await`, `ResultTask.runFork`, timeout of a detached
  external Promise and losing-replica cleanup, all exercised with a deterministic virtual clock.
- [`src/resource-cleanup.ts`](src/resource-cleanup.ts): `ResultAsync.withResource` with release
  assertions for success and failure paths.
- [`src/application-lifecycle.ts`](src/application-lifecycle.ts): a `ResultTask.scoped` server
  lifetime (database, session, HTTP serve/drain) with boot rollback on failure. It is not
  re-exported from `src/index.ts`; it is exercised directly by `scripts/lifecycle-smoke.ts`.

The `src/index.ts` barrel re-exports every sample except `application-lifecycle.ts` and runs
them together via `runCookbook`. The smoke scripts check the expected `Ok` and `Err` branches
so this example stays executable as the library evolves.

## Next major workflows

`Result.gen` returns plain success values and uses `yield*` for fallible steps and early
errors; `safeTry` retains its Result-returning signatures. `yield*` composes both sync and async Results.
Use `ResultTask.gen` for lazy workflows with typed services, scopes and concurrency.

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
and [major adoption guide](../../docs/migrations/v4.md) for the new runtime capabilities.

## Limitations

This cookbook covers `Result`/`ResultAsync`/`ResultTask` patterns. DI lifetimes, Hono request scopes,
and HTTP client validation live in their own packages (`resultar-di`, `resultar-hono`,
`resultar-request-*`) with their own examples. Stream, STM, cache, cluster and RPC are outside its scope.
