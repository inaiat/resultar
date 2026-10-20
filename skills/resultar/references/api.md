# Resultar v4 Development API Guide

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
- [Task Policies](#task-policies)
- [Eager Async Compatibility Policies](#eager-async-compatibility-policies)
- [Collections And Control Flow](#collections-and-control-flow)
- [`Result.gen` / `safeTry`](#resultgen--safetry)
- [ResultTask (Lazy Workflows)](#resulttask-lazy-workflows)
- [Observation And Cleanup](#observation-and-cleanup)

## Package Baseline

Resultar is an ESM package targeting Node.js 24+. The repository currently uses TypeScript 7.
Do not infer consumer requirements from memory: inspect `package.json`, the lockfile, and exported
types first.

Prefer named imports and type-only imports:

```ts
import { Result, ResultAsync, ResultTask, createTaggedError, ok, Retry, tryResult } from "resultar";
import type { StrictResult, StrictResultAsync } from "resultar";
```

`try`, the default export, and `tryCatch` remain deprecated aliases of `tryResult`.
`ResultAsync` and `StrictResultAsync` are the official in-flight `Result` types (`PromiseLike<Result<T, E>>`), returned by `task.runResult()` / `ResultTask.runResult(task)`.
The `resultar/async` subpath contains active in-flight constructors (`okAsync`, `errAsync`, `unitAsync`, `fromPromise`, `fromSafePromise`, `tryResultAsync`) and deprecated eager adapters/orchestration helpers alongside `ResultAsync` and `StrictResultAsync`.
It ships in the same `resultar` installation. Existing main-entry Async exports remain
available; prefer the subpath for explicit eager compatibility imports. Its `tryAsync` / `tryCatchAsync` aliases
retain `tryResultAsync` behavior.

```ts
import { ResultAsync, asyncMap, asyncAndThen, tryResultAsync } from "resultar/async";
import type { StrictResultAsync } from "resultar/async";
```

`Result.gen` / `Result.fn` support sync and async generators; their async form returns eager Async.
Deprecated `safeTry` also supports both forms, retaining its final-Result contract. The subpath
exports `gen`, `fn`, and `safeTry`, usually aliased to `genAsync`, `fnAsync`, and `safeTryAsync`
at import sites. No plugin installation is needed.

## Core Types And Constructors

| Need                                               | API                                                  |
| -------------------------------------------------- | ---------------------------------------------------- |
| Synchronous fallible value                         | `Result<T, E>`                                       |
| New asynchronous workflow                          | `ResultTask<T, E, R>`                                |
| In-flight / eager async value                      | `ResultAsync<T, E>`                                  |
| Error-only sync channel                            | `StrictResult<T, E extends Error>`                   |
| Error-only in-flight / eager async channel         | `StrictResultAsync<T, E extends Error>`              |
| Successful synchronous / lazy value                | `ok(value)` / `ResultTask.ok(value)`                 |
| Successful synchronous / lazy `undefined`          | `unit()` / `ResultTask.ok(undefined)`                |
| Expected synchronous / lazy failure                | `err(error)` / `ResultTask.err(error)`               |
| In-flight / eager constructors                     | `okAsync(value)` / `unitAsync()` / `errAsync(error)` |
| Reject a missing value                             | `Result.fromNullishOr(value, onNullish)`             |
| Construct from a predicate or refinement           | `Result.liftPredicate(value, predicate, onFalse)`    |
| Catch synchronous throws now                       | `tryResult(fn, toError)`                             |
| Wrap a synchronous throwing function               | `fromThrowable(fn, toError)`                         |
| Defer a Promise factory and catch rejection        | `ResultTask.tryPromise({ try, catch })`              |
| Wrap an in-flight Promise or catch eagerly         | `fromPromise(p, toError)` / `tryResultAsync(input, toError)` |
| Preserve a deprecated eager async function wrapper | `fromThrowableAsync(fn, toError)`                    |
| Leave a sync / Task channel at a terminal boundary | `runSync(result)` / `task.runPromise()`              |
| Unwrap an in-flight `ResultAsync` at a boundary    | `runPromise(asyncResult)` (deprecated)               |

Active in-flight constructors (`okAsync`, `unitAsync`, `errAsync`, `fromPromise`, `fromSafePromise`, `tryResultAsync`) are exported from both `resultar` and `resultar/async`; deprecated eager compatibility helpers (`fromThrowableAsync`, `fromCallback`, `tryAsync`, `tryCatchAsync`, `safeTry`, `runPromise`) are also exported from both entrypoints, while free `gen`, `fn`, `asyncMap`, and `asyncAndThen` are exported from `resultar/async` only.

Use the named options form when it improves readability:

```ts
const parsed = tryResult({
  try: () => JSON.parse(input) as unknown,
  catch: (cause) => new ParsePayloadError({ cause }),
});
```

`runSync` returns the `Ok` value or throws the `Err`. `task.runPromise()` executes a Task and
resolves its success value or rejects on failure. `runPromise` from `resultar/async` is the eager
compatibility terminal. Keep runners at framework, bootstrap, CLI, or test boundaries; Tasks need an explicit
runner even when they have no requirements.

`Result.fromNullishOr` preserves `NonNullable<T>` and accepts other falsy values.
`Result.liftPredicate` preserves the input type for boolean predicates and narrows it for
refinements. Both also accept curried callbacks for `pipe`; curried forms retain concrete
input types, including literals. Error factories receive the original input and run only
on rejection. Callback exceptions propagate; use `tryResult` to capture external throws.

## Composition And Recovery

`Result`, `ResultAsync`, and `ResultTask` expose direct and curried `map`, `mapErr`, `andThen`, `orElse`,
`orElseSucceed`, `unwrapOr`, `catchTag`, `catchTags`, `catchReason`, `catchReasons`,
`unwrapReason`, `inspect`, `inspectError`, `inspectBoth`, `match`, `matchTags`,
`matchTagsPartial`, `as`, `asVoid`, and `filterOrElse`. Use `pipe(result, Result.map(f))` or
`Result.map(result, f)` for the same fluent behavior. `ResultAsync` is the official in-flight `Result` class (`PromiseLike<Result<T, E>>`), returned by `task.runResult()` and exported from both the main entry and compatibility subpath. Result's `asyncMap` / `asyncAndThen`
methods and statics remain supported; free functions from `resultar/async` provide explicit eager imports.

- `map` transforms an `Ok` value synchronously on Result and Task; Async also awaits Promise-returning callbacks.
- `mapErr` transforms an `Err` value synchronously on Result and Task; Async also awaits Promise-returning callbacks.
- `filterOrElse` validates or narrows an `Ok` value and introduces a typed error on failure.
- `andThen` chains fallible work. Async accepts a synchronous Result or another Async; Task accepts a synchronous Result or another Task. Use core `ResultTask.fromResultAsync` or `task.runResult()` (with deprecated aliases `task.toResultAsync()` and `ResultAsync.fromTask(task)`) to bridge models.
- Free `asyncAndThen(result, callback)` and `asyncMap(result, callback)` from `resultar/async`
  bridge a synchronous Result into eager Async; both retain curried forms for `pipe`.
- `orElse` recovers the complete error channel.
- `orElseSucceed` recovers the complete error channel with a plain fallback value.
- `catchTag` recovers one tagged error.
- `catchTags` recovers selected tagged errors; unhandled variants stay in the error union.
- `catchReason` / `catchReasons` / `unwrapReason` recover or promote nested tagged `reason` fields.
- `pipe` applies named combinators without changing Result or ResultTask semantics.

Let each step expose its narrow error type and let composition infer the union:

```ts
type CreateUserError = InvalidEmailError | UserExistsError | SaveUserError;

const createUser = (input: CreateUserInput): ResultTask<User, CreateUserError> =>
  ResultTask.fromResult(validateEmail(input.email))
    .andThen(ensureEmailAvailable)
    .andThen((email) => saveUser({ ...input, email }));
```

Here the asynchronous helpers return Tasks. A deliberate transition into an eager compatibility
API uses the free helper, for example `asyncAndThen(validateEmail(email), ensureEmailAvailableAsync)`.

Do not manually cast the final error union. A surprising inferred union is usually evidence that a
step has a broad or inaccurate signature.

## Tagged Errors

`createTaggedError` creates nominal `Error` subclasses with stable `_tag`, message-template props,
`cause`, `fingerprint`, `toJSON()`, and `.err()` / `.taskErr()` / `.errAsync()` support. New eager
recipes can use `errAsync(new DomainError(props))`, importing `errAsync` from `resultar/async`.

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
  their inferred `string | number | Redacted<unknown>`
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

- `isOk()` / `isErr()` narrow a synchronous `Result` for direct control flow.
- `match(onOk, onErr)` handles a simple boundary.
- `matchTags(onOk, handlers)` exhaustively maps tagged errors.
- `matchTagsPartial(onOk, handlers, fallback)` handles selected tags with a deliberate fallback.
- `matchError(error, handlers)` handles an error value directly.
- `matchErrorPartial(error, handlers, fallback)` partially handles an error value.

On synchronous `Result`, `match`, `matchTags`, and `matchTagsPartial` return `Out`.
On `ResultAsync` instances, they are native `Promise<Out>` terminals that await handler returns.
The static/direct/curried Async forms return composable `ResultAsync<Awaited<Out>, never>` values;
static `unwrapOr` similarly returns Async while the instance method returns a Promise.
On Task, they are lazy folds returning `ResultTask<Out, never, R>`; execute the folded
Task with `folded.runPromise()` for `Out`. `unwrapOr` follows the same value / Promise /
Task distinction. Task has no `.then` method, so `await task` does not execute it.

Include an `Error` handler whenever an error union can contain an untagged `Error`. Do not invent
`partialCatchTags`; `catchTags` already supports partial recovery.

## Async Boundaries

Prefer `ResultTask.tryPromise({ try, catch })` for new asynchronous workflows. Its
factory starts on each explicit task run. For in-flight or eager `ResultAsync` contracts, the
following constructors and wrappers (exported from `resultar` and `resultar/async`) share one execution across awaits:

- `fromPromise(existingPromise, toError)` wraps a promise that has already been created.
- `tryResultAsync(() => createPromise(), toError)` also catches synchronous factory throws and is
  preferred when the caller controls creation of an in-flight `ResultAsync`.
- `fromSafePromise(promise)` is only for promises guaranteed not to reject by contract.
- `fromCallback(options)` adapts callback or subscription APIs and returns
  `ResultAsync<T, E | AbortError>`. Supply cleanup and forward cancellation where supported.
- `AbortError` and `isAbortError` identify Resultar cancellation.

Always map `unknown` causes into a specific error near the external boundary:

```ts
const loadUser = (id: string): ResultTask<User, LoadUserError> =>
  ResultTask.tryPromise({
    try: (signal) => client.loadUser(id, { signal }),
    catch: (cause) => new LoadUserError({ cause, id }),
  });
```

`ResultTask.fromResultAsync((signal) => existingAdapter(id, signal))` defers creation of an eager
Async until each Task run. The bridge accepts structural `PromiseLike<Result<A, E>>` values and
signal-aware factories, including native Promises; callers need not construct a ResultAsync instance.
Passing an existing Async captures its already-started execution.
Request-package helpers remain eager Async APIs; create them inside the factory when composing
new Task work. Prefer `task.runResult()` (or `ResultTask.runResult(task)`) to start one
requirement-free Task as an in-flight `ResultAsync`. `ResultAsync.fromTask(task)` and static/instance
`ResultTask.toResultAsync` remain supported as deprecated compatibility aliases with the same execution boundary.

## Task Policies

Prefer these lazy policies for new workflows:

- `task.retry(Retry.policy(options))` closes each attempt's scope before retrying; use `orElse`
  after retry when exhausted-failure recovery is application policy.
- `task.timeout(milliseconds, onTimeout)` interrupts its child and awaits finalizers.
- `ResultTask.race(left, right)` selects the first success and preserves all-failure causes in
  `Parallel`; `raceFirst` selects the first completed outcome. Both await loser cleanup.
- `all`, `forEach`, and `validateAll` accept a bounded `concurrency` option.
- `acquireRelease` / `acquireDisposable` + `scoped` await release and preserve cleanup failures.

The run supplies a live clock and scheduling by default. Use explicit run options for controlled
time or cooperative instruction yields. Pass the signal from `tryPromise` to the underlying client;
Task cancellation cannot preempt a synchronous callback. See the [Task details](#resulttask-lazy-workflows)
for interruption and cause semantics.

## Eager Async Compatibility Policies

While `ResultAsync` and `StrictResultAsync` are the official in-flight `Result` types, `ResultAsync` also retains the following deprecated static orchestration APIs for existing eager contracts.
Use its built-in signal-aware policies when maintaining those contracts:

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
  `jittered` varies it in both directions. Task also retains `ResultTaskRetryOptions`: its delay
  callback receives `(retry, error)`, predicates receive `(error, retry)`, retry is one-based,
  and boolean `jittered: true` samples between zero and the computed delay. Existing ResultAsync
  options keep their separate callbacks and predicate calls at exhaustion.
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
- `forEach` stops at the first error. Result and Async accept `{ discard: true }`; use
  `.asVoid()` on the returned Task when its successful array is irrelevant.
- `if`, `when`, `unless`, `loop`, and `iterate` model Resultar-native control flow where they improve
  clarity. Result and Async also retain `whenResult` / `unlessResult`.
  `when` and `unless` support direct, curried (`pipe`), and fluent calls. The conditions accept
  boolean and Result conditions; Async additionally accepts Async conditions and Task accepts
  Task conditions. Adapt between models explicitly.

Prefer `ResultTask.forEach(items, mapper, { concurrency })` for new bounded workflows and
`ResultTask.validateAll` for collecting independent validation errors. Existing eager Async
collection helpers retain their execution and concurrency contracts.

## `Result.gen` / `safeTry`

Use modern `Result.gen` for a synchronous linear Result flow:

```ts
const workflow = Result.gen(function* () {
  const input = yield* validateInput(raw);
  const normalized = yield* normalizeInput(input);

  return normalized;
});
```

`Result.gen` / `Result.fn` also accept async generators, returning eager Async. Deprecated
`safeTry` accepts both forms with final-Result returns. For new workflows with async work, prefer
`ResultTask.gen(function* () { ... })`, yielding Tasks, Results, and services. Explicit eager
generator imports are available through the subpath:

```ts
import { gen as genAsync, fn as fnAsync, safeTry as safeTryAsync } from "resultar/async";
```

`genAsync` / `fnAsync` accept synchronous and asynchronous bodies. Their async form returns eager
Async and can yield Results and Async values. Wrap raw Promises before yielding; a Task generator
uses `tryPromise` or `fromResultAsync(factory)`.

Avoid raw `await` and broad `try/catch` inside these generators. Plain `return value` becomes
`Ok(value)` in modern `Result.gen`; fallible steps and early
errors short-circuit via `yield*` (`return yield* err(...)` or `return yield* step()`). Returning a
`Result`, `ResultAsync`, `Promise` (in sync generators), or `ResultTask` directly from `Result.gen`
is rejected at compile time. Core and subpath `safeTry` retain the deprecated synchronous and
asynchronous final-Result contract, separate from modern `gen`.
`Result.safeUnwrap()` also remains callable with a
deprecation annotation; prefer `yield* result`.
An early `Err` returns without closing the suspended generator; `finally` does not run on that path.
`ResultTask.gen` closes its generator and interprets yielded cleanup before completing.
A missing return becomes `Ok(undefined)`, so annotate concrete workflow output types where required.
Native async generators await their return expressions; compatibility `genAsync` wraps the
completed iterator value in `Ok` without inspecting or assimilating it again.

Core `ResultGenerator<T, E = never>` annotates sync `Result.gen` / `Result.fn` bodies and reusable
sub-generators. `ResultTaskGenerator<A, E = never, R = never>` and `ResultTaskYieldOf<E = never, R = never>`
annotate Task generators. Core `ResultGenOptions` and `SafeTryOptions` describe the synchronous
object forms. Import `ResultAsyncGenerator`, `AsyncResultGenOptions`, and `SafeTryAsyncOptions`
from `resultar/async` for eager compatibility bodies.
`Result.fn(body, ...operators)` wraps a synchronous or asynchronous parameterized body and applies
up to eight post-body operators receiving `(result, ...args)`; compatibility `fnAsync` has the same body forms.
The two `safeTry` exports retain final-Result constraints and remain distinct from modern `gen`
functions, which wrap plain success payloads without inspecting them.

```ts
// Existing safeTry contract: the final return is already a Result.
const legacy = safeTry(function* () {
  const input = yield* validateInput(raw);
  return ok(input);
});
```

## Function Utilities

Root `pipe` supports zero through eight transforms; `flow` supports one through nine
functions and preserves the first function's arguments/receiver. Both compose synchronously.
`identity` returns the original value; `constant(value)` returns a callback capturing that value.
Use `result.match({ ok: identity, err: constant(fallback) })` for fixed boundary fallbacks.

## ResultTask (Lazy Workflows)

`ResultTask<A, E, R>` is the preferred API for new asynchronous workflows. It is a
lazy, reusable description: building one starts nothing, and each explicit `run*`
executes it again. It has no `.then` method, including when `R = never`.
`ResultAsync` is the in-flight `Result` returned by `task.runResult()` (and exported from `resultar` and `resultar/async`). For repeatable
Promise work, pass a factory to `ResultTask.tryPromise` or `fromResultAsync`; an
already-created Promise cannot be deferred or replayed.

Prefer instance runners in new recipes; static forms remain equivalent and supported:

| Instance form               | Equivalent static form                  | Boundary contract                                                                                                     |
| --------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `task.runResult(options?)`  | `ResultTask.runResult(task, options?)`  | `ResultAsync<A, E \| ScopeError<R>>`; returns a single typed failure as `Err`, rejects defects, interruption, and composite causes |
| `task.runPromise(options?)` | `ResultTask.runPromise(task, options?)` | `Promise<A>`; resolves the value or rejects any failure                                                               |
| `task.runExit(options?)`    | `ResultTask.runExit(task, options?)`    | `Promise<Exit<A, E>>`; preserves every outcome without rejection                                                      |
| `task.runFork(options?)`    | `ResultTask.runFork(task, options?)`    | Starts a root fiber immediately and returns `FiberHandle<A, E>`                                                       |

Both forms accept the same `ResultTaskRunOptions<R>` and check required services. Options include
`services`, `signal`, `clock`, `scheduler`, and `yieldEvery`. Pending scope release errors join
the runner error type (`E | ScopeError<R>` internally). Each call executes again; no runner memoizes
the result, and there is no public `task.run()` method.

```ts
const task = ResultTask.sync(() => "ready");
const first = await task.runResult();
const second = await ResultTask.runResult(task); // Same contract, separate execution
```

- Build: `ok`, `err`, `fromResult`, `sync`, `try`, `tryPromise` (`try`/`tryPromise` map
  external throws into `E`; `sync` treats them as defects).
- Compose lazily: `map`, `as`, `asVoid`, `filterOrElse`, `andThen`, `orElse`, `orElseSucceed`, `unwrapOr`, `catchCause`, `sandbox`, `unsandbox`, `catchTag`, partial `catchTags`, `catchReason`, `catchReasons`, `unwrapReason` (`andThen`/`orElse`/`catchCause`/`catchTag`/`catchTags`/`catchReason`/`catchReasons` accept callbacks returning `ResultTask` or synchronous `Result`), `match`, `matchTags`, `matchTagsPartial`, `inspect`, `inspectError`, `inspectCause`, `inspectBoth`, `tap`, `tapError`, `tapCause`, `tapBoth`, `onExit`, `delay`, `timed`, `zip` (accepting `{ concurrent?: boolean }`), `makeSemaphore` / `Semaphore`, `firstSuccessOf`, `if`, `when`, `unless`, `loop`, `iterate`, `gen` with `yield*` (constrained at compile time via `ResultTaskYieldable` to `ResultTask`, `Result`, and `ServiceTag`; `Ok` unwraps, `Err` short-circuits into `E`).
- `map` is synchronous and preserves returned values. Compose an asynchronous step with
  `andThen` and `ResultTask.tryPromise` instead of expecting `map` to await a Promise.
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
  checked at typed provider and run boundaries.
- Resources: `acquireRelease` / `acquireDisposable` + `scoped`; LIFO awaited finalizers run on every exit; deferred
  release errors live in `R` until `scoped` folds them into `E`; `orElse` recovers a release
  failure only after `scoped`.
- Boundaries: `runExit` preserves `Success`/`Fail`/`Die`/`Interrupt`/`Sequential`/`Parallel`; `runResult`
  returns `ResultAsync<A, E | ScopeError<R>>` (resolving one `Err` and rejecting the rest: `AbortError` for interrupts, `ResultTaskCauseError`
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
- `task.runFork(options)` immediately starts a root run and returns `FiberHandle<A, E>`.
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
Prefer Task's `ok`, `err`, `mapErr`, `andThen`, and `orElse`, with their
instance/direct/curried forms where applicable. Deprecated `succeed` / `fail`, `mapError`,
`flatMap`, and `catchAll` retain their contracts. Task object handlers support `{ ok, err }`,
`{ ok, error }`, and `{ onSuccess, onFailure }`; positional `match(onOk, onErr)` also remains available.
`task.runResult()` eagerly starts one requirement-free Task
execution and returns a memoized `ResultAsync`. `ResultAsync.fromTask(task)` and static/instance `ResultTask.toResultAsync`
remain supported as deprecated aliases of `runResult()`.
`ResultTask.fromResultAsync(existing)` accepts any `PromiseLike<Result<A, E>>` and observes that
execution; its signal-aware factory form creates fresh work on each Task run.
For lazy `ResultTask` workflows with typed services and scopes, see `packages/resultar/README.md`
(Lazy Workflows With ResultTask) and `docs/rfcs/rfc-0001-result-task-core.md`.

Use runtime `Cause.isCause`, `hasFails`, `hasDies`, `hasInterrupts`, `failures`, and `defects` to inspect the existing `Cause<E>`
tree. `Cause.findError` selects its first typed error left to right, returning
`Result<E, Cause<never>>`; when no typed failure exists, `Err` contains the original tree.
`Cause.pretty` formats every leaf in order, retaining Error stacks, circular payload handling,
and JSON redaction. Traversal is iterative; sequential and parallel structure is retained.
Use `findCause(error, ErrorClass)` for a JavaScript Error's own cause chain.

## Observation And Cleanup

Across `Result`, `ResultAsync`, and `ResultTask`, `inspect` / `inspectError` / `inspectBoth` and
`log` preserve the original result. Task object handlers use `{ ok, err }`; Result and Async
also accept their older object forms. Callback
throws and rejected callback Promises are ignored, and returned tasks are not executed
or composed. Deprecated `Result` and `ResultAsync` `tap` / `tapError` retain that
best-effort observation behavior.

Result `toDisposable` and Async `toAsyncDisposable` integrate with Node.js `using` / `await using`; their
cleanup callbacks are also best-effort. `ResultAsync.withResource` preserves its existing
best-effort release contract. Task has no `toAsyncDisposable`; use scoped acquisition or `ensuring`.

On `ResultTask`, `tap` / `tapError` / `tapCause` / `tapBoth` provide lazy effectful composition. Returned task errors and
requirements join the workflow type. Callback throws and rejected Promises become `Die`;
a returned `ResultTask.err(error)` or `err(error)` becomes a typed failure. `inspect` / `inspectError` / `inspectCause` /
`inspectBoth` (`{ ok, err }`) are the best-effort
alternative: they ignore observer failures and never execute returned tasks. `runExit` preserves
every exit; `runResult` can reject. Do not substitute best-effort `withResource` release for
awaited `acquireRelease` + `scoped` resource ownership.
