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
      release: session => closeSessionTask(session),
    }).andThen(work),
  )
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

Use `ResultTask.fromCallback<T, E>({ subscribe })` for new one-shot callback subscriptions.
`subscribe({ resolve, reject, signal })` runs afresh on each execution and may return a synchronous
unsubscribe function. Pass already-typed errors to `reject`. Cleanup finishes before task completion,
including synchronous callbacks and cancellation. Subscription/cleanup throws are defects; cleanup
failures preserve prior causes. Pass cancellation through runner options, not constructor options.
Use `acquireRelease` when release itself needs asynchronous work.

## Existing callback APIs

`ResultAsync.fromCallback` is a supported deprecated eager adapter. It takes an
options object with `subscribe({ resolve, reject, signal })`, `catch`, and optional
external `signal`, and returns `ResultAsync<T, E | AbortError>`.
Return a synchronous unsubscribe function from `subscribe`; it runs once on
completion, failure, cancellation, or synchronous subscription failure. Cleanup
throws are ignored by this compatibility API. Use a Task resource scope when cleanup
failure must remain observable. Prefer `ResultTask.fromCallback` for new subscriptions; retain this adapter for eager contracts.

Use `ResultTask.never()` after initialization to keep a scope alive until interruption. It allocates
no timer and adds no success/error/requirement types. Always arrange a signal or fiber interruption
for standalone waits. `race(never(), err(...))` waits for success; `raceFirst` returns the failure.
