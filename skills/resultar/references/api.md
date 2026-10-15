# Resultar v3.7+ API Guide

Use this reference after checking the version installed by the consuming project. The local package
types and source are authoritative when they differ from this guide.

## Contents

- [Package Baseline](#package-baseline)
- [Core Types And Constructors](#core-types-and-constructors)
- [Composition And Recovery](#composition-and-recovery)
- [Tagged Errors](#tagged-errors)
- [Pattern Matching](#pattern-matching)
- [Boundary Matching](#boundary-matching)
- [Async Boundaries](#async-boundaries)
- [Async Policies](#async-policies)
- [Collections And Control Flow](#collections-and-control-flow)
- [`Result.gen` / `safeTry`](#resultgen--safetry)
- [ResultTask (Lazy Workflows)](#resulttask-lazy-workflows)
- [Observation And Cleanup](#observation-and-cleanup)

## Package Baseline

Resultar v3.7 is an ESM package targeting Node.js 24+. The repository currently uses TypeScript 7.
Do not infer consumer requirements from memory: inspect `package.json`, the lockfile, and exported
types first.

Prefer named imports and type-only imports:

```ts
import { ResultAsync, createTaggedError, ok, Result, tryResult, tryResultAsync } from "resultar";
import type { StrictResult, StrictResultAsync } from "resultar";
```

`try`, the default export, and `tryCatch` remain deprecated aliases of `tryResult`.
`tryAsync` and `tryCatchAsync` remain deprecated aliases of `tryResultAsync`. Their behavior
is unchanged; prefer named imports for new code and migrate existing calls gradually.

## Core Types And Constructors

| Need                                                | API                                               |
| --------------------------------------------------- | ------------------------------------------------- |
| Synchronous fallible value                          | `Result<T, E>`                                    |
| Asynchronous fallible value                         | `ResultAsync<T, E>`                               |
| Error-only sync channel                             | `StrictResult<T, E extends Error>`                |
| Error-only async channel                            | `StrictResultAsync<T, E extends Error>`           |
| Successful value                                    | `ok(value)` / `okAsync(value)`                    |
| Successful `undefined`                              | `unit()` / `unitAsync()`                          |
| Expected failure                                    | `err(error)` / `errAsync(error)`                  |
| Reject a missing value                              | `Result.fromNullishOr(value, onNullish)`          |
| Construct from a predicate or refinement            | `Result.liftPredicate(value, predicate, onFalse)` |
| Catch synchronous throws now                        | `tryResult(fn, toError)`                          |
| Wrap a synchronous throwing function                | `fromThrowable(fn, toError)`                      |
| Catch promise rejection or a throwing async factory | `tryResultAsync(input, toError)`                  |
| Wrap an async throwing function                     | `fromThrowableAsync(fn, toError)`                 |
| Deliberately leave Resultar at a terminal boundary  | `runSync(result)` / `runPromise(result)`          |

Use the named options form when it improves readability:

```ts
const parsed = tryResult({
  try: () => JSON.parse(input) as unknown,
  catch: (cause) => new ParsePayloadError({ cause }),
});
```

`runSync` returns the `Ok` value or throws the `Err`; `runPromise` resolves the `Ok` value or
rejects with the `Err`. Keep both at framework, bootstrap, CLI, or test boundaries.

`Result.fromNullishOr` preserves `NonNullable<T>` and accepts other falsy values.
`Result.liftPredicate` preserves the input type for boolean predicates and narrows it for
refinements. Both also accept curried callbacks for `pipe`; curried forms retain concrete
input types, including literals. Error factories receive the original input and run only
on rejection. Callback exceptions propagate; use `tryResult` to capture external throws.

## Composition And Recovery

`Result` and `ResultAsync` expose direct and curried `map`, `mapErr`, `andThen`, `orElse`,
`orElseSucceed`, `unwrapOr`, `catchTag`, `catchTags`, `catchReason`, `catchReasons`,
`unwrapReason`, `inspect`, `inspectError`, `inspectBoth`, `match`, `matchTags`,
`matchTagsPartial`, `as`, `asVoid`, and `filterOrElse`. Use `pipe(result, Result.map(f))` or
`Result.map(result, f)` for the same fluent behavior. Refinements retain success narrowing;
ResultAsync callbacks retain eager Promise semantics. Result also exposes `asyncMap` and
`asyncAndThen` for transitions into ResultAsync.

- `map` transforms an `Ok` value with an infallible function.
- `mapErr` transforms an `Err` value.
- `filterOrElse` validates or narrows an `Ok` value and introduces a typed error on failure.
- `andThen` chains fallible work. On `ResultAsync`, it accepts sync or async Resultar work.
- `asyncAndThen` bridges a synchronous `Result` into `ResultAsync`.
- `orElse` recovers the complete error channel.
- `orElseSucceed` recovers the complete error channel with a plain fallback value.
- `catchTag` recovers one tagged error.
- `catchTags` recovers selected tagged errors; unhandled variants stay in the error union.
- `catchReason` / `catchReasons` / `unwrapReason` recover or promote nested tagged `reason` fields.
- `pipe` applies named combinators without changing Result semantics.

Let each step expose its narrow error type and let composition infer the union:

```ts
type CreateUserError = InvalidEmailError | UserExistsError | SaveUserError;

const createUser = (input: CreateUserInput): StrictResultAsync<User, CreateUserError> =>
  validateEmail(input.email)
    .asyncAndThen(ensureEmailAvailable)
    .andThen((email) => saveUser({ ...input, email }));
```

Do not manually cast the final error union. A surprising inferred union is usually evidence that a
step has a broad or inaccurate signature.

## Tagged Errors

`createTaggedError` creates nominal `Error` subclasses with stable `_tag`, message-template props,
`cause`, `fingerprint`, `toJSON()`, and `.err()`, `.errAsync()`, and `.taskErr()` support.

```ts
class UserNotFoundError extends createTaggedError({
  name: "UserNotFoundError",
  message: "User $userId was not found in $source",
}) {}

const missing = UserNotFoundError.err({ userId, source: "database" });
```

- Let `$variables` in the message template define required constructor props.
- Preserve the original failure with `cause` when adapting external code.
- Keep the configured `name` equal to the class name.
- Do not override the generated constructor.
- Treat `ErrorClass.is(value)` as a nominal `instanceof`-based guard; a matching `_tag` is not
  sufficient.
- Avoid reserved template fields such as `_tag`, `name`, `message`, `messageTemplate`,
  `fingerprint`, `stack`, and `cause`.
- Use `TaggedEnum`/`taggedEnum` for lightweight tagged data that should not be an `Error`.
- Use `redact`, `isRedacted`, and `revealRedacted` when sensitive error metadata must not serialize
  or log by default.
- Use `findCause` or an instance's `findCause` to inspect a typed cause chain.
- `createTaggedError(options).withProps<Props>()` refines declared template fields and adds typed
  optional or structured metadata. Template fields remain required. Existing factory calls keep
  their inferred `string | number`
  fields. Each typed declaration creates a fresh nominal class with the same configuration,
  preserving metadata from getters and non-enumerable properties. Constructor input types are
  checked by TypeScript, without runtime validation.
  `cause` is passed as usual to the constructor and retains its `Error` or custom base type;
  omit it from `Props`.

## Pattern Matching

Check installed root exports before using the workspace `Match` addition. It supports typed pattern
matching with pipe composition and fluent methods:

Use inline `result.matchTags` for ordinary HTTP routes, capturing the native context or reply.
Use a contextual matcher when several routes share the same response mapping.

- `Match.type<Input>()` builds a reusable matcher; `Match.value(input)` evaluates cases eagerly.
- `Match.fn(selector)` preserves selector arguments. Handlers receive the narrowed value followed
  by all original arguments; this supports reusable native Hono/Fastify HTTP mappings.
- `Match.context<Input, [context: Context]>()` passes the matched input and typed context once,
  preserving optional/rest arguments in the compiled function. Fluent and pipe composition work.
- `when`, `whenOr`, `whenAnd` and `not` handle literals, predicates and nested plain-object/array
  prefix patterns. Literal comparison uses `===`.
- `tag`, partial `tags`, `tagsExhaustive`, `valueTags` and `typeTags` handle tagged unions;
  `discriminator`, `discriminators` and `discriminatorsExhaustive` support other property names.
- `exhaustive` proves full coverage; `orElse` handles the remaining input. `orElseAbsurd` throws on
  unmatched input without proving completeness.
- `Match.result` returns native `Result<Matched, Remaining>`; unmatched input is retained in Err.
  It does not consume an existing domain Result. `option` returns a plain `MatchOption` tagged value.
- `withReturnType<Output>()` constrains handler returns. Boolean predicates, `nonEmptyString`,
  safe `instanceOf`, optional handlers and widened literal variables retain unproven cases.
- Exceptions and Promises retain ordinary JavaScript behavior; matching does not run tasks or
  await handler Promises. Existing Result/ResultAsync boundary matching retains its semantics.

See `packages/resultar/README.md#pattern-matching-with-match` for guards and all operations.

## Boundary Matching

Use branch methods inside an algorithm and matching when converting the completed result:

- `isOk()` / `isErr()` narrow for direct control flow.
- `match(onOk, onErr)` handles a simple boundary.
- `matchTags(onOk, handlers)` exhaustively maps tagged errors.
- `matchTagsPartial(onOk, handlers, fallback)` handles selected tags with a deliberate fallback.
- `matchError(error, handlers)` handles an error value directly.
- `matchErrorPartial(error, handlers, fallback)` partially handles an error value.

Include an `Error` handler whenever an error union can contain an untagged `Error`. Do not invent
`partialCatchTags`; `catchTags` already supports partial recovery.

## Async Boundaries

Choose the wrapper based on ownership of the promise:

- `fromPromise(existingPromise, toError)` wraps a promise that has already been created.
- `tryResultAsync(() => createPromise(), toError)` also catches synchronous factory throws and is
  preferred when the agent controls creation.
- `fromSafePromise(promise)` is only for promises guaranteed not to reject by contract.
- `fromCallback(options)` adapts callback or subscription APIs and returns
  `ResultAsync<T, E | AbortError>`. Supply cleanup and forward cancellation where supported.
- `AbortError` and `isAbortError` identify Resultar cancellation.

Always map `unknown` causes into a specific error near the external boundary:

```ts
const loadUser = (id: string): StrictResultAsync<User, LoadUserError> =>
  tryResultAsync(
    () => client.loadUser(id),
    (cause) => new LoadUserError({ cause, id }),
  );
```

## Async Policies

Use the built-in signal-aware policies instead of hand-written `Promise.race`, timers, or retry loops:

- `ResultAsync.retry(task, options)` retries typed failures and includes `AbortError` in the error
  channel. Use `times`, `delayMs`, `jittered`, `while`, and the provided signal deliberately.
- `ResultAsync.retryOrElse(task, options)` applies a typed fallback after retry exhaustion. The
  exhausted task error is replaced by the fallback error channel.
- `Retry.policy(options)` supplies a reusable, frozen configuration snapshot to both
  `ResultAsync.retry` / `retryOrElse` and `ResultTask.retry`. It retains no execution state.
  Spread the policy to add an Async-only `signal` or `orElse`. Canonical callbacks receive
  `RetryContext`: zero-based `attempt`, `nextAttempt`, and retries available before scheduling
  (`retriesRemaining`). `while` runs only while budget remains; awaited `onRetry` is best-effort.
  In ResultTask, abort/timeout stops waiting for either hook after attempt scope closure; external
  work may continue, but late outcomes cannot schedule the observer, delay, or next attempt.
  `delayMs` accepts a number or context function, `backoff` multiplies the base delay, and numeric
  `jittered` varies it in both directions. Existing task options keep one-based retry arguments and
  boolean full jitter; existing ResultAsync options keep predicate calls at exhaustion.
- `ResultAsync.timeout(task, options)` returns the task error or the typed `onTimeout` error.
- `ResultAsync.race(left, right)` and `raceAll(tasks)` return the first `Ok`, ignoring earlier `Err`
  results. If every task fails, they return the last completed `Err`.
- `ResultAsync.raceFirst(left, right)` returns the first completed `Result`, whether `Ok` or `Err`.
- `ResultAsync.raceWith(left, right, handlers)` exposes the winner and a handle to the still-running
  task for custom cooperative policy.
- `ResultAsync.withResource({ acquire, use, release })` releases after every acquire-success path.
  Release errors are best-effort and do not enter the result channel; model cleanup in `use` when it
  must affect control flow.

Race, timeout, retry, callback, and resource helpers rely on cooperative cancellation. Pass their
`AbortSignal` into fetch, database, SDK, timer, or subscription work; aborting a wrapper cannot stop
an underlying operation that ignores the signal. ResultAsync races and timeouts abort pending
losers without waiting for their settlement or cleanup. ResultTask races and timeouts own their
children and await cleanup before completing.

## Collections And Control Flow

`Result`, `ResultAsync`, and `ResultTask` provide collection and control-flow helpers:

- `all` (and `combine` on `Result` / `ResultAsync`) preserve array/tuple/record shape and return the first error.
- `combineWithAllErrors` collects every error (`Result` / `ResultAsync`).
- `validateAll` collects all validation errors; async mapped use supports bounded `concurrency`.
- `zip` combines exactly two values.
- `firstSuccessOf` tries candidates until one succeeds and otherwise returns the final error.
- `forEach` stops at the first error; use `{ discard: true }` when successful values are irrelevant.
- `if`, `when`, `whenResult`, `unless`, `unlessResult`, `loop`, and `iterate` model Resultar-native control flow where they improve
  clarity. `when` and `unless` support direct, curried (`pipe`), and fluent (`.when(condition)` / `.unless(condition)`) calls across `Result`, `ResultAsync`, and `ResultTask`, accepting boolean or fallible (`Result` / `ResultAsync` / `ResultTask`) conditions and lazy or direct bodies.

Prefer `ResultAsync.forEach(items, mapper, { concurrency })` for bounded first-error processing and
`ResultAsync.validateAll(items, mapper, { concurrency })` for independent validation where every
error matters.

## `Result.gen` / `safeTry`

Use `Result.gen` when a linear generator is clearer than a chain:

```ts
const workflow = Result.gen(async function* () {
  const input = yield* validateInput(raw);
  const remote = yield* loadRemote(input);
  const saved = yield* saveRemote(remote);

  return saved;
});
```

Use `yield*` for `Result` and `ResultAsync`. Wrap raw promises before yielding. Avoid raw `await`,
`try/catch` inside the generator. Plain `return value` becomes `Ok(value)`; fallible steps and early
errors short-circuit via `yield*` (`return yield* err(...)` or `return yield* step()`). Returning a
`Result`, `ResultAsync`, `Promise` (in sync generators), or `ResultTask` directly from `Result.gen`
is rejected at compile time. `safeTry` remains the deprecated runtime function with its original
Result-returning signatures and behavior. `Result.safeUnwrap()` also remains callable with a
deprecation annotation; prefer `yield* result`.
An early `Err` returns without closing the suspended generator; `finally` does not run on that path.
`ResultTask.gen` closes its generator and interprets yielded cleanup before completing.
A missing return becomes `Ok(undefined)`, so annotate concrete workflow output types where required.
Native async generators await their return expressions; `Result.gen` wraps the completed iterator
value in `Ok` without inspecting or assimilating it again.

`ResultGenerator<T, E = never>` and `ResultAsyncGenerator<T, E = never>` annotate sync and async generator bodies (including reusable `yield* subGen()` helpers) for `Result.gen` and `Result.fn`; `ResultTaskGenerator<A, E = never, R = never>` and `ResultTaskYieldOf<E = never, R = never>` provide the same explicit return annotations for `ResultTask.gen` and `ResultTask.fn`.
`ResultGenOptions<YieldErr, ReturnValue, CatchErr>` and
`AsyncResultGenOptions<YieldErr, ReturnValue, CatchErr>` describe the object forms for `Result.gen`.
`Result.fn(body, ...operators)` wraps a parameterized sync or async generator function and applies
up to eight post-body pipeline operators receiving `(result, ...args)`.
`SafeTryOptions` / `SafeTryAsyncOptions` keep their final-Result constraints for existing `safeTry`
callers.

## Function Utilities

Root `pipe` supports zero through eight transforms; `flow` supports one through nine
functions and preserves the first function's arguments/receiver. Both compose synchronously.
`identity` returns the original value; `constant(value)` returns a callback capturing that value.
Use `result.match({ ok: identity, err: constant(fallback) })` for fixed boundary fallbacks.

## ResultTask (Lazy Workflows)

`ResultTask<A, E, R>` is a lazy, reusable description of work: building one starts nothing, and
each `run*` call executes it again. Never substitute `ResultAsync` (already-started) where
laziness matters.

- Build: `ok`, `err`, `fromResult`, `sync`, `try`, `tryPromise` (`try`/`tryPromise` map
  external throws into `E`; `sync` treats them as defects; `succeed` / `fail` remain deprecated aliases).
- Compose lazily: `map`, `as`, `asVoid`, `filterOrElse`, `andThen`, `orElse`, `orElseSucceed`, `unwrapOr`, `catchCause`, `sandbox`, `unsandbox`, `catchTag`, partial `catchTags`, `catchReason`, `catchReasons`, `unwrapReason` (`andThen`/`orElse`/`catchCause`/`catchTag`/`catchTags`/`catchReason`/`catchReasons` accept callbacks returning `ResultTask` or synchronous `Result`), `match`, `matchTags`, `matchTagsPartial`, `inspect`, `inspectError`, `inspectCause`, `inspectBoth`, `tap`, `tapError`, `tapCause`, `tapBoth`, `onExit`, `delay`, `timed`, `zip` (accepting `{ concurrent?: boolean }`), `makeSemaphore` / `Semaphore`, `firstSuccessOf`, `if`, `when`, `unless`, `loop`, `iterate`, `gen` with `yield*` (constrained at compile time via `ResultTaskYieldable` to `ResultTask`, `Result`, and `ServiceTag`; `Ok` unwraps, `Err` short-circuits into `E`).
- `fn(function* (args) { ... }, ...operators)` creates a lazy parameterized function, capturing arguments/
  receiver, applying up to eight post-body pipeline operators receiving `(task, ...args)`, and creating fresh generators on each execution; infer all three task channels.
- Tagged task recovery has instance/direct/curried forms. Handler errors and requirements
  join the source; unhandled tags and scope markers remain. Defects/interruptions pass through;
  composites follow `orElse`'s `ResultTaskCauseError` policy. Use `catchCause` or `sandbox` / `unsandbox` when recovering from defects (`Die`) or composite (`Sequential` / `Parallel`) causes without swallowing external interruption or pending scope release failures.
- `acquireDisposable` prefers async disposal, awaits it once in LIFO order, and treats
  disposal failures as defects while preserving sequential body/cleanup causes.
- `ensuring(finalizer)` and `onExit((exit) => finalizer)` run a cleanup task or callback unconditionally on `Success`, `Fail`, `Die`, and `Interrupt` with an uninterrupted signal, combining body and finalizer failures into `Cause.Sequential`.
- Provide services: `yield* Tag`, then `provideService` / `provideServices` /
  `provideServiceResolver` (data-first and curried); missing or incompatible providers are
  compile-time errors, never runtime surprises.
- Resources: `acquireRelease` / `acquireDisposable` + `scoped`; LIFO awaited finalizers run on every exit; deferred
  release errors live in `R` until `scoped` folds them into `E`; `orElse` recovers a release
  failure only after `scoped`.
- Boundaries: `runExit` preserves `Success`/`Fail`/`Die`/`Interrupt`/`Sequential`/`Parallel`; `runResult`
  returns one `Err` and rejects the rest (`AbortError` for interrupts, `ResultTaskCauseError`
  for composites); `runPromise` unwraps or rejects. Cancellation is cooperative: fibers belong to scopes, and race/timeout await losing child cleanup.
  `all`/`forEach` accept a concurrency limit; `validateAll` collects typed failures in input order; `ResultTask.makeSemaphore(permits)` / `Semaphore.make(permits)` shares a FIFO permit pool across tasks and fibers with `withPermit` and `withPermits`.
  Retry closes each attempt scope and uses the run clock for backoff and jitter.
- `tryPromise({ try, catch, interruption })` defaults to `'wait'`: an in-flight promise settles
  before closure. `'detach'` stops waiting after abort without stopping the underlying work.
  Late outcomes are observed but do not replace the interrupted Exit; adapters own resources
  acquired later. The callback-only overload keeps `'wait'`, and registered finalizers remain awaited.
- Fibers keep the existing `join` / `interrupt` shape. Namespace `Fiber.await(fiber)` lazily
  observes the full Exit without requesting interruption; `join` unwraps the result and `interrupt`
  requests cancellation and waits for finalizers.
- `Fiber.join(fiber, { interruption: 'detach' })` stops waiting on waiter cancellation without
  canceling the target or consuming its failure. Default `'wait'` preserves existing behavior.
  The owning scope still closes its children on exit.
- `ResultTask.runFork(task, options)` immediately starts a root run and returns `FiberHandle<A, E>`.
  Native handles from `runFork` / `forkChild` have `id`, `poll()` and `addObserver(callback)`;
  namespace `Fiber.poll` / `Fiber.addObserver` delegate the same diagnostics. Poll is `undefined`
  while running; observers and snapshots expose the full Exit after cleanup. Observers return an
  unsubscribe function, notify once, and ignore callback failures. Diagnostics do not consume failures.
- Run options accept `yieldEvery` (default 2048; positive safe integer or `Infinity` to disable)
  and `scheduler: TaskScheduler`. `Scheduler.live` uses `setImmediate`; a custom scheduler provides
  `yield(signal): PromiseLike<void>`. A dispatcher throw/rejection produces a `Die` and switches that
  fiber to `Scheduler.live`, still attempting release instructions even if the dispatcher failed
  during cleanup; release failures remain alongside it in `Cause.Sequential`.
  Nested execution shares one
  fiber budget; children get independent budgets. This schedules between instructions, not within
  a synchronous callback, and is independent of the run clock.
  `Clock.virtual().advanceBy` drains pending default scheduler yields for that clock before advancing;
  other clocks and custom scheduler queues remain independently controlled.
  An infinite runnable chain that never waits for other work prevents virtual time from advancing.

Inside both `Result.gen` and `ResultTask.gen`, return a plain success value and use `yield*` for
fallible steps or early errors; `safeTry` retains its final Result contract.
Task `succeed`, `fail`, `mapError`, `flatMap`, and `catchAll` remain deprecated spellings of `ok`, `err`, `mapErr`, `andThen`,
and `orElse`. All retain their instance/direct/curried contracts. Task matching accepts
`{ ok, err }`, `{ ok, error }`, and `{ onSuccess, onFailure }`.
`ResultTask.toResultAsync(task)` and deprecated `ResultAsync.fromTask(task)` both start a
requirement-free task immediately. `fromResultAsync` keeps an existing instance eager;
its factory form defers creation.
For lazy `ResultTask` workflows with typed services and scopes, see `packages/resultar/README.md`
(Lazy Workflows With ResultTask) and `docs/rfcs/rfc-0001-result-task-core.md`.

Use runtime `Cause.isCause`, `hasFails`, `hasDies`, `hasInterrupts`, `failures`, and `defects` to inspect the existing `Cause<E>`
tree. `Cause.findError` selects its first typed error left to right, returning
`Result<E, Cause<never>>`; when no typed failure exists, `Err` contains the original tree.
`Cause.pretty` formats every leaf in order, retaining Error stacks, circular payload handling,
and JSON redaction. Traversal is iterative; sequential and parallel structure is retained.
Use `findCause(error, ErrorClass)` for a JavaScript Error's own cause chain.

## Observation And Cleanup

On `Result` and `ResultAsync`, `inspect` / `inspectError` / `inspectBoth` (`{ ok, err }` or
`{ ok, error }`), deprecated `tap` / `tapError`, and `log` preserve the original result. Callback
throws and rejected callback Promises are ignored. Returned Resultar values are not composed; use
`andThen` or `orElse` when their failure must change control flow. Deprecation changes the
recommended spelling, not observation behavior.

`toDisposable` and `toAsyncDisposable` integrate with Node.js `using` / `await using`; their
cleanup callbacks are also best-effort. `ResultAsync.withResource` preserves its existing
best-effort release contract.

On `ResultTask`, `tap` / `tapError` / `tapCause` / `tapBoth` remain lazy effectful composition. Returned task errors and
requirements join the workflow type. Callback throws and rejected Promises become `Die`;
a returned `ResultTask.err(error)` becomes a typed failure. `inspect` / `inspectError` / `inspectCause` /
`inspectBoth` (`{ ok, err }`, `{ ok, error }`, or `{ onSuccess, onFailure }`) are the best-effort
alternative: they ignore observer failures and never execute returned tasks. `runExit` preserves
every exit; `runResult` can reject. Do not substitute best-effort ResultAsync resource release for
awaited ResultTask resource ownership.
