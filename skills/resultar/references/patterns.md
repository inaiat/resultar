# Workflow patterns

Use the [compiled contract recipes](../examples/contracts.mts) for complete code.
The recipes are type-checked against public declarations and exercised without
network access by `vp run test:docs`. Examples in this file are excerpts.

## Promise inputs and application outputs

The compiled `lazyLoad` recipe accepts an external Promise driver and returns
`ResultTask<number, LoadError>` through `tryPromise`. `bridgeExistingLoad` accepts
an already-typed `ResultAsync` factory and uses `fromResultAsync`. Neither Task
factory is `async`. `runDefectInspection` is explicitly an execution boundary and
returns a native Promise. These contracts serve different roles; see the
[boundary decision table](../../../DOCUMENTATION.md#promise-boundaries-and-application-contracts).

## Typed errors and service requirements

Define domain failures with `createTaggedError(...).withProps<Props>()`, preserving
causes and using `redact` for sensitive diagnostic fields. Keep error and service
unions inferred; annotate public contracts when that clarifies their obligations.
See [errors and reasons](../../../DOCUMENTATION.md#reasoned-tagged-errors).

Compose synchronous validation directly in a Task with `yield* validate(input)`.
Read services with `yield* Tag`; either provide them on the Task or pass `services`
to the runner. The [workflow example](../examples/workflow.mts) demonstrates both
sync composition and boundary service provision.

## Repeatable retries

```ts
const policy = Retry.policy<LoadError>({
  times: 2,
  delayMs: 100,
  backoff: 2,
  jittered: 0.1,
  while: error => error.retryable,
})
const resilient = loadTask.retry(policy)
```

The initial execution plus two retries permits three attempts. For request clients,
place the request call inside `ResultTask.fromResultAsync(signal => requestJson(...))`
and forward `signal` to the transport. Reusing an already-started Async value will
not repeat the request. Decide which layer owns retries to avoid multiplying attempts.
See [retry contracts](../../../DOCUMENTATION.md#portable-retry-policies-and-resulttask-retry).

## Resource ownership and shutdown

Use `ResultTask.scoped(ResultTask.acquireRelease(...).andThen(use))` or a generator
inside `scoped`. `acquireDisposable(acquireTask)` handles native disposal. Release
runs on success, failure, and interruption, in LIFO order. Release errors remain
observable in `runExit`; silently recovering them changes the shutdown contract.

`ResultTask.makeScope()` supports an explicitly owned application root. The
[application lifecycle recipe](../../../examples/cookbook/src/application-lifecycle.ts)
shows startup, partial-startup rollback, and ordered release. A session scope is
not a database transaction: transaction begin/commit/rollback is driver-specific.

For background work, fork a supervised child with `ResultTask.forkChild(task)`
inside the owning workflow. Use `runFork` for an independently owned root and
await `Fiber.interrupt(handle).runExit()` during shutdown. Inspect interruption
with `Cause.hasInterrupts`, not an invented cause constructor or predicate.
`memoize` shares initialization; define the memoized Task at the intended ownership
boundary and account for the lifetime of any returned resource.

## Bounded concurrency and races

```ts
const semaphore = ResultTask.makeSemaphore(4)
const limited = semaphore.withPermit(loadTask)
const batch = ResultTask.forEach(ids, id => load(id), { concurrency: 4 })
```

A semaphore bounds concurrent work, not requests per second. Choose a time-based
policy separately if needed. `race(left, right)` selects the first success;
`raceFirst(left, right)` selects the first completion. Awaited loser cleanup can
extend observed completion time. Sequential fallbacks use candidate factories
with `firstSuccessOf`.

## Time and interruption

Default `tryPromise` interruption waits for the foreign Promise to settle.
Use `'detach'` only when abandoning observation is acceptable; it neither cancels
foreign work nor prevents that work from accessing released resources. Forward
the signal and use the driver's own cancellation/deadline mechanism where possible.
Finalizers remain awaited. Do not promise that `.timeout` forces bounded cleanup.

Inject `Clock.virtual()` for deterministic time tests and `Scheduler` / `yieldEvery`
when testing cooperative scheduling. Advance time only after the expected sleep is
registered, and await completion before assertions. See
[clock examples](../../../DOCUMENTATION.md#task-racing-timeouts-timing-and-virtual-clock).

## Observable failure channels

Use `runResult` when handling expected `E` and allowing defects/interruption to
reject at the application boundary. Use `runExit` when shutdown or orchestration
must distinguish `Fail`, `Die`, `Interrupt`, and composite causes. `inspectError`
logs best-effort; Task `tapError` can itself fail. Preserve that distinction in tests.
