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
  tagged errors (`createTaggedError`, `.is()`), redacted props (`redact`, `revealRedacted`,
  `isRedacted`), validation adapter issues (`resultar/validation`), and HTTP-style boundary mapping.
- [`src/domain-workflow.ts`](src/domain-workflow.ts): a linear domain flow using `andThen`, `mapErr`,
  `Result.gen` (sync and async), legacy `safeTry`, `findCause`, and `.matchTags()` with typed error unions.
- [`src/tagged-enum.ts`](src/tagged-enum.ts): lightweight tagged unions with `taggedEnum`, `$is`,
  and exhaustive `$match`.
- [`src/edge-wrapping.ts`](src/edge-wrapping.ts): `tryResult`, `tryResultAsync`, reusable throwing
  wrappers (`fromThrowable`, `fromThrowableAsync`), `fromCallback`, safe promises, direct error
  matching (`matchError`, `matchErrorPartial`), and intentional unwrapping (`unwrapOr`, `unwrapOrThrow`,
  `runSync`, `runPromise`) at edges.
- [`src/recovery-and-fallbacks.ts`](src/recovery-and-fallbacks.ts): `catchTag`, `catchTags`, reasoned
  errors (`catchReason`, `catchReasons`, `unwrapReason`), `orElse`, `orElseSucceed`, `firstSuccessOf`,
  and partial boundary matching (`matchTagsPartial`).
- [`src/collections-and-control-flow.ts`](src/collections-and-control-flow.ts): `filterOrElse`, `as`,
  `asVoid`, `unit`, `unitAsync`, `asyncMap`, `asyncAndThen`, `zip`, `all`, `combine`,
  `combineWithAllErrors`, mapped validation (`validateAll`), loops (`loop`, `iterate`), conditionals
  (`if`, `when`, `unless`, `whenResult`, `unlessResult`), async concurrency, `ResultTask` control flow
  and timing (`delay`, `timed`), non-deprecated observation (`inspect`, `inspectError`, `inspectBoth`),
  legacy `tap`/`tapError`, and disposable cleanup (`toDisposable`, `toAsyncDisposable`).
- [`src/functional-ergonomics.ts`](src/functional-ergonomics.ts): `pipe`, `flow`, `Result.fn`,
  `Result.gen`, `Result.fromNullishOr`, `Result.liftPredicate`, `.withProps<Props>()`,
  `ResultTask.fn`, `ResultTask.acquireDisposable`, service injection (`provideService`,
  `provideServices`, `provideServiceResolver`, `serviceTag`, `isServiceTag`, `isResultTask`), and
  `Match` (`Match.value`, `Match.type`, `Match.fn`, `Match.context`, `Match.valueTags`,
  `Match.typeTags`, `Match.tagStartsWith`, `Match.whenOr`, `Match.whenAnd`, `Match.not`,
  `Match.discriminator`, `Match.discriminatorsExhaustive`, `Match.result`, `Match.option`).
- [`src/async-resilience.ts`](src/async-resilience.ts): `ResultAsync.fromPromise`, cooperative
  `timeout`, inline retries and portable `Retry.policy` schedules (`onRetry`), race variants
  (`race`, `raceAll`, `raceFirst`, `raceWith`), and abort detection (`isAbortError`).
- [`src/task-resilience.ts`](src/task-resilience.ts): portable `Retry.policy`, scoped retry,
  bounded collections, `Semaphore.make` (`withPermit`, `withPermits`), `ensuring`, `onExit`,
  `sandbox`/`unsandbox`, `catchCause`/`inspectCause`, `Cause` diagnostics (`isCause`, `hasFails`,
  `hasDies`, `hasInterrupts`, `failures`, `defects`, `findError`, `pretty`), `yieldEvery`,
  `ResultTask.yieldNow`, custom `TaskScheduler`, `Fiber.await`/`join`/`interrupt`,
  `ResultTask.runFork`, `ResultTask.race` and `raceFirst`, direct `await task`, and `.toResultAsync()`.
- [`src/resource-cleanup.ts`](src/resource-cleanup.ts): `ResultAsync.withResource` with release
  assertions for success, failure rollback, and fallible release paths.
- [`src/application-lifecycle.ts`](src/application-lifecycle.ts): a `ResultTask.scoped` server
  lifetime (database, session, HTTP serve/drain) with boot rollback on failure, plus manual scope
  management with `ResultTask.scope()`. It is not re-exported from `src/index.ts`; it is exercised
  directly by `scripts/lifecycle-smoke.ts`.

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
