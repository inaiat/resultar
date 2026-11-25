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
`Result`. Native Promise boundaries use `task.runPromise()`, while callers that need typed
results use `task.runResult()`, which returns a native `Promise<Result<T, E>>`. Use `task.runExit()` to inspect
cancellation, defects and cleanup failures.
Construct promises and mutable per-run state inside the Task so repeated runs create fresh work.

- [`src/sync-validation.ts`](src/sync-validation.ts): field validation with `Result.validateAll`,
  tagged errors (`createTaggedError`, `.is()`), redacted props (`redact`, `revealRedacted`,
  `isRedacted`), untrusted payload decoding (`decodeSignupPayload`), and HTTP-style boundary mapping.
- [`src/domain-workflow.ts`](src/domain-workflow.ts): a linear domain flow using `andThen`, `mapErr`,
  synchronous `Result.gen`, lazy `ResultTask.gen`, `findCause`,
  and `.matchTags()` with typed error unions.
- [`src/tagged-enum.ts`](src/tagged-enum.ts): lightweight tagged unions with `taggedEnum`, `$is`,
  and exhaustive `$match`.
- [`src/edge-wrapping.ts`](src/edge-wrapping.ts): `tryResult`, `ResultTask.tryPromise`, reusable throwing
  wrappers (`fromThrowable`, task factories), callback subscriptions with cooperative cancellation
  and guaranteed cleanup, direct error
  matching (`matchError`, `matchErrorPartial`), and intentional unwrapping (`unwrapOr`, `unwrapOrThrow`,
  `runSync`, `task.runPromise()`) at edges.
- [`src/recovery-and-fallbacks.ts`](src/recovery-and-fallbacks.ts): `catchTag`, `catchTags`, reasoned
  errors (`catchReason`, `catchReasons`, `unwrapReason`), `orElse`, `orElseSucceed`, `firstSuccessOf`,
  and partial boundary matching (`matchTagsPartial`).
- [`src/collections-and-control-flow.ts`](src/collections-and-control-flow.ts): `filterOrElse`, `as`,
  `asVoid`, `unit`, `ResultTask.ok`, `ResultTask.fromResult`, `andThen`, `zip`, `all`, synchronous `Result.all`,
  mapped validation (`validateAll`), loops (`loop`, `iterate`), conditionals
  (`if`, `when`, `unless`), async concurrency, `ResultTask` control flow
  and timing (`delay`, `timed`), observation (`inspect`, `inspectError`, `inspectBoth`),
  Task effects with `tap`/`tapError`, and disposable cleanup (`toDisposable`, `acquireDisposable`).
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
  custom `TaskScheduler`, `Fiber.await`/`join`/`interrupt`,
  `task.runFork()`, `ResultTask.race` and `raceFirst`, explicit task runners, and
  native Promise interoperability through `task.runPromise()`.
- [`src/resource-cleanup.ts`](src/resource-cleanup.ts): `ResultTask.acquireRelease` and `scoped` with release
  assertions for success, failure rollback, and fallible release paths observed through `runExit`.
- [`src/application-lifecycle.ts`](src/application-lifecycle.ts): a `ResultTask.scoped` server
  lifetime (database, session, HTTP serve/drain) with boot rollback on failure, plus manual scope
  management with `ResultTask.makeScope()`. It is not re-exported from `src/index.ts`; it is exercised
  directly by `scripts/lifecycle-smoke.ts`.

The `src/index.ts` barrel re-exports every sample except `application-lifecycle.ts` and runs
them together via `runCookbook`. The smoke scripts check the expected `Ok` and `Err` branches
so this example stays executable as the library evolves.

## Recommended v5 workflows

Promise-returning helpers in this cookbook have explicit roles: `readConfigText`
and the transport delay stub simulate external drivers; `run*`, resource-cleanup,
and observation demos execute Tasks and return results/events to the test or CLI.
They are execution boundaries, not recommended repository/service signatures.
New reusable asynchronous application methods return `ResultTask` without `async`;
use `tryPromise` to adapt a raw driver and `fromResultAsync` only for an existing
typed Async operation. See the [boundary decision table](../../DOCUMENTATION.md#promise-boundaries-and-application-contracts).

`Result.gen` and `Result.fn` are purely synchronous with plain success returns and `yield*`
for fallible steps and early errors. Asynchronous recipes use
`ResultTask.gen` or `ResultTask.fn`, including those with no services or resources yet.

```ts
import { ResultTask } from "resultar";

const task = ResultTask.gen(function* () {
  return yield* ResultTask.tryPromise({
    try: (signal) => fetch("https://example.com/users/123", { signal }),
    catch: (cause) => new Error(`Could not load user: ${String(cause)}`),
  });
});

const result = await task.runResult();

const status = result.match(
  (response) => response.status,
  () => 503,
);
```

Task `map` is synchronous; compose another async step with `andThen` and `tryPromise`.
Task uses `ok`, `err`, `mapErr`, `andThen`, and `orElse`; retries take a `Retry.policy(...)`.
Task `match` returns a lazy Task (with `{ ok, err }` handlers), whereas `task.runResult()` starts
execution and returns a native `Promise<Result<T, E>>`, so you can `await task.runResult()` to match
on `Result`, or fold inside the lazy task and run with `runPromise`.

See the [ResultTask package guide](../../packages/resultar/README.md#lazy-workflows-with-resulttask)
and [v5 migration guide](../../docs/migrations/v5.md) for the v5 async model.

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

## Node process lifecycle

[src/node-lifecycle.ts](src/node-lifecycle.ts) composes the existing connection
recipe with a real HTTP server. Construction is lazy. The explicit
`runNodeApplication(options)` boundary installs SIGTERM/SIGINT listeners and returns
`{ done, shutdown }`; repeated shutdown requests return the same completion Promise.
`done` carries the structured `runExit` outcome, including interruption and release
failures, for the executable's logging and exit-code policy.

The server is owned before `listen`. HTTP stops accepting new work, active requests
and SSE drain for `drainMs`, then `closeAllConnections` cancels remaining HTTP work.
Upgraded connections are rejected, so this recipe does not support WebSockets.
The HTTP finalizer finishes before session and database releases. Startup failure
and cancellation clean up partial and late acquisitions; all remaining finalizers
run after a failure. Completion removes signal listeners and clears the HTTP timer.

The HTTP deadline does not bound arbitrary SDK finalizers. They remain awaited;
an uncooperative Promise can prevent completion. Forced process termination belongs
to an explicit executable/supervisor policy; neither core nor this recipe exits or
detaches cleanup.

[scripts/node-lifecycle-smoke.ts](scripts/node-lifecycle-smoke.ts) exercises serving,
SSE forced close, repeated shutdown, late connection cancellation, startup failure,
cleanup failure, listener removal and real signals in an isolated child. The normal
serving and deferred-connection compositions share only the small local boundary;
no separate lifecycle package is justified yet. Run it through the cookbook smoke.
