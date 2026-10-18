# Resultar Cookbook Example

This package is a runnable cookbook for the core `resultar` package. It uses the native
`resultar-check` command to type-check with TypeScript-Go and enforce Resultar rules.

Run it from the repository root:

```sh
pnpm run example:cookbook
```

Or run the package directly:

```sh
pnpm --filter resultar-cookbook-example build:deps
pnpm --filter resultar-cookbook-example check
pnpm --filter resultar-cookbook-example smoke
pnpm --filter resultar-cookbook-example start
```

The `check` script runs `resultar-check`. The Resultar rule set is
configured in `tsconfig.json`. The `smoke` script runs both `scripts/smoke.ts` (the cookbook
branches) and `scripts/lifecycle-smoke.ts` (the `ResultTask` application-lifecycle fixture).
The `smoke` and `start` scripts build their workspace dependencies explicitly. Installation
does not build packages; run `build:deps` before a standalone `check`.

## Samples

For incremental adoption, follow the [Result-to-ResultTask guide](../../docs/gradual-adoption.md)
and use these samples for new code:

1. `sync-validation.ts` and `domain-workflow.ts`: start with typed Results and composition.
2. `functional-ergonomics.ts`: build lazy task workflows, introduce service requirements, and use
   `.withProps<Props>()`, `Result.fromNullishOr`, `Result.liftPredicate`, `Result.fn`, `Result.gen`,
   and `Match` (`Match.context`, `Match.tagsExhaustive`, `Match.value`).
3. `task-resilience.ts`: add `Clock.virtual`, shared retry policies, `Semaphore`, `ensuring`,
   `sandbox`/`unsandbox`, `Cause.findError`, `yieldEvery`, and owned Fibers.
4. `application-lifecycle.ts`: extend scope ownership to resources and application shutdown.

These are independent adoption steps. Every asynchronous recipe uses `ResultTask`: it is lazy
and repeatable, has no `.then`, and runs through explicit runners. Synchronous recipes retain
`Result`. Native Promise boundaries use `ResultTask.runPromise`, while callers that need typed
results use `runResult`. Use `runExit` to inspect cancellation, defects and cleanup failures.
Construct promises and mutable per-run state inside the Task so repeated runs create fresh work.

- [`src/sync-validation.ts`](src/sync-validation.ts): field validation with `Result.validateAll`,
  tagged errors (`createTaggedError`, `.is()`), redacted props (`redact`, `revealRedacted`,
  `isRedacted`), validation adapter issues (`resultar/validation`), and HTTP-style boundary mapping.
- [`src/domain-workflow.ts`](src/domain-workflow.ts): a linear domain flow using `andThen`, `mapErr`,
  synchronous `Result.gen`, lazy `ResultTask.gen`, deprecated synchronous `safeTry`, `findCause`,
  and `.matchTags()` with typed error unions.
- [`src/tagged-enum.ts`](src/tagged-enum.ts): lightweight tagged unions with `taggedEnum`, `$is`,
  and exhaustive `$match`.
- [`src/edge-wrapping.ts`](src/edge-wrapping.ts): `tryResult`, `ResultTask.tryPromise`, reusable throwing
  wrappers (`fromThrowable`, task factories), callback subscriptions with cooperative cancellation
  and guaranteed cleanup, direct error
  matching (`matchError`, `matchErrorPartial`), and intentional unwrapping (`unwrapOr`, `unwrapOrThrow`,
  `runSync`, `ResultTask.runPromise`) at edges.
- [`src/recovery-and-fallbacks.ts`](src/recovery-and-fallbacks.ts): `catchTag`, `catchTags`, reasoned
  errors (`catchReason`, `catchReasons`, `unwrapReason`), `orElse`, `orElseSucceed`, `firstSuccessOf`,
  and partial boundary matching (`matchTagsPartial`).
- [`src/collections-and-control-flow.ts`](src/collections-and-control-flow.ts): `filterOrElse`, `as`,
  `asVoid`, `unit`, `ResultTask.ok`, `ResultTask.fromResult`, `andThen`, `zip`, `all`, synchronous `combine`,
  mapped validation (`validateAll`), loops (`loop`, `iterate`), conditionals
  (`if`, `when`, `unless`), async concurrency, `ResultTask` control flow
  and timing (`delay`, `timed`), non-deprecated observation (`inspect`, `inspectError`, `inspectBoth`),
  legacy synchronous `tap`/`tapError`, and disposable cleanup (`toDisposable`, `acquireDisposable`).
