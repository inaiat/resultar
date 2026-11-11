# API semantics and feature map

For every exported value/type and public member, consult the generated
[API inventory](../../../docs/api-inventory.md). Use installed `.d.ts` declarations
for overloads and inference. The [full guide](../../../DOCUMENTATION.md#api-map)
is the maintained usage reference; this file highlights decisions that commonly
cause incorrect generated code.

## Result and ResultAsync

| Need | APIs / contract |
| --- | --- |
| Constructors | `ok`, `err`, `unit`, `Result.try`, `Result.fromThrowable`, `Result.fromNullishOr`, `Result.liftPredicate` |
| Compose | `map`, `mapErr`, `andThen`, `andThrough`, `as`, `asVoid`, `filterOrElse`, `pipe` |
| Recover | `orElse`, `orElseSucceed`, `catchTag`, `catchTags`, `catchReason`, `catchReasons`, `unwrapReason` |
| Observe | `inspect`, `inspectError`, `inspectBoth`; eager `tap` / `tapError` retain best-effort compatibility |
| Handle | `match`, `matchTags`, `matchTagsPartial`, `unwrapOr`, `unwrapOrThrow`, `isOk`, `isErr` |
| Collections | `Result.all` / `combine`, `combineWithAllErrors`, `validateAll`, `forEach`, `zip` |
| Control flow | `Result.if`, `when`, `unless`, `whenResult`, `unlessResult`, `loop`, `iterate`, `firstSuccessOf` |
| Eager bridges | `asyncMap`, `asyncAndThen`; `ResultAsync.try`, `fromPromise`, `fromSafePromise`, `okAsync`, `errAsync` |

See [Result](../../../DOCUMENTATION.md#result), [collections](../../../DOCUMENTATION.md#combining-and-iterating),
[conditionals](../../../DOCUMENTATION.md#conditional-helpers), and
[eager compatibility](../../../DOCUMENTATION.md#in-flight-resultasync--deprecated-eager-compatibility).
Static data-first and curried forms are available for many operators; use the
declared overload for the specific primitive, not a similarly named library.
`Result.firstSuccessOf` and `ResultAsync.firstSuccessOf` receive candidate **factories**,
evaluated as needed. `ResultTask.firstSuccessOf` also accepts Tasks and sync Results;
factories defer candidate construction when needed.

Modern generators return plain values; `safeTry` keeps its final-Result return.
`ResultAsync` can reject if unsafe promises/callbacks throw; `fromSafePromise`
requires a promise known not to reject. It does not make arbitrary I/O safe.
The [migration table](../../../docs/migrations/v4.md#supported-apis-and-preferred-new-code)
distinguishes active constructors from deprecated eager orchestration.
`tryResult`, `tryResultAsync`, `fromPromise`, and `fromSafePromise` remain active.

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

| Runner | Outcome |
| --- | --- |
| `task.runResult(options)` | Starts execution; returns `ResultAsync<T, E>` (including deferred scope errors). A simple `Fail` becomes `Err`; other causes reject. |
| `task.runPromise(options)` | Resolves success; rejects typed failures and unhandled causes. |
| `task.runExit(options)` | Resolves `Exit<T, E>` for success or any failure cause. |
| `task.runFork(options)` | Starts a root fiber immediately and returns its handle. |

Static forms accept the Task first. There is no `runSync`, `runResultAsync`,
instance `scoped`, or instance `forkChild`. Use `ResultTask.scoped(task)` and
`ResultTask.forkChild(task)`. `await task` does not execute a Task.

Read [task semantics](../../../DOCUMENTATION.md#lazy-tasks-and-service-requirements)
and [scopes](../../../DOCUMENTATION.md#resulttask-function-and-resource-helpers).

## Concurrency, resources, retries, and time

- `all`, `forEach`, `validateAll`, and `zip` compose collections; inspect each
  helper's concurrency options. `race(left, right)` waits for the first **success**;
  `raceFirst(left, right)` uses the first completion. Both await loser cleanup.
  Concurrent failures can retain a `Parallel` cause. Neither takes a Task array.
- `ResultTask.makeSemaphore(n)` / `Semaphore.make(n)` returns a Semaphore directly,
  not a Task. Use `withPermit`, `withPermits`, and `available`; do not `yield*` creation.
- `ResultTask.forkChild(task)` gives a supervised child. `Fiber.await(handle)`
  observes its Exit; `Fiber.join`, `interrupt`, `poll`, `addObserver` operate on handles.
  Handles have `join`, `interrupt`, `poll`, `addObserver`, and `id`, but no `await` method.
- `acquireRelease({ acquire, release })` brackets a resource. `acquireDisposable(acquireTask)`
  uses native disposal protocols. Use the scope API for additional finalizers.
- `Retry.policy({ times, delayMs, backoff, jittered, while, onRetry })`: `times` counts
  retries after the initial attempt; `backoff` is a numeric multiplier (at least 1),
  `jittered` a numeric factor (at least 0). `delayMs` may be a context callback.
  There are no `factor` / `maxDelayMs` options or string backoff modes.
- `sleep`, `delay`, `timeout`, `timed`, `now`, `memoize`, `ensuring`, and `onExit`
  cover timing and lifecycle. `Clock.live` is an object; `Clock.virtual()` creates
  a clock with `advanceBy`, `advance`, `flush`, `pending`, and `now`.
- Runners accept `clock`, `signal`, `scheduler`, `yieldEvery`, and service options
  as declared. `Scheduler.live` supplies dispatch; `yieldEvery` controls cooperative
  scheduling, not preemption of synchronous foreign work.
- `tryPromise.interruption` accepts `'wait'` (default) or `'detach'`. Detachment does
  not stop a driver operation. Finalizers are still awaited; a timeout is not a hard
  shutdown deadline. Avoid detaching work that still uses a soon-to-be-released resource.

See [concurrency](../../../DOCUMENTATION.md#structured-task-concurrency-fibers-and-semaphores),
[retry](../../../DOCUMENTATION.md#portable-retry-policies-and-resulttask-retry), and
[time](../../../DOCUMENTATION.md#task-racing-timeouts-timing-and-virtual-clock).

## Causes and observation

`Cause` represents `Fail`, `Die`, `Interrupt`, `Sequential`, or `Parallel`.
Use `isCause`, `hasFails`, `hasDies`, `hasInterrupts`, `failures`, `defects`, `findError`,
and `pretty`. There are no public `Cause.fail` / `die` constructors or `isInterrupted`.
`catchCause`, `sandbox`, `unsandbox`, `inspectCause`, and `tapCause` operate on Task
failures. Preserve cleanup failures instead of discarding them as successful shutdown.

`inspect` / `inspectError` / `inspectCause` swallow synchronous observer throws.
Task `tap` / `tapError` / `tapCause` / `tapBoth` can run Tasks and preserve their
failure semantics. Legacy Result/Async `tap` is best-effort, not a strict variant.

## Tagged errors, enums, matching, and functions

`createTaggedError(...).withProps<Props>()` generates construction, guards, and
Result/Async/Task helpers; see [tagged errors](../../../DOCUMENTATION.md#tagged-errors).
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
