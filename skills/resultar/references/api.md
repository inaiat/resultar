# API semantics and feature map

For every exported value/type and public member, consult the generated
[API inventory](../../../docs/api-inventory.md). Use installed `.d.ts` declarations
for overloads and inference. The [full guide](../../../DOCUMENTATION.md#api-map)
is the maintained usage reference; this file highlights decisions that commonly
cause incorrect generated code.

## Result and opt-in `resultar/async`

| Need                            | APIs / contract                                                                                                                                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Constructors                    | `ok`, `err`, `unit`, `Result.try`, `Result.fromThrowable`, `Result.fromNullishOr`, `Result.liftPredicate`                                                                                                                                                                                                                                   |
| Compose                         | `map`, `mapErr`, `andThen`, `as`, `asVoid`, `filterOrElse`, `pipe`                                                                                                                                                                                                                                                            |
| Recover                         | `orElse`, `orElseSucceed`, `catchTag`, `catchTags`, `catchReason`, `catchReasons`, `unwrapReason`                                                                                                                                                                                                                                           |
| Observe                         | `inspect`, `inspectError`, `inspectBoth` (`tap` / `tapError` exist only on `ResultTask`)                                                                                                                                                                                                                                                    |
| Handle                          | `match`, `matchTags`, `matchTagsPartial`, `unwrapOr`, `unwrapOrThrow`, `isOk`, `isErr`                                                                                                                                                                                                                                                      |
| Collections                     | `Result.all`, `Result.validateAll`, `Result.forEach`                                                                                                                                                                                                                                                                                        |
| Control flow                    | `Result.if`, `when`, `unless`, `whenResult`, `unlessResult`, `loop`, `iterate`, `firstSuccessOf`                                                                                                                                                                                                                                            |
| Opt-in eager (`resultar/async`) | `@deprecated` compatibility subpath: `ResultAsync`, `StrictResultAsync`, `DisposableResultAsync`, `ResultAsync.gen` / `fn`, `okAsync`, `errAsync`, `unitAsync`, `fromPromise`, `fromSafePromise`, `tryResultAsync`, `safeTry`, `asyncMap`, `asyncAndThen`, and v4 eager helpers (`fromTask`, `retry`, `withResource`, `fromCallback`, etc.) |

See [Result](../../../DOCUMENTATION.md#result), [collections](../../../DOCUMENTATION.md#combining-and-iterating),
[conditionals](../../../DOCUMENTATION.md#conditional-helpers), and
[opt-in eager compatibility](../../../DOCUMENTATION.md#opt-in-eager-compatibility-resultarasync).
Static data-first and curried forms are available for many operators; use the
declared overload for the specific primitive, not a similarly named library.
`Result.firstSuccessOf` receives candidate **factories**, evaluated as needed.
`ResultTask.firstSuccessOf` also accepts Tasks and sync Results; factories defer candidate construction when needed.

`Result.gen` / `Result.fn` are purely synchronous with plain return values. For legacy eager async
generators, use `ResultAsync.gen` / `ResultAsync.fn` from `"resultar/async"`.
`ResultAsync` can reject if unsafe promises/callbacks throw; `fromSafePromise`
requires a promise known not to reject. It does not make arbitrary I/O safe.
See the [v5 migration guide](../../../docs/migrations/v5.md) for removed core v4 aliases and `@deprecated` `resultar/async` compatibility helpers.

## Task constructors, services, and runners

`ResultTask.ok`, `err`, `sync`, `try`, `tryPromise`, `fromResult`, `fromResultAsync`,
`gen`, and `fn` build lazy work. `sync` does not turn thrown failures into typed `E`;
use `try` / `tryPromise` with a concrete error mapper for expected failures.
Task `map` is synchronous. Use `andThen` for a dependent Task.
Raw `Promise<T>` driver -> `tryPromise`; existing `ResultAsync<T, E>` or
`PromiseLike<Result<T, E>>` -> `fromResultAsync`. The latter is not an adapter for
untyped Promise success values. Do not introduce an Async wrapper solely to bridge
it back into a Task. New application methods return Tasks without `async`;
[execution boundaries](../../../DOCUMENTATION.md#promise-boundaries-and-application-contracts)
may return native Promises.

`serviceTag` / `ResultTask.service` track requirements in `R`.
`provideService`, `provideServices`, and `provideServiceResolver` supply them;
runner `services` options are another valid boundary. Do not widen `R` to `unknown`
or assert it away. `makeScope` creates a manually owned root; close it explicitly.

| Runner                      | Outcome                                                        |
| --------------------------- | -------------------------------------------------------------- |
| `task.runResult(options)`   | Starts execution; returns native `Promise<Result<T, E \| ScopeError<R>>>`. A simple `Fail` becomes `Err`; other causes reject. |
| `task.runPromise(options)`  | Resolves success; rejects typed failures and unhandled causes. |
| `task.runExit(options)`     | Resolves `Exit<T, E>` for success or any failure cause.        |
| `task.runSync(options)`     | Runs synchronous tasks and returns `Result<T, E \| ScopeError<R>>` (throws if async/defect/interrupt/composite).       |
| `task.runSyncExit(options)` | Runs synchronous tasks and returns `Exit<T, E \| ScopeError<R>>` (throws if async).                                  |
| `task.runFork(options)`     | Starts a root fiber immediately and returns its handle.        |

Static forms accept the Task first. Both static and instance forms exist for
`scoped()` (`task.scoped()` / `ResultTask.scoped(task)`), `forkChild()`
(`task.forkChild()` / `ResultTask.forkChild(task)`), `withSpan()`, `repeat()`,
`runSync()`, and `runSyncExit()`. There is no `runResultAsync`. `await task`
does not execute a Task. Use `ResultTask.suspend(factory)` to defer task construction.

Read [task semantics](../../../DOCUMENTATION.md#lazy-tasks-and-service-requirements)
and [scopes](../../../DOCUMENTATION.md#resulttask-function-and-resource-helpers).

## Concurrency, resources, retries, observability, and time

- `all`, `forEach`, `validateAll`, and `zip` compose collections; inspect each
  helper's concurrency options. `race(left, right)` / `raceAll(tasks)` wait for the
  first **success**; `raceFirst(left, right)` / `raceFirstAll(tasks)` use the first
  completion. All await loser cleanup; concurrent failures can retain a `Parallel` cause.
- `ResultTask.makeSemaphore(n)` / `Semaphore.make(n)` returns a Semaphore directly,
  not a Task. Use `withPermit`, `withPermits`, and `available`; do not `yield*` creation.
- `Ref.make(initial)` provides atomic state (`get`, `set`, `update`, `updateAndGet`,
  `getAndUpdate`, `getAndSet`, `modify`). `Deferred.make<A, E>()` provides one-shot
  async synchronization (`await`, `succeed`, `fail`, `die`, `done`, `complete`, `poll`, `isDone`).
  `Queue.bounded<A>(capacity)` and `Queue.unbounded<A>()` provide FIFO backpressure queues
  (`offer`, `offerAll`, `take`, `poll`, `takeAll`, `takeUpTo`, `shutdown`, `size`, `isShutdown`)
  with lossless shutdown draining.
- `task.forkChild()` / `ResultTask.forkChild(task)` gives a supervised child.
  `Fiber.await(handle)` / `handle.await()` observe its Exit; `Fiber.join`, `interrupt`,
  `poll`, `addObserver` operate on handles (handles expose `join`, `await`, `interrupt`,
  `poll`, `addObserver`, and `id`).
- `acquireRelease({ acquire, release })` brackets a resource. `acquireDisposable(acquireTask)`
  uses native disposal protocols. Use the scope API for additional finalizers.
- `Retry.policy({ times, delayMs, backoff, maxDelayMs, maxElapsedMs, jittered, while, onRetry })`:
  `times` counts retries after the initial attempt; `backoff` is a numeric multiplier (at least 1),
  `maxDelayMs` caps per-retry delay, `maxElapsedMs` caps total elapsed time, and `jittered`
  is a numeric factor (at least 0). `delayMs` may be a number or `(context, error) => number`.
  There are no `factor` options or string backoff modes.
- `task.repeat(options)` / `ResultTask.repeat(...)` repeats successful executions with
  `times`, `delayMs`, `backoff`, `maxDelayMs`, `maxElapsedMs`, `jittered`, `while`, `until`, and `onRepeat`.
- `TaskLocal.make(defaultValue, name?)` provides fiber-inherited ambient state (`get()`, `set(v)`,
  `update(fn)`, `locally`, `locallyWith`) isolated across child fibers.
- `Tracer.noop` (zero-overhead default) and `Tracer.memory()` (plus custom `TaskTracer`)
  enable opt-in tracing via runner `{ tracer }`, `task.withSpan(name, attributes?)`, and named
  `ResultTask.fn('spanName', body, ...pipes)`. Failure causes capture active span frames
  inspectable via `Cause.spans(cause)` and rendered in `Cause.pretty(cause)`.
- `sleep`, `delay`, `timeout`, `timed`, `now`, `memoize`, `ensuring`, and `onExit`
  cover timing and lifecycle. `Clock.live` is an object; `Clock.virtual()` creates
  a clock with `advanceBy`, `advanceToNext`, `runToCompletion`, `flush`, `pending`, and `now`.
- Runners accept `clock`, `signal`, `scheduler`, `yieldEvery`, `tracer`, and service options
  as declared. `Scheduler.live` supplies dispatch; `yieldEvery` controls cooperative
  scheduling, not preemption of synchronous foreign work.
- `tryPromise.interruption` accepts `'wait'` (default) or `'detach'`. Detachment does
  not stop a driver operation. Finalizers are still awaited; a timeout is not a hard
  shutdown deadline. Avoid detaching work that still uses a soon-to-be-released resource.

See [concurrency](../../../DOCUMENTATION.md#structured-task-concurrency-fibers-and-semaphores),
[retry](../../../DOCUMENTATION.md#portable-retry-policies-and-resulttask-retry),
[observability](../../../DOCUMENTATION.md#opt-in-observability-tasklocal-tracer-withspan-named-resulttaskfn),
and [time](../../../DOCUMENTATION.md#task-racing-timeouts-timing-and-virtual-clock).

## Causes and observation

`Cause` represents `Fail`, `Die`, `Interrupt`, `Sequential`, or `Parallel`.
Constructors: `Cause.fail`, `Cause.die`, `Cause.interrupt`, `Cause.sequential`, `Cause.parallel`.
Inspectors: `isCause`, `hasFails`, `hasDies`, `hasInterrupts`, `isInterruptedOnly`,
`failures`, `defects`, `spans`, `findError`, and `pretty`.
`catchCause`, `sandbox`, `unsandbox`, `inspectCause`, and `tapCause` operate on Task
failures. Preserve cleanup failures instead of discarding them as successful shutdown.

`inspect` / `inspectError` / `inspectCause` swallow synchronous observer throws.
Task `tap` / `tapError` / `tapCause` / `tapBoth` run Tasks and preserve their
failure semantics (`tap` / `tapError` exist only on `ResultTask`).

## Subpath exports

All library packages set `"sideEffects": false`. Focused subpaths are exported from `resultar`:
`resultar/result`, `resultar/task`, `resultar/async` (opt-in eager compat), `resultar/match`, `resultar/tagged`, `resultar/retry`, and `resultar/function`.

## Tagged errors, enums, matching, and functions

`createTaggedError(...).withProps<Props>()` generates construction, guards, and
Result/Task helpers (`.err`, `.taskErr`); pass `captureStackTrace: false` (default `true`) on
expected high-frequency domain errors to skip stack-frame capture while keeping `instanceof Error`;
see [tagged errors](../../../DOCUMENTATION.md#tagged-errors).
`taggedEnum<Members>()` takes a **member map**, while `TaggedEnum<Members>` is the
union type. Use `$is(tag, value)` and `$match(value, handlers)`.
`redact(value, label)` renders `<redacted:label>`; `isRedacted` and `revealRedacted`
are explicit inspection/access helpers, not encryption.

[Matching](../../../DOCUMENTATION.md#pattern-matching) covers `Match.value`, `type`,
`context`, `fn`, `result`, `valueTags`, `typeTags`, `when`, `whenOr`, `whenAnd`, `not`,
`tag`, `tags`, `tagsExhaustive`, `discriminator`, `discriminators`, and exhaustive
variants. Predicates include `string`, `number`, `boolean`, `bigint`, `symbol`,
`date`, `record`, `nonEmptyString`, `null`, `defined`, `any` (check declarations
for the complete list). Finalize matchers with `exhaustive`, `orElse`, or `option`.
`pipe`, `flow`, `identity`, and `constant` support functional composition.