- [`src/functional-ergonomics.ts`](src/functional-ergonomics.ts): `pipe`, `flow`, `Result.fn`,
  `Result.gen`, `Result.fromNullishOr`, `Result.liftPredicate`, `.withProps<Props>()`,
  `ResultTask.fn`, `ResultTask.acquireDisposable`, service injection (`provideService`,
  `provideServices`, `provideServiceResolver`, `serviceTag`, `isServiceTag`, `isResultTask`), and
  `Match` (`Match.value`, `Match.type`, `Match.fn`, `Match.context`, `Match.valueTags`,
  `Match.typeTags`, `Match.tagStartsWith`, `Match.whenOr`, `Match.whenAnd`, `Match.not`,
  `Match.discriminator`, `Match.discriminatorsExhaustive`, `Match.result`, `Match.option`).
- [`src/async-resilience.ts`](src/async-resilience.ts): lazy `ResultTask.tryPromise`, cooperative
  `timeout`, portable `Retry.policy` schedules (`onRetry`), fallback recovery, composed first-success
  races, `raceFirst`, custom race policies with owned fibers, and abort detection (`isAbortError`).
- [`src/task-resilience.ts`](src/task-resilience.ts): portable `Retry.policy`, scoped retry,
  bounded collections, `Semaphore.make` (`withPermit`, `withPermits`), `ensuring`, `onExit`,
  `sandbox`/`unsandbox`, `catchCause`/`inspectCause`, `Cause` diagnostics (`isCause`, `hasFails`,
  `hasDies`, `hasInterrupts`, `failures`, `defects`, `findError`, `pretty`), `yieldEvery`,
  `ResultTask.yieldNow`, custom `TaskScheduler`, `Fiber.await`/`join`/`interrupt`,
  `ResultTask.runFork`, `ResultTask.race` and `raceFirst`, explicit task runners, and the eager
  native Promise interoperability through `ResultTask.runPromise`.
- [`src/resource-cleanup.ts`](src/resource-cleanup.ts): `ResultTask.acquireRelease` and `scoped` with release
  assertions for success, failure rollback, and fallible release paths observed through `runExit`.
- [`src/application-lifecycle.ts`](src/application-lifecycle.ts): a `ResultTask.scoped` server
  lifetime (database, session, HTTP serve/drain) with boot rollback on failure, plus manual scope
  management with `ResultTask.scope()`. It is not re-exported from `src/index.ts`; it is exercised
  directly by `scripts/lifecycle-smoke.ts`.

The `src/index.ts` barrel re-exports every sample except `application-lifecycle.ts` and runs
them together via `runCookbook`. The smoke scripts check the expected `Ok` and `Err` branches
so this example stays executable as the library evolves.

## Recommended v4 workflows

`Result.gen` returns plain success values and uses `yield*` for fallible steps and early
errors; deprecated `safeTry` retains its original Result-returning signatures as a separate helper.
Synchronous recipes use `Result.gen` and `Result.fn`. Asynchronous recipes use
`ResultTask.gen` or `ResultTask.fn`, including those with no services or resources yet.

```ts
import { ResultTask } from "resultar";

const task = ResultTask.gen(function* () {
  return yield* ResultTask.tryPromise({
    try: (signal) => fetch("https://example.com/users/123", { signal }),
    catch: (cause) => new Error(`Could not load user: ${String(cause)}`),
  });
});

const result = await ResultTask.runResult(task);
```

Task `map` is synchronous; compose another async step with `andThen` and `tryPromise`.
Task uses `ok`, `err`, `mapErr`, `andThen`, and `orElse`; retries take a `Retry.policy(...)`.
Task `match` returns a lazy Task, so either run the folded task with `runPromise` or match the
`Result` returned by `runResult`. Its object handlers use `{ ok, err }`.

See the [ResultTask package guide](../../packages/resultar/README.md#lazy-workflows-with-resulttask)
and [major adoption guide](../../docs/migrations/v4.md) for the new runtime capabilities.

## Recipe adaptations

Some eager helpers have no identically named Task equivalent:

- Callback subscriptions use `tryPromise` and owned cleanup. Cancellation is an `Interrupt`
  in `runExit`, rather than a typed callback error.
- Record aggregation uses `all`; heterogeneous validation captures typed Results with `all`
  before `Result.combineWithAllErrors` collects them. Item validation uses `validateAll`.
  Conditional tasks use `andThen` with `when` or `unless`, and batches
  that discard their values end with `asVoid`.
- A race across several providers composes `race`. Custom winner/fallback policies use scoped
  fibers. Task races await loser cleanup, and failures from all branches remain in the cause tree.
- Resource cleanup uses `acquireRelease` inside `scoped`. Release failures are preserved in the
  exit; the fallible-release sample intentionally reports failure instead of keeping a successful
  import result. Task observers use `inspect`; fallible side operations use Task `tap`.

The smoke checks cover deferred execution, repeated runs, callback cancellation and cleanup,
typed failure branches and release failures alongside the successful recipes.

## Limitations

This cookbook covers `Result`/`ResultTask` patterns. DI lifetimes, Hono request scopes,
and HTTP client validation live in their own packages (`resultar-di`, `resultar-hono`,
`resultar-request-*`) with their own examples. Stream, STM, cache, cluster and RPC are outside its scope.
