# Application boundaries

Use the [contract recipes](../examples/contracts.mts) for complete, compiled
callback and resource examples. Framework recipes live in their
[package manuals](services.md#frameworks).

## HTTP responses

At a route boundary, run a Task and map expected errors to a response using
`Result.match`, `matchTags`, or `Match.context`. Do not call child runners within
Task generators. Decide explicitly whether defects/interruption should reject
through the framework or be inspected with `runExit`; an `Err` handler alone does
not handle all Task causes. Avoid sending sensitive error props to clients.

`noUnsafeAwait` is off by default. When a project enables its `all` mode,
bootstrap calls can use a typed adapter, a focused file override, or
`noUnsafeAwaitIgnoreCalls` with exact call paths. Preserve the framework's native
Promise contracts instead of changing them merely to satisfy an optional eager policy.

## Database session ownership

A session bracket acquires a session, runs work, then awaits its release:

```ts
const withSession = <T>(work: (session: Session) => ResultTask<T, DatabaseError>) =>
  ResultTask.scoped(
    ResultTask.acquireRelease({
      acquire: openSessionTask(),
      release: (session) => closeSessionTask(session),
    }).andThen(work),
  );
```

`Session`, `DatabaseError`, `openSessionTask`, and `closeSessionTask` are driver
adapters. This is **session management**, not a transaction. A transaction needs
explicit driver begin/commit/rollback or its transaction callback API; also preserve
the driver's retry and commit-uncertainty semantics. Model those separately.
Do not swallow release errors or use detachment as a guarantee against leaked
sessions. Foreign work can continue after detachment and race with session release.

Register ownership before composing transformations: use
`ResultTask.acquireRelease({ acquire: base, release }).map(transform)`, not
`ResultTask.acquireRelease({ acquire: base.map(transform), release })`. The latter can lose a late
resource at a cancellation checkpoint. Direct waiting acquisitions register late success before
interruption and await release. Use fresh factories for exclusive resources; replaying an eager
success in two owners releases the same resource twice. Pending foreign work may delay cancellation
forever; detached work needs its own cleanup protocol.

## Events and worker callbacks

For an SDK callback requiring `Promise<void>`, call `.runPromise()` at that callback's
boundary. Preserve typed failures if rejection drives redelivery; recover only when
the application's acknowledgement policy requires it. Use a closure or
`function* (this: Coordinator, ...) { ... }.bind(this)` for method state.
`ResultTask.gen(this, generator)` and `Result.gen(this, generator)` are not overloads.
Stop workers and await their finalizers before releasing shared services.

## Lazy callback APIs

Use `ResultTask.fromCallback<T, E>({ subscribe })` for one-shot callback subscriptions.
`subscribe({ resolve, reject, signal })` runs afresh on each execution and may return a synchronous
unsubscribe function. Pass already-typed errors to `reject`. Cleanup finishes before task completion,
including synchronous callbacks and cancellation. Subscription/cleanup throws are defects; cleanup
failures preserve prior causes. Pass cancellation through runner options, not constructor options.
Use `acquireRelease` when release itself needs asynchronous work.

Use `ResultTask.never()` after initialization to keep a scope alive until interruption. It allocates
no timer and adds no success/error/requirement types. Always arrange a signal or fiber interruption
for standalone waits. `race(never(), err(...))` waits for success; `raceFirst` returns the failure.

## Promise defect boundaries

`ResultTask.fromPromise(signal => operation(signal))` defers a raw Promise factory
until each run and returns `ResultTask<A, never, never>`. Throws and rejections
become runtime defects; `runResult()` rejects for these failures. Use
`tryPromise({ try, catch })` for expected errors and `fromResultAsync` for existing
Result-producing operations. Unlike eager `ResultAsync.fromPromise`, this factory
accepts no error mapper or already-started Promise.

Cancellation waits for settlement. Register resource ownership directly with
`acquireRelease` before composing transformations so late acquisitions are released.
The checker recognizes async factories as explicit defect boundaries for
`no-unsafe-await`; `catchCause` remains meaningful even when `E = never`.
