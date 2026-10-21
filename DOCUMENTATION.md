# Resultar Full Guide

This is the long-form Resultar guide. Use [README.md](README.md) as the project entry point and this
file when you need the complete API map, larger examples, and repository workflow notes.

The [workspace README](README.md#core-capabilities) summarizes the new features. This guide includes
their usage examples, checker configuration, editor tooling, and workspace validation details.

Resultar is a small TypeScript library for explicit error handling.

Its core primitives are `Result` (synchronous value), `ResultTask` (lazy async workflow), and
`ResultAsync` (in-flight `Result` returned by `task.runResult()`):

```ts
Result<T, E>;
ResultTask<T, E, R>;
ResultAsync<T, E>;
```

Use them when a function can fail and that failure should be visible in the type signature instead
of hidden behind `throw`, rejected promises, nullable returns, or ad hoc `T | Error` unions.

Use `Result` for synchronous domain code and prefer `ResultTask` for new asynchronous
workflows. Tasks are lazy and repeatable, with explicit runners; add service requirements
(`R`), time, retry, concurrency and resources as needed. Executing a task with `task.runResult()`
returns `ResultAsync<T, E>` — an in-flight `Result` (`PromiseLike<Result<T, E>>`) that can be
awaited directly or transformed and folded with the same methods as `Result`. In-flight constructors
(`okAsync`, `errAsync`, `unitAsync`, `tryResultAsync`, `fromPromise`, `fromSafePromise`) are active in
`resultar`; deprecated eager orchestration helpers on `ResultAsync` also remain exported from
`resultar` for gradual migration.
Adoption can happen one function or workflow at a time.

## Install

Resultar is ESM-only and targets Node.js 24+.

```sh
pnpm add resultar
```

```sh
npm install resultar
```

```ts
import { createTaggedError, err, ok } from "resultar";
import type { StrictResult } from "resultar";
```

CommonJS `require('resultar')` is not exported.

## Why Resultar?

In TypeScript, this signature says nothing about expected failure:

```ts
const parsePort = (value: string): number => {
  const port = Number(value);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid port ${value}`);
  }

  return port;
};
```

Callers have to read the implementation or hope the function name tells the truth. Resultar moves
that failure into the type:

```ts
class InvalidPortError extends createTaggedError({
  name: "InvalidPortError",
  message: "Invalid port $value",
}) {}

const parsePort = (value: string): StrictResult<number, InvalidPortError> => {
  const port = Number(value);

  return Number.isInteger(port) && port > 0 ? ok(port) : InvalidPortError.err({ value });
};
```

Now the function signature tells callers three useful facts:

```ts
StrictResult<number, InvalidPortError>;
//           ^ success value
//                   ^ expected failure
```

The result must be handled before the value can be used.

## How To Read This Guide

If you are new to Resultar, read these sections in order:

1. [Gradual adoption](docs/gradual-adoption.md): the path from `Result` to tasks, time, and Fibers.
2. [The model](#the-model)
3. [Quick start](#quick-start)
4. [Async workflows with ResultTask](#asynchronous-workflows-with-resulttask)
5. [Tagged errors](#tagged-errors) and [composing steps](#composing-steps)
6. [Handling results at boundaries](#handling-results-at-boundaries)
7. [Task concurrency](#structured-task-concurrency-fibers-and-semaphores) and [retry](#retrying-async-work)

Existing eager code has a separate [in-flight `ResultAsync` and eager compatibility reference](#in-flight-resultasync--deprecated-eager-compatibility).
Its constructors, policies, terminal Promises and callback contracts remain supported during v4.

Start with `Result<T, E>` and stop wherever the current workflow's needs are met.
Prefer `ResultTask<T, E, R>` for new async code: `E` tracks expected errors and `R` tracks
service and scope requirements. Add `Clock`, `Retry.policy` or owned Fibers as needed.
Existing eager `ResultAsync<T, E>` boundaries remain awaitable to `Result<T, E>` during
migration. Synchronous domain functions can keep returning `Result` throughout.

If you already know Result-style error handling, jump to:

- [Use case index](#use-case-index)
- [API decision guide](#api-decision-guide)
- [No-discard validation](#no-discard-validation)
- [Async concurrency mapping](#async-concurrency-mapping)
- [Coming from other styles](#coming-from-other-styles)
- [What Stays Out Of Core](#what-stays-out-of-core)
- [API map](#api-map)

## Use Case Index

| If you need to...                           | Start here                                                                                                | Main APIs                                                                                            |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Adopt one function or workflow at a time    | [Gradual adoption](docs/gradual-adoption.md)                                                              | `Result`, `ResultTask`, `Clock`, `Retry`, `Fiber`                                                    |
| Declare service dependencies                | [Lazy tasks and service requirements](#lazy-tasks-and-service-requirements)                               | `ResultTask.service`, `Service.require`, `Service`, `requires`                                       |
| Connect services to HTTP routes             | [Services in Fastify and Hono](#services-in-fastify-and-hono)                                             | `createFastifyApp`, `createHonoApp`, `InferRequestServices`                                          |
| Create success or failure values            | [Creating Results](#creating-results)                                                                     | `ok`, `err`, `unit`, `ResultTask.ok`, `ResultTask.err`, `fromNullishOr`, `liftPredicate`             |
| Model expected domain failures              | [Tagged Errors](#tagged-errors)                                                                           | `createTaggedError`, `.withProps`, `.err`, `StrictResult`                                            |
| Model lightweight tagged unions             | [Tagged Enums](#tagged-enums)                                                                             | `TaggedEnum`, `taggedEnum`                                                                           |
| Match values and reuse HTTP mappings        | [Pattern Matching](#pattern-matching)                                                                     | `Match.type`, `Match.value`, `Match.fn`, `Match.context`, `Match.tagsExhaustive`                     |
| Keep secrets out of error output            | [Redacted Error Props](#redacted-error-props)                                                             | `redact`, `isRedacted`, `revealRedacted`                                                             |
| Keep failure channels Error-only            | [Strict Results](#strict-results)                                                                         | `StrictResult`; concrete Error unions on `ResultTask`                                                |
| Wrap code that throws                       | [Wrapping Throwing Or Rejecting Code](#wrapping-throwing-or-rejecting-code)                               | `tryResult`, `fromThrowable`, `Result.fn`                                                            |
| Wrap promises or async factories            | [Wrapping Throwing Or Rejecting Code](#wrapping-throwing-or-rejecting-code)                               | `ResultTask.tryPromise`; eager compatibility: `tryResultAsync` / `fromPromise`                       |
| Transform successful values                 | [Composing Steps](#composing-steps)                                                                       | `map`, `filterOrElse`, `pipe`, `flow`; eager compatibility: `asyncMap`                               |
| Chain fallible steps                        | [Composing Steps](#composing-steps)                                                                       | `andThen`, `ResultTask.gen`; eager compatibility: `asyncAndThen`                                     |
| Recover from failures                       | [Recovering Tagged Errors Locally](#recovering-tagged-errors-locally)                                     | `orElse`, `catchTag`, `catchTags`                                                                    |
| Recover nested tagged reasons               | [Reasoned Tagged Errors](#reasoned-tagged-errors)                                                         | `catchReason`, `catchReasons`, `unwrapReason`                                                        |
| Inspect or recover runtime causes           | [Structured Task Concurrency, Fibers, And Semaphores](#structured-task-concurrency-fibers-and-semaphores) | `Cause`, `catchCause`, `sandbox`, `unsandbox`, `ensuring`, `onExit`                                  |
| Choose fallback behavior                    | [Fallbacks](#fallbacks)                                                                                   | `orElse`, `mapErr`, `unwrapOr`, `firstSuccessOf`                                                     |
| Choose the right error-catching API         | [Catching And Recovering Errors](#catching-and-recovering-errors)                                         | `tryResult`, `ResultTask.tryPromise`, `mapErr`, `orElse`, `catchTag`, `matchError`                   |
| Convert results into responses              | [Handling Results At Boundaries](#handling-results-at-boundaries)                                         | `match`, `matchTags`, `matchTagsPartial`                                                             |
| Match an error value directly               | [Handling Results At Boundaries](#handling-results-at-boundaries)                                         | `matchError`, `matchErrorPartial`                                                                    |
| Write linear result code                    | [Result Generators](#result-generators)                                                                   | `Result.gen`, `ResultTask.gen`, supported `safeTry`, `yield* result`                                 |
| Branch without throwing                     | [Conditional Helpers](#conditional-helpers)                                                               | `Result.if`, `Result.when`, `Result.unless`, `ResultTask.if`, `ResultTask.when`, `ResultTask.unless` |
| Combine many independent results            | [Combining And Iterating](#combining-and-iterating)                                                       | `all`, `combine`, `ResultTask.all`, `ResultTask.validateAll`                                         |
| Control async traversal concurrency         | [Async Concurrency Mapping](#async-concurrency-mapping)                                                   | `ResultTask.forEach`, `ResultTask.validateAll`, `{ concurrency }`                                    |
| Coordinate fibers, semaphores, and yields   | [Structured Task Concurrency, Fibers, And Semaphores](#structured-task-concurrency-fibers-and-semaphores) | `ResultTask.forkChild`, `task.runFork`, `Fiber`, `Semaphore`, `Scheduler`, `yieldEvery`               |
| Race concurrent async work                  | [Concurrent Racing And Timeouts](#concurrent-racing-and-timeouts)                                         | `ResultTask.race`, `raceFirst`, `timeout`, `Clock.virtual`                                           |
| Retry transient async work                  | [Retrying Async Work](#retrying-async-work)                                                               | `Retry.policy`, `ResultTask.retry`; eager compatibility: `ResultAsync.retry`                         |
| Pair async acquisition with cleanup         | [Resourceful Async Iterables](#resourceful-async-iterables)                                               | `ResultTask.acquireRelease`, `acquireDisposable`, `scoped`                                           |
| Loop or process collections                 | [Combining And Iterating](#combining-and-iterating)                                                       | `loop`, `iterate`, `forEach`, `ResultTask.loop`, `ResultTask.iterate`                                |
| Detect cancellation errors                  | [Concurrent Racing And Timeouts](#concurrent-racing-and-timeouts)                                         | `AbortError`, `isAbortError`                                                                         |
| Normalize validation issues                 | [Validation Error Recipes](#validation-error-recipes)                                                     | tagged validation errors with `issues`                                                               |
| Add logging or cleanup                      | [Observation And Cleanup](#observation-and-cleanup)                                                       | `inspect`, `inspectError`, `inspectBoth`, `log`, `toDisposable`, `toAsyncDisposable`                 |
| Understand callback exceptions              | [Callback Failure Semantics](#callback-failure-semantics)                                                 | transform callbacks vs observation callbacks                                                         |
| Unwrap at tests or final edges              | [Unwrapping Results](#unwrapping-results)                                                                 | `unwrapOr`, `unwrapOrThrow`, `_unsafeUnwrap`, `_unsafeUnwrapErr`                                     |
| Prevent ignored results                     | [No-Discard Validation](#no-discard-validation)                                                           | `resultar-check`                                                                                     |
| Check package exports and supported aliases | [Public Entry Point](#public-entry-point)                                                                 | named imports, `try`, `tryAsync`, default export                                                     |

## The Model

`Result<T, E>` is a synchronous fallible value:

```ts
type Result<T, E> = Ok<T> | Err<E>;
```

`ResultTask<T, E, R>` is a lazy, repeatable workflow. Use an explicit runner for each
execution, including when `R = never`; Task has no `.then` method. Providing services
or closing a required scope leaves a Task. Prefer `task.runResult()`, `task.runPromise()`,
`task.runExit()`, or `task.runFork()` in new recipes; equivalent static runners remain supported.

`ResultAsync<T, E>` (exported from `resultar`) is the in-flight `Result`
(`PromiseLike<Result<T, E>>`), returned by `task.runResult()` / `ResultTask.runResult(task)` and
async `Result` chains. Repeated awaits on the same `ResultAsync` observe the same execution, and
it shares the transformation and consumption surface of `Result`. Active in-flight constructors
(`okAsync`, `errAsync`, `unitAsync`, `fromPromise`, `fromSafePromise`, `tryResultAsync`) are exported
from `resultar`; static orchestration methods on `ResultAsync` remain deprecated for existing eager contracts.

Across these APIs:

- `Ok<T>` means the operation succeeded.
- `Err<E>` means the operation failed in an expected way.
- `T` is the success type.
- `E` is the expected error type.
- `R` is the required service/scope environment (`never` when no requirements remain).

For local code, `Result<T, E>` can use strings, enums, or small domain objects as `E`.

At synchronous application boundaries, `StrictResult<T, E extends Error>` constrains
failures to real Error instances. For new async boundaries, return `ResultTask<T, DomainError>`
with a concrete Error union; `task.runResult()` returns `StrictResultAsync<T, DomainError>`.

## Lazy tasks and service requirements

`ResultTask<T, E, R>` represents lazy work with a success type, expected errors, and required
services. `ResultTask.service<Contract>()('name')` infers the literal name without repeating it in
type arguments. The direct `ResultTask.service<Contract, 'name'>('name')` form remains supported.

```ts
import { ResultTask } from "resultar";
import { createModule, Service } from "resultar-di";

const Config = Service.require<{ greeting: string }>()("config");
class Greeting extends Service("greeting", {
  requires: { config: Config },
  make: ({ config }) => ({
    text: (name: string) => `${config.greeting}, ${name}`,
  }),
}) {}

const services = createModule().value("config", { greeting: "Hello" }).scoped(Greeting);
```

`Service` and `Service.require` are exported from `resultar-di`. With `requires`, the factory returns a
synchronous service value or a ResultTask (never a Promise); without it, `make: ResultTask.gen(...)` can use `yield* Service.require<Contract>()('name')`
inline. Both preserve lazy construction and infer dependencies. Declaring a requirement does not
register its provider. `Result` handles values and has no service lookup API.

See the [core task reference](packages/resultar/README.md#lazy-workflows-with-resulttask) and
[DI service guide](packages/di/README.md#class-services-and-explicit-requirements) for ownership,
typed failures, token identity and named provisioning. Fastify and Hono use this same DI mechanism.

Dependency-free `Service` factories can omit `requires`: `Service("cache", { make: () => new Map<string, string>() })`. A zero-argument factory may also return a `ResultTask`; its requirements and errors remain inferred. Construction stays lazy, and Promise/thenable returns are rejected.

## Function composition and parameterized tasks

These APIs are implemented in the workspace for the v4 release, published through Changesets.
Versioning and publication follow the release workflow; the examples use the current workspace API.

### Pipe and flow

Import `pipe`, `flow`, `identity`, and `constant` from the root package:

```ts
import { constant, flow, identity, ok, pipe } from "resultar";

const normalize = flow(
  (input: string) => input.trim(),
  (input) => input.toLowerCase(),
);

const id = pipe("  ADA  ", normalize); // 'ada'
const status = ok<string, Error>("Available").match({
  ok: identity,
  err: constant("Unavailable"),
}); // 'Available'
```

`pipe(value, ...transforms)` applies zero through eight transformations. Without transformations,
it returns the input itself; instance `.pipe()` also accepts that form. Each transformation receives
the previous result, and incompatible intermediate types are rejected.

`flow(first, ...transforms)` composes one through nine functions. The returned function preserves
the first function's optional/rest parameters and explicit `this`; subsequent functions receive
only the previous result. Composition is synchronous: exceptions propagate, Promises remain values,
and tasks still wait for a run boundary.

`Result` and `ResultAsync` expose direct and curried `map`, `mapErr`, `andThen`, `orElse`,
`catchTag`, `catchTags`, `inspect`, `inspectError`, `as`, `filterOrElse`, `match`, `matchTags`,
and `matchTagsPartial`. For example, `Result.map(result, f)` and `pipe(result, Result.map(f))`
delegate the same fluent semantics. `Result` also exposes `asyncMap` and `asyncAndThen` instance
methods and direct/curried statics (`Result.asyncMap(result, f)` / `Result.asyncAndThen(result, f)`).
Task `map` is synchronous; compose async steps with `andThen` and `ResultTask.tryPromise`.

### Identity and constant

`identity(value)` returns its argument unchanged, including its object reference.
`constant(value)` creates a function that returns the captured value on every call. It preserves
object identity and does not copy the value or recompute a factory. Use them for passing through
success values and supplying fixed fallbacks, as in the `match` example above.

The internal `dual` helper shares implementations of direct and curried task combinators. Function
`memoize` and `memoizeIdempotent` remain deferred pending a concrete cache contract; this is separate
from the existing task execution-sharing API.

### Parameterized generator functions (`Result.fn` and `ResultTask.fn`)

Core `Result.fn` wraps a synchronous or eager asynchronous Result generator, and `ResultTask.fn`
wraps a lazy synchronous generator describing Task steps. Both accept up to eight optional
post-body pipeline operators receiving `(current, ...args)`:

```ts
import { ResultTask } from "resultar";

const Clock = ResultTask.service<{ now(): number }>()("Clock");

const loadLabel = ResultTask.fn(
  function* (id: string) {
    const clock = yield* Clock;
    return `${id}:${clock.now()}`;
  },
  ResultTask.map((label) => label.toUpperCase()),
);

const task = loadLabel("ada").provideService(Clock, { now: () => 42 });
const first = await task.runPromise(); // 'ADA:42'
const second = await task.runPromise(); // 'ADA:42'
```

For `ResultTask.fn`, calling the wrapper captures its arguments and receiver without executing the
body; each run creates a fresh iterator and executes the body again. Success, errors, requirements,
parameters, and `this` remain inferred. Use `yield*` for tasks, services, and Results; return a plain
success value, following `Result.gen` / `ResultTask.gen` semantics. Generator exceptions in tasks
become `Die`.

The checker recognizes `Result.fn` and `ResultTask.fn` in applicable generator rules, including
`yield*`, raw `await`, nested returns, and resource acquisition without a scope (including
`ResultTask.scoped` passed as a post-body pipeline operator).

### Tagged task recovery and boundary matching

`ResultTask.catchTag` recovers one error tag. `ResultTask.catchTags` accepts a handler map and allows
partial recovery. `ResultTask.andThen`, `orElse`, `catchTag`, and `catchTags` accept callbacks
returning either a `ResultTask` or a synchronous `Result`. `ResultTask` also provides `filterOrElse`,
`matchTags`, and `matchTagsPartial` in instance, direct, and curried `pipe` forms:

```ts
import { createTaggedError, pipe, ResultTask } from "resultar";

class UserNotFound extends createTaggedError({
  name: "UserNotFound",
  message: "User $id was not found",
}) {}

class AccessDenied extends createTaggedError({
  name: "AccessDenied",
  message: "Access denied",
}) {}

const query: ResultTask<string, UserNotFound | AccessDenied> = ResultTask.err(
  new UserNotFound({ id: "missing" }),
);

const recovered = pipe(
  query,
  ResultTask.catchTags({
    UserNotFound: (error: UserNotFound) => ResultTask.ok(`guest:${error.id}`),
  }),
);

const label = await recovered.runPromise(); // 'guest:missing'
```

`recovered` retains `AccessDenied` in `E`; only the handled tag is removed. Handler errors and
requirements join the source channels, and pending scope requirements remain until closure. Each
handler receives its corresponding error type and returns a `ResultTask` or synchronous `Result`.

Both operators support instance methods, direct static calls, and curried static calls for `pipe`:
`query.catchTag('UserNotFound', handler)`, `ResultTask.catchTag(query, 'UserNotFound', handler)`,
and `ResultTask.catchTag('UserNotFound', handler)(query)`.

Handlers run only for simple `Fail` causes. `Die` and `Interrupt` pass through; composites follow
the existing `orElse` policy of `Die(ResultTaskCauseError)`, preserving the original cause tree.
A throwing handler becomes a defect.

### Native disposable resources

`ResultTask.acquireDisposable(acquireTask)` acquires a `Disposable` or `AsyncDisposable` and registers
disposal in its owning scope:

```ts
import { ResultTask } from "resultar";

const events: string[] = [];
const program = ResultTask.scoped(
  ResultTask.gen(function* () {
    const session = yield* ResultTask.acquireDisposable(
      ResultTask.sync(() => {
        events.push("open");
        return {
          label: "session",
          [Symbol.asyncDispose]: async () => {
            await Promise.resolve();
            events.push("close");
          },
        };
      }),
    );
    return session.label;
  }),
);

const label = await program.runPromise(); // 'session'
// events: ['open', 'close']
```

The helper prefers `Symbol.asyncDispose` when both protocols exist. Scope closure awaits disposal
exactly once, in reverse acquisition order, after success, failure, or interruption. Failed
acquisition registers no disposal, and cancellation does not interrupt cleanup.

Disposal throws/rejections become `Die`; body and disposal failures preserve their sequential cause
tree. The helper adds a scope requirement to `R`, like `acquireRelease`. `scoped` closes a child scope
before the next task continues.

### Execution compatibility

`ResultAsync<T, E>` represents an in-flight `Result` (`PromiseLike<Result<T, E>>`), returned by
`task.runResult()` / `ResultTask.runResult(task)` and async `Result` chains. `fromResultAsync(existing)`
reuses an already-started execution; `fromResultAsync(factory)` invokes the factory on each Task run.
The bridge is structural: it accepts `PromiseLike<Result<T, E>>` without requiring an instance of
`ResultAsync`. Static and instance `ResultTask.toResultAsync` and `ResultAsync.fromTask(task)` remain
supported as deprecated aliases of `runResult()`.

Scope-owned fibers, task `race` / `raceFirst` / `timeout`, bounded collections and
`Cause.Parallel` belong to Task. Existing Async policies retain their own Promise
and best-effort resource contracts. `Retry.policy` is shared configuration.

Task children finish before parent resources are released. Races and timeouts await losing child
cleanup, preserving cleanup failures. Retry closes each attempt scope and applies only to simple
typed failures. `Clock.live` is the default; `Clock.virtual()` can be passed in run options for
deterministic time and jitter. See the
[task resilience reference](packages/resultar/README.md#task-concurrency-and-resilience).

Promise adapters preserve their existing interruption behavior by default. `ResultTask.tryPromise`
accepts `interruption: 'wait' | 'detach'` in its options form: `'wait'` awaits in-flight completion,
whereas `'detach'` stops waiting after abort and observes late settlement without replacing the
interrupted Exit. The callback-only overload retains `'wait'`. Detachment does not stop the client;
adapters own resources acquired after detachment, while registered finalizers are still awaited.

`Fiber.await(fiber)` is a lazy observation of the child's full Exit without requesting interruption.
Use `Fiber.join` to compose its result and `Fiber.interrupt` to request cancellation and await cleanup.
Fibers keep their existing `join` / `interrupt` shape; `await` is a namespace operation.

`Fiber.join(fiber, { interruption: 'detach' })` stops waiting on waiter cancellation without
interrupting the target or consuming its failure. The default `'wait'` retains the existing
behavior. Scope ownership still applies: canceling a scope that owns the target closes that child.
`task.runFork(options)` starts an independent root execution and returns a
`FiberHandle<T, E>` immediately. Native handles from `runFork` / `forkChild` expose `id`, `poll()`
and `addObserver(callback)`, with namespace `Fiber.poll` / `Fiber.addObserver` equivalents.
Poll returns `undefined` while running; snapshots and observers expose the complete Exit only
after finalizers. Observers return an unsubscribe function and ignore callback failures.
Diagnostics do not consume owned child failures; use `join` or `await` to compose the outcome.

Return `ResultTask<T, E, R>` directly from lazy services and execute at an outer boundary:

| Instance runner             | Equivalent static runner                | Output and failure behavior                                                                                                               |
| --------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `task.runResult(options?)`  | `ResultTask.runResult(task, options?)`  | `ResultAsync<T, E>`; an in-flight `Result` where a single typed failure becomes `Err` and defects, interruption, or composite causes reject |
| `task.runPromise(options?)` | `ResultTask.runPromise(task, options?)` | `Promise<T>`; resolves success or rejects any failure                                                                                     |
| `task.runExit(options?)`    | `ResultTask.runExit(task, options?)`    | `Promise<Exit<T, E>>`; never rejects and preserves all causes as values                                                                   |
| `task.runFork(options?)`    | `ResultTask.runFork(task, options?)`    | Starts a root execution immediately and returns its `FiberHandle<T, E>`                                                                   |

Both forms accept the same `ResultTaskRunOptions<R>`, including `services`, `signal`, `clock`,
`scheduler`, and `yieldEvery`, and enforce the same service requirements. Root scope release errors
join `E` at either boundary (`E | ScopeError<R>` internally). For a Task without pending scope errors:

```ts
const task = ResultTask.ok("ready");
const first = await task.runResult();
const second = await ResultTask.runResult(task); // Equivalent form; executes again
```

Every runner call starts fresh work. Task is not thenable: `await task` returns the unexecuted Task,
and there is no public `task.run()` runner. `ResultTask.gen` / `fn` use plain success returns:
`return yield* step` executes a final step, whereas `return step` succeeds with the unexecuted task
as its value.

Prefer Task's `ok` / `err`, `mapErr`, `andThen`, and `orElse` in new code. Deprecated `succeed` /
`fail`, `mapError`, `flatMap`, and `catchAll` retain their original signatures and behavior.
Task retry accepts both `RetryPolicy` and the older retry options, whose callbacks use a
one-based retry index and boolean jitter. Matching supports `{ ok, err }`, `{ ok, error }`,
`{ onSuccess, onFailure }`, and positional handlers; prefer the first shape in new recipes.

Long task instruction chains yield every 2048 instructions using `Scheduler.live`. Run options
`yieldEvery` and `scheduler` configure this policy; `yieldEvery` is a positive safe integer or
`Infinity` to disable automatic yields. `TaskScheduler.yield(signal)` returns `PromiseLike<void>`;
hook failures become defects. Nested generators/scopes share the fiber budget, while children
receive independent budgets. This does not preempt synchronous callbacks or replace the clock.

`Retry.policy(options)` creates a frozen, reusable retry configuration for ResultAsync and
ResultTask. It retains no attempt state and gives both models zero-based `RetryContext` callbacks.
`times` counts retries after the initial attempt; portable `while` runs only with budget remaining,
and `onRetry` is awaited but best-effort. Spread a policy to add an Async-only `signal` or `orElse`.
Existing retry numbers/options preserve their original callback and jitter contracts. See
[portable retry policies](packages/resultar/README.md#portable-retry-policies) for field semantics.

See the [core reference](packages/resultar/README.md#parameterized-tasks-and-tagged-recovery)
and the runnable [ergonomics example](examples/cookbook/src/functional-ergonomics.ts), which combines
functions, tagged recovery, services, disposal, and repeated execution. Run it with
`pnpm run example:cookbook`. Design history is in [RFC 0004](docs/rfcs/rfc-0004-effect-v4-ergonomics-and-tooling.md).

## Services in Fastify and Hono

Both adapters use the same DI module. `resultar-di` has one entry point for class/token
registration, named factories and framework adapter helpers. Replace imports from the removed
`resultar-di/advanced` subpath with `resultar-di` when migrating.

Application code can import `createModule`, `Service`, `service` and `resource` directly from
`resultar-fastify` or `resultar-hono`. Core operators and result types still come from `resultar`.
Framework adapter helpers such as `withProvider` and `useServiceAccess` come from `resultar-di`.

The runnable [Fastify](examples/fastify/README.md) and [Hono](examples/hono/README.md) examples
have matching, self-contained layouts:

| File          | Responsibility                                                                       |
| ------------- | ------------------------------------------------------------------------------------ |
| `services.ts` | `Cache`, `UsersRepository`, `Users`, function-based `Health` and `createServices()`  |
| `routes.ts`   | Native route handlers, input/response schemas where used, and explicit error mapping |
| `main.ts`     | `createApplication()`, optional `bindings`, inferred route types and server startup  |

`Users` declares `requires: { repository: UsersRepository }`. The repository declares
`requires: { cache: Cache }`. These existing examples retain eager `StrictResultAsync`
methods and `Result.gen` to compose repository results; they demonstrate compatibility,
not the preferred return type for new async code. A new service can return `ResultTask` and
adapt an existing repository with `ResultTask.fromResultAsync(signal => repository.load(signal))`. The cache and repository are singletons; users and health are scoped.
Declaring `requires` does not register a provider: `createServices` registers each service explicitly.

Both applications omit `bindings`, so the cache, repository, users and health services are
available in the request view. Pass `bindings: ["health", "users"]` to expose only those two,
or `bindings: []` to select none. All selected services are resolved before the handler;
omission does not mean property-based lazy resolution. Fastify infers the declaration in `main.ts`:

```ts
declare module "fastify" {
  interface FastifyRequest {
    services: InferRequestServices<typeof createApplication>;
  }
}
```

Hono exports a router type from `main.ts`:

```ts
export type AppHono = Hono<{
  Bindings: InferRequestServices<typeof createApplication>;
}>;
```

Hono route files use `import type { AppHono } from "./main.ts"`. Import `InferRequestServices`
from the corresponding adapter, and `Hono` as a type from `hono`. The types follow the module automatically, or the explicit `bindings` selection when supplied. Fastify handlers read `request.services`; `createHonoApp` handlers read `c.env`.
For an existing Hono router, `createHonoServices` middleware instead infers `c.var.services` per route.

Run `pnpm dev` inside either example directory. Both use `PORT` (default 3000); the
`import.meta.main` guard allows tests to import the factory without starting the server.
The examples use an in-memory repository; see the package guides for owned resources and shutdown.
Both native adapters also accept an optional `startup: ResultTask<void, E, R>`. Its `R` requirements
are checked against the service module. Fastify runs it once in `onReady` after plugin loading and
also accepts `(app: FastifyInstance) => ResultTask<void, E, R>`. Hono runs it on `ready()` or before
the first request. Resources acquired by startup live until application close and release before
their singleton dependencies. Failure rolls back the root and preserves cleanup causes. This is
suitable for schema validation, indexes and idempotent seeds.

## Creating Results

Use Result constructors for outcomes already computed synchronously, and Task constructors
for steps in a new lazy workflow:

```ts
import { err, ok, Result, ResultTask, unit } from "resultar";

const syncValue = ok<number, Error>(1);
const syncError = err<number, Error>(new Error("failed"));
const syncUnit = unit<Error>();

const successTask = ResultTask.ok<number, Error>(1);
const failureTask = ResultTask.err(new Error("failed"));
const completedTask = ResultTask.ok(undefined);
const existingResultTask = ResultTask.fromResult(syncValue);

const result = await successTask.runResult();
```

`unit()` is `Ok(undefined)`. Use `ResultTask.ok(undefined)` for the corresponding Task.
`Result.ok` / `Result.err` expose the synchronous namespace constructors. Creating or
composing a Task starts no work; each explicit run executes it again.

### In-flight `ResultAsync` constructors

The following active helpers construct an in-flight `ResultAsync` (`PromiseLike<Result<T, E>>`) and preserve one execution across awaits:

```ts
import { errAsync, okAsync, ResultAsync, unitAsync } from "resultar";

const asyncValue = okAsync<number, Error>(1);
const asyncError = errAsync<number, Error>(new Error("failed"));
const asyncUnit = unitAsync<Error>();
const sameConstructor = ResultAsync.okAsync<number, Error>(1);
const result = await asyncValue;
```

Async is PromiseLike and works with Promise combinators. Task is not thenable:
`Promise.all([task])` and `await task` leave the Task unexecuted. Prefer
`ResultTask.all(tasks)` followed by an explicit runner for new grouped work.

## Strict Results

`StrictResult<T, E extends Error>` and `StrictResultAsync<T, E extends Error>` are type-only
aliases for synchronous and in-flight Error-only failure channels. New async workflow definitions
use `ResultTask<T, E>` with concrete domain errors, and `task.runResult()` returns
`StrictResultAsync<T, E>`.

```ts
import { createTaggedError, err, ok, ResultTask } from "resultar";
import type { StrictResult } from "resultar";

class DomainError extends createTaggedError({
  name: "DomainError",
  message: "Domain failure $code",
}) {}

class InfrastructureError extends Error {}

const syncSuccess: StrictResult<number, DomainError> = ok(123);
const syncFailure: StrictResult<number, DomainError> = DomainError.err({ code: "invalid" });
const infrastructureFailure: StrictResult<number, InfrastructureError> = err(
  new InfrastructureError("database unavailable"),
);

const asyncSuccess: ResultTask<number, DomainError> = ResultTask.ok(123);
const asyncFailure: ResultTask<number, DomainError> = DomainError.taskErr({ code: "invalid" });
```

Use plain `Result<T, E>` for narrow local flows that intentionally use strings, enums, or lightweight
objects as errors. Use `StrictResult` when a failure crosses an application, service, HTTP, job, or
integration boundary.

```ts
// Local-only style.
type ParseError = "InvalidJson";

// Boundary style.
type SaveUserResult = StrictResult<User, DomainError | InfrastructureError>;
```

## Quick Start

```ts
import { createTaggedError, ok } from "resultar";
import type { StrictResult } from "resultar";

class InvalidEmailError extends createTaggedError({
  name: "InvalidEmailError",
  message: "Invalid email $email",
}) {}

const validateEmail = (email: string): StrictResult<string, InvalidEmailError> =>
  email.includes("@") ? ok(email) : InvalidEmailError.err({ email });

const message = validateEmail("person@example.com").match(
  (email) => `Valid email: ${email}`,
  (error) => error.message,
);
```

`match` is usually the simplest way to leave Resultar code at an edge. Inside business logic, prefer
composition with `map`, `andThen`, `orElse`, `catchTag`, and `catchTags`. Use Task for
new asynchronous steps; `asyncAndThen` retains the eager Async bridge for existing code.

## Result

Use `Result<T, E>` for synchronous work.

```ts
import { createTaggedError, ok } from "resultar";
import type { StrictResult } from "resultar";

type User = {
  readonly email: string;
};

class InvalidEmailError extends createTaggedError({
  name: "InvalidEmailError",
  message: "Invalid email $email",
}) {}

const validateEmail = (email: string): StrictResult<string, InvalidEmailError> =>
  email.includes("@") ? ok(email) : InvalidEmailError.err({ email });

const createUser = (email: string): StrictResult<User, InvalidEmailError> =>
  validateEmail(email).map((validEmail) => ({ email: validEmail }));
```

When you need explicit narrowing, use `isOk()` and `isErr()`:

```ts
const result = createUser("person@example.com");

if (result.isOk()) {
  result.value.email;
}

if (result.isErr()) {
  result.error.message;
}
```

### Constructing from nullable or guarded values

`Result.fromNullishOr(value, onNullish)` returns `Result<NonNullable<T>, E>`. Only `null` and
`undefined` invoke `onNullish`; other falsy values remain successful. The callback receives the
original input. Its curried form works in a pipeline:

```ts
import { Result, pipe } from "resultar";

const required = Result.fromNullishOr(() => "missing" as const);
const count = pipe(0, required); // Ok(0)
const absent = required(undefined); // Err('missing')

const isString = (value: unknown): value is string => typeof value === "string";
const input: unknown = "Ada";
const text = Result.liftPredicate(input, isString, () => "not-text" as const);
// Result<string, 'not-text'>

const positive = Result.liftPredicate(
  (value: number) => value > 0,
  () => "not-positive" as const,
);
const checked = pipe(2, positive); // Ok(2)
```

`liftPredicate` runs a synchronous predicate once and invokes its error callback only when the
input is rejected. Refinements narrow success; boolean predicates retain the input type.
Both constructors have direct and curried forms, preserve concrete errors and curried input
types, and propagate callback exceptions. Use `tryResult` to capture uncontrolled throws.

## Asynchronous Workflows With ResultTask

Use `ResultTask.tryPromise` at a new Promise boundary. Its factory is called on each run,
so retries and repeated executions create fresh work. Synchronous factory throws and Promise
rejections become the typed error returned by `catch`:

```ts
import { createTaggedError, ResultTask } from "resultar";

class LoadProfileError extends createTaggedError({
  name: "LoadProfileError",
  message: "Could not load profile $id",
}) {}

const loadProfile = (id: string) =>
  ResultTask.tryPromise({
    try: (signal) => fetch(`/profiles/${id}`, { signal }).then((response) => response.text()),
    catch: (cause) => new LoadProfileError({ id, cause }),
  });

const responseTask = loadProfile("usr_123").match({
  ok: (profile) => ({ status: 200, body: profile }),
  err: (error) => ({ status: 503, body: error.message }),
});

const response = await responseTask.runPromise();
```

`map` and `mapErr` are synchronous transformations. Use `andThen` with another Task,
or `yield*` inside `ResultTask.gen(function* () { ... })`, for asynchronous work.
Task `match` is a lazy fold; `runPromise` above unwraps its output. Use `runResult`
for an in-flight `ResultAsync<T, E>` (which can be awaited or chained with `.match(...)`),
or `runExit` to inspect all causes as values. Task has no `.then` method, including when `R = never`.

### Adapt request helpers and existing Async operations

`resultar-request`, its schema adapters and async `Result.gen` return eager
`ResultAsync`. Keep those contracts and use a factory bridge for new Task composition:

```ts
import { ResultTask } from "resultar";
import { requestJson } from "resultar-request";

const loadUser = (id: string) =>
  ResultTask.fromResultAsync((signal) =>
    requestJson({
      request: () => fetch(`/users/${id}`, { signal }),
      validator: (value): value is { readonly id: string } =>
        typeof value === "object" &&
        value !== null &&
        "id" in value &&
        typeof value.id === "string",
    }),
  );

const result = await loadUser("usr_123").runResult();
```

`fromResultAsync(existing)` instead captures one already-started execution and reuses
it on every Task run. `task.runResult()` starts a requirement-free Task execution and returns
`ResultAsync` (`ResultAsync.fromTask(task)` and `task.toResultAsync()` remain deprecated aliases).

<a id="resultasync"></a>
<a id="deprecated-resultasync-compatibility"></a>
<a id="in-flight-resultasync--deprecated-eager-compatibility"></a>

## In-Flight `ResultAsync` & Deprecated Eager Compatibility

`ResultAsync<T, E>` (and `StrictResultAsync<T, E>`) is the official in-flight `Result`
(`PromiseLike<Result<T, E>>`), returned by `task.runResult()` / `ResultTask.runResult(task)` and
async `Result` chains. Active in-flight constructors (`okAsync`, `errAsync`, `unitAsync`, `fromPromise`, `fromSafePromise`, `tryResultAsync`) are exported from `resultar`, while static orchestration methods on `ResultAsync` remain deprecated for existing eager contracts. Prefer `ResultTask<T, E, R>` for new asynchronous
workflows and execute it explicitly. Install `resultar` once:

```sh
pnpm add resultar
```

```ts
import { createTaggedError, fromPromise, ok, tryResultAsync } from "resultar";
import type { StrictResult, StrictResultAsync } from "resultar";

type User = {
  readonly id: string;
};

class FetchUserError extends createTaggedError({
  name: "FetchUserError",
  message: "Failed to fetch user $id",
}) {}

class UserResponseError extends createTaggedError({
  name: "UserResponseError",
  message: "User request $id failed with status $status",
}) {}

class ParseUserError extends createTaggedError({
  name: "ParseUserError",
  message: "Failed to parse user $id response",
}) {}

class DecodeUserError extends createTaggedError({
  name: "DecodeUserError",
  message: "Invalid user $id response payload",
}) {}

const decodeUser = (input: unknown, id: string): StrictResult<User, DecodeUserError> => {
  if (
    typeof input === "object" &&
    input !== null &&
    "id" in input &&
    typeof input.id === "string"
  ) {
    return ok({ id: input.id });
  }

  return DecodeUserError.err({ id });
};

const fetchUser = (
  id: string,
): StrictResultAsync<User, FetchUserError | UserResponseError | ParseUserError | DecodeUserError> =>
  fromPromise(
    fetch(`https://example.com/users/${id}`),
    (cause) => new FetchUserError({ cause, id }),
  )
    .andThen((response) =>
      response.ok ? ok(response) : UserResponseError.err({ id, status: response.status }),
    )
    .andThen((response) =>
      tryResultAsync<unknown, ParseUserError>(
        () => response.json(),
        (cause) => new ParseUserError({ cause, id }),
      ),
    )
    .andThen((input) => decodeUser(input, id));

const label = (await fetchUser("usr_123")).match(
  (user) => `User ${user.id}`,
  (error) => error.message,
);
```

This keeps network failures, non-2xx responses, JSON parse failures, and payload decode failures
separate. In production, treat parsing bytes into `unknown` and decoding `unknown` into a domain
type as different failure modes.

Use `fromPromise(promise, toError)` when the promise already exists.

Use `tryResultAsync(() => promiseFactory(), toError)` when creating the promise can throw
synchronously.

## Wrapping Throwing Or Rejecting Code

Use Resultar wrappers at the edge of uncontrolled code: JSON parsing, platform APIs, third-party
libraries, I/O, and network calls. Convert the thrown or rejected value once, then keep your own
domain code returning Result values or Tasks. Prefer `tryResult` for synchronous work
and `ResultTask.tryPromise` for new asynchronous work. In-flight `tryResultAsync` and `fromPromise` are active for `ResultAsync` boundaries; `fromThrowableAsync` remains available for deprecated eager compatibility.

### `ResultTask.tryPromise`

```ts
const loadUser = (id: string) =>
  ResultTask.tryPromise({
    try: (signal) => client.loadUser(id, { signal }),
    catch: (cause) => new LoadUserError({ id, cause }),
  });

const result = await loadUser("usr_123").runResult();
```

Call the Promise-producing function inside `try`, so each Task run creates new work.
Passing a factory that always returns an already-created Promise captures that execution.
Use `ResultTask.try` for synchronous work deferred until the Task runs.

### `tryResult`

`tryResult` runs a synchronous function immediately and returns `Result<T, E>`.

```ts
import { tryResult } from "resultar";

class ParseJsonError extends Error {
  public constructor(public readonly cause: unknown) {
    super("Could not parse JSON");
  }
}

const parsed = tryResult(
  () => JSON.parse('{"value":1}') as { value: number },
  (cause) => new ParseJsonError(cause),
);
```

The object form is useful when named `try` / `catch` keys are clearer:

```ts
const parsed = tryResult({
  try: () => JSON.parse('{"value":2}') as { value: number },
  catch: (cause) => new ParseJsonError(cause),
});
```

If `catch` is omitted, the original thrown value becomes the error channel.

`try`, the default export, and the `tryCatch` alias remain the same helper with deprecation annotations.
Prefer `tryResult` in new code:

```ts
import tryDefault, { try as tryAlias, tryCatch, tryResult } from "resultar";

tryDefault === tryResult;
tryAlias === tryResult;
tryCatch === tryResult;
```

### In-flight `ResultAsync`: `tryResultAsync`

<a id="tryresultasync"></a>

For an in-flight `ResultAsync` boundary, `tryResultAsync` accepts a promise, an async factory, or the object form:

```ts
import { tryResultAsync } from "resultar";

const fromExistingPromise = tryResultAsync(fetch("/users"));

const fromFactory = tryResultAsync(
  () => fetch("/users"),
  (cause) => new Error("Request failed", { cause }),
);

const fromObject = tryResultAsync({
  try: () => fetch("/users"),
  catch: (cause) => new Error("Request failed", { cause }),
});
```

Use the factory form when creating the promise can throw synchronously. If `catch` is omitted, the
original rejection or thrown value becomes the error channel.

`tryAsync` and `tryCatchAsync` remain deprecated aliases of `tryResultAsync`. Prefer `tryResultAsync` for in-flight `ResultAsync` boundaries and `ResultTask.tryPromise` for new lazy async workflows:

```ts
import { tryAsync, tryCatchAsync, tryResultAsync } from "resultar";

tryAsync === tryResultAsync;
tryCatchAsync === tryResultAsync;
```

### `fromThrowable` and `fromThrowableAsync`

Use `fromThrowable` when you want to create a reusable safe wrapper around a throwing function:

```ts
import { fromThrowable } from "resultar";

const parseJson = fromThrowable(
  (input: string) => JSON.parse(input) as unknown,
  (cause) => new ParseJsonError(cause),
);

const result = parseJson("{");
```

For an existing eager contract, `fromThrowableAsync` creates a reusable Async wrapper,
catching synchronous throws and Promise rejections. For a new lazy adapter, return
`ResultTask.tryPromise({ try: () => operation(), catch: toError })` from your function.

```ts
import { fromThrowableAsync } from "resultar";

const readUserResponse = fromThrowableAsync(
  (id: string) => fetch(`/users/${id}`),
  (cause) => new Error("Could not request user", { cause }),
);
```

### In-flight `ResultAsync`: `fromPromise` and `fromSafePromise`

<a id="frompromise-and-fromsafepromise"></a>

These active helpers return an in-flight `ResultAsync`. Use `fromPromise(promise, toError)` to wrap
an already-created execution that may reject:

```ts
import { err, fromPromise, ok, tryResultAsync } from "resultar";

const loaded = fromPromise(fetch("/users"), (cause) => new Error("Request failed", { cause }))
  .andThen((response) =>
    response.ok ? ok(response) : err(new Error(`Request failed with status ${response.status}`)),
  )
  .andThen((response) =>
    tryResultAsync<unknown, Error>(
      () => response.json(),
      (cause) => new Error("Invalid JSON", { cause }),
    ),
  );
```

Use `fromSafePromise(promise)` only when rejection would be unexpected or already impossible by
construction:

```ts
import { fromSafePromise } from "resultar";

const loaded = fromSafePromise(Promise.resolve({ id: "usr_123" }));
```

## Tagged Errors

`createTaggedError` creates real `Error` subclasses with a stable `_tag` and typed metadata.

```ts
class UserNotFoundError extends createTaggedError({
  name: "UserNotFoundError",
  message: "User $id was not found in $source",
}) {}

const error = new UserNotFoundError({
  id: "usr_123",
  source: "database",
});

error instanceof Error;
error instanceof UserNotFoundError;
error._tag;
error.message;
error.id;
error.source;
```

Template variables in the message become required constructor props:

```ts
new UserNotFoundError({ id: "usr_123", source: "database" });

// @ts-expect-error source is required
new UserNotFoundError({ id: "usr_123" });
```

Refine metadata types with `withProps` in the error declaration:

```ts
class UserLookupError extends createTaggedError({
  name: "UserLookupError",
  message: "Could not find user $id",
}).withProps<{ id: string; retryAfter?: number; details?: { source: string } }>() {}

const error = new UserLookupError({ id: "usr_123", details: { source: "database" } });
error.id; // string
error.retryAfter; // number | undefined

// @ts-expect-error id must be a string
new UserLookupError({ id: 123 });
```

Declared fields replace their template-inferred types and can include optional or structured
metadata. Template fields remain required; undeclared template fields retain the existing
inference. Each `withProps` call creates a fresh nominal class using the original factory
configuration. Its constructor preserves metadata supplied through getters or non-enumerable
properties. TypeScript checks the declared metadata types.
`cause` remains a constructor prop governed by `Error` or the custom base; declare domain
metadata in `withProps` without redeclaring `cause`.

Use `.err(props)` when returning an error result:

```ts
const findUser = (id: string) =>
  id === "usr_123" ? ok({ id }) : UserNotFoundError.err({ id, source: "database" });
```

Tagged errors expose:

- `_tag`
- `message`
- `messageTemplate`
- `fingerprint`
- `cause`
- `toJSON()`
- `findCause(ErrorClass)`
- static `.is(value)`
- static `.err(props)`

When the message template is omitted, `$message` is used and callers provide the message at
construction time:

```ts
class DynamicMessageError extends createTaggedError({
  name: "DynamicMessageError",
}) {}

const error = new DynamicMessageError({ message: "Dynamic failure" });
```

Tagged errors can extend a custom `Error` base:

```ts
class AppError extends Error {
  public statusCode = 500;
}

class ForbiddenError extends createTaggedError({
  extends: AppError,
  name: "ForbiddenError",
  message: "Missing permission $permission",
}) {
  public override statusCode = 403;
}

const error = new ForbiddenError({ permission: "admin:write" });

error instanceof AppError;
error.statusCode;
```

Use `cause`, `.findCause`, or the standalone `findCause` helper for nested error lookup:

```ts
import { findCause } from "resultar";

class DatabaseError extends createTaggedError({
  name: "DatabaseError",
  message: "Database operation $operation failed",
}) {}

const root = new Error("connection refused");
const error = new DatabaseError({ cause: root, operation: "insert-user" });

error.cause;
error.findCause(Error);
findCause(error, Error);
```

Cause lookup is cycle-safe. It stops if the chain repeats and returns `undefined` when no matching
cause exists.

Use static `.is(value)` for nominal guards. It checks the actual generated class, not just `_tag`:

```ts
const error = new UserNotFoundError({ id: "usr_123", source: "database" });
const spoofed = Object.assign(new Error("spoofed"), { _tag: "UserNotFoundError" });

UserNotFoundError.is(error); // true
UserNotFoundError.is(spoofed); // false
```

`toJSON()` returns predictable error metadata for logs, responses, and snapshots. It serializes
nested `cause` chains recursively and stops safely if a cause cycle repeats:

```ts
error.toJSON();
```

Reserved template variables are rejected because they conflict with `Error` or tagged-error
metadata:

- `_tag`
- `cause`
- `fingerprint`
- `message`
- `messageTemplate`
- `name`
- `stack`

### Tagged Enums

Use `TaggedEnum<Members>` and `taggedEnum<Members>()` only for lightweight tagged unions that do
not need to be real `Error` instances.

```ts
import { taggedEnum } from "resultar";
import type { TaggedEnum } from "resultar";

type PaymentState = TaggedEnum<{
  Declined: { readonly code: string };
  Pending: { readonly retryAfterMs: number };
  Settled: { readonly receiptId: string };
}>;

const PaymentState = taggedEnum<{
  Declined: { readonly code: string };
  Pending: { readonly retryAfterMs: number };
  Settled: { readonly receiptId: string };
}>();

const state = PaymentState.Pending({ retryAfterMs: 1_000 });

state;
// { _tag: 'Pending', retryAfterMs: 1000 }
```

The runtime helper creates frozen plain objects. It does not create classes and it does not depend on
an external runtime.

Use `$is(tag, value)` when a value is unknown:

```ts
const input: unknown = state;

if (PaymentState.$is("Pending", input)) {
  input.retryAfterMs;
}
```

Use `$match(value, handlers)` for exhaustive local branching:

```ts
const label = PaymentState.$match(state, {
  Declined: (declined) => `declined:${declined.code}`,
  Pending: (pending) => `retry:${pending.retryAfterMs}`,
  Settled: (settled) => `receipt:${settled.receiptId}`,
});
```

Prefer `createTaggedError` for failures that cross service boundaries, need stack traces, need
`cause`, or should be handled by `matchError`. Prefer `taggedEnum` for nested reasons, state
machines, and small domain variants.

### Redacted Error Props

Use `redact(value, label?)` when a tagged error prop must not leak through messages or JSON.

```ts
import { createTaggedError, isRedacted, redact, revealRedacted } from "resultar";

class TokenRejectedError extends createTaggedError({
  name: "TokenRejectedError",
  message: "Token $token was rejected",
}) {}

const token = redact("secret-token-value", "api-token");
const error = new TokenRejectedError({ token });

error.message;
// 'Token <redacted:api-token> was rejected'

error.toJSON();
// { ..., token: '<redacted:api-token>' }

if (isRedacted(error.token)) {
  revealRedacted(error.token);
  // 'secret-token-value'
}
```

Use `revealRedacted` only in the exact code path that is allowed to see the original value. Normal
message interpolation, JSON serialization, and string conversion keep the redacted representation.

## Composing Steps

Use `map` when the success value changes and the transform cannot fail:

```ts
const normalizeEmail = (email: string): StrictResult<string, InvalidEmailError> =>
  validateEmail(email).map((value) => value.trim().toLowerCase());
```

Use `as` when success matters but the previous value does not:

```ts
const markCreated = (
  email: string,
): StrictResult<{ readonly status: "created" }, InvalidEmailError> =>
  createUser(email).as({ status: "created" });
```

For a new asynchronous step, lift the synchronous Result into Task and compose the
Promise operation explicitly. Task `map` stays synchronous:

```ts
const loadProfileLabel = (email: string) =>
  ResultTask.gen(function* () {
    const validEmail = yield* validateEmail(email);
    const profile = yield* ResultTask.tryPromise({
      try: () => profileClient.load(validEmail),
      catch: (cause) => new Error("Could not load profile", { cause }),
    });
    return profile.label;
  });
```

`Result` `asyncMap` methods and statics (`result.asyncMap(f)` / `Result.asyncMap(result, f)`)
provide the eager bridge for Promise callbacks; Task `map` remains synchronous.

Use `mapErr` when only the error value changes:

```ts
const result = validateEmail(email).mapErr(
  (cause) => new Error("Could not validate email", { cause }),
);
```

Use `filterOrElse` when a successful value must satisfy another predicate:

```ts
class InvalidDomainError extends createTaggedError({
  name: "InvalidDomainError",
  message: "Invalid email domain $domain",
}) {}

const validateCompanyEmail = (
  email: string,
): StrictResult<string, InvalidEmailError | InvalidDomainError> =>
  validateEmail(email).filterOrElse(
    (validEmail) => validEmail.endsWith("@company.com"),
    (validEmail) => new InvalidDomainError({ domain: validEmail.split("@")[1] ?? "unknown" }),
  );
```

Use `andThen` when the next step can fail:

```ts
class UserAlreadyExistsError extends createTaggedError({
  name: "UserAlreadyExistsError",
  message: "User $email already exists",
}) {}

class DatabaseError extends createTaggedError({
  name: "DatabaseError",
  message: "Database operation $operation failed",
}) {}

type CreateUserError = InvalidEmailError | UserAlreadyExistsError | DatabaseError;

const createUser = (email: string): StrictResult<User, CreateUserError> =>
  validateEmail(email).andThen(ensureUserDoesNotExist).andThen(insertUser);
```

Compose Results and Tasks with `yield*` for new asynchronous workflows. Here,
`ensureUserDoesNotExistTask` and `insertUserTask` return Task values:

```ts
const createUser = (email: string) =>
  ResultTask.gen(function* () {
    const validEmail = yield* validateEmail(email);
    yield* ensureUserDoesNotExistTask(validEmail);
    return yield* insertUserTask(validEmail);
  });
```

For existing eager composition, `Result.asyncAndThen` (or `result.asyncAndThen`) from `resultar` returns
`ResultAsync`, whose `andThen` accepts a synchronous Result or another `ResultAsync`:

```ts
import { Result } from "resultar";

const legacyCreated = Result.asyncAndThen(validateEmail(email), ensureUserDoesNotExistAsync)
  .andThen(insertUser)
  .andThen(sendWelcomeEmailAsync);
```

Use `ResultTask.fromResultAsync(() => legacyCreatedFactory())` to defer creation of an
existing eager workflow until a Task run. Wrapping `legacyCreated` itself reuses it.

Use `orElse` when an error should recover into another result:

```ts
const user = findUser(id).orElse((error) =>
  error._tag === "UserNotFoundError" ? createGuestUser(id) : err(error),
);
```

Use `pipe` for reusable combinators:

```ts
const audit = <T, E>(result: Result<T, E>): Result<T, E> =>
  result.inspect((value) => logger.info({ value }, "result ok"));

const userEmail = createUser(email).pipe(audit, (result) => result.map((user) => user.email));
```

## Pattern Matching

The core exports `Match` for typed pattern matching with pipe composition and fluent methods:

```ts
import { Match } from "resultar";

type Command = { type: "lookup"; id: string } | { type: "health" };

const dispatch = Match.type<Command>().pipe(
  Match.discriminator("type")("lookup", (command) => command.id),
  Match.discriminator("type")("health", () => "healthy"),
  Match.exhaustive,
);

const classify = Match.type<string | number>()
  .when(Match.string, (value) => value.length)
  .when(Match.number, (value) => value)
  .exhaustive();
```

`type`, `context` and `fn` defer execution until their compiled function is called; `value` executes cases
immediately. Only the first matching handler runs. `fn(selector)` forwards the narrowed selection
and all original arguments to each handler, so a reusable HTTP mapper can retain Hono `Context`
or Fastify's typed `reply`. `Match.context<Input, [context: Context]>()` instead passes
`(narrowedInput, context)` once, without repeating the input. Native Hono RPC response unions and
Fastify schemas are preserved:

```ts
type DomainEvent =
  | { readonly _tag: "UserCreated"; readonly id: string; readonly role: "admin" | "member" }
  | { readonly _tag: "UserSuspended"; readonly id: string; readonly reason: string }
  | { readonly _tag: "HealthPing"; readonly region: string };

// Immediate evaluation on a concrete value with tag table:
const summary = Match.valueTags(
  { _tag: "UserCreated", id: "usr_1", role: "admin" } as DomainEvent,
  {
    UserCreated: (event) => `created:${event.id}:${event.role}`,
    UserSuspended: (event) => `suspended:${event.id}:${event.reason}`,
    HealthPing: (event) => `ping:${event.region}`,
  },
);

// Reusable contextual matcher forwarding extra parameters without repeating the input:
const formatWithEnv = Match.context<DomainEvent, [env: "dev" | "prod"]>().pipe(
  Match.tagsExhaustive({
    UserCreated: (event, env) => `[${env}] user ${event.id} (${event.role})`,
    UserSuspended: (event, env) => `[${env}] suspended ${event.id}`,
    HealthPing: (event, env) => `[${env}] ok (${event.region})`,
  }),
);

// Combinators (`whenOr`, `whenAnd`, `not`) and non-exhaustive finalizers (`orElse`, `result`, `option`):
const adminOrPing = Match.type<DomainEvent>()
  .whenOr(
    { _tag: "UserCreated", role: "admin" },
    { _tag: "HealthPing" },
    (event) => `priority:${event._tag}`,
  )
  .not({ _tag: "UserSuspended" }, (event) => `member:${event.id}`)
  .result(); // returns Result<string, { readonly _tag: "UserSuspended"; ... }>
```

For ordinary route handlers, prefer inline `result.matchTags` and capture the native context or
reply in the closure. Extract a contextual matcher when several routes reuse the same mapping.

`tags` and `discriminators(field)` add partial tables. Their `Exhaustive` variants finalize the
matcher and require every remaining variant. `valueTags(input, handlers)` dispatches directly;
`typeTags<Input>()(handlers)` constructs a reusable exhaustive function. `whenOr`, `whenAnd`,
`not`, tag prefixes, native type guards and declared return contracts support more complex policies.

`exhaustive` requires full coverage, while `orElse` receives the still-unmatched type. `result`
returns a native Resultar `Ok` or an `Err` holding the original unmatched input. `option` produces
plain `Some` / `None` tagged values. Handlers retain normal exception and Promise behavior.
Boolean predicates and partial refinements cannot claim full coverage. Object patterns require
plain objects; array patterns match supplied positions and literal patterns use `===`.

See [the complete Match guide](packages/resultar/README.md#pattern-matching-with-match), the
[Hono routes](examples/hono/src/routes.ts), and the [Fastify routes](examples/fastify/src/routes.ts)
for runnable HTTP boundaries. Use existing `Result.match` / `matchTags` when consuming a Result;
`Match.result` is the pattern matcher's finalizer.

## Handling Results At Boundaries

Boundary code is where Resultar values become HTTP responses, queue acknowledgements, CLI exit
codes, logs, metrics, or UI state.

Use `match` for simple success/error branches:

```ts
const response = createUser("person@example.com").match(
  (user) => ({ body: user, statusCode: 201 }),
  (error) => ({ body: { code: "CreateUserFailed", message: error.message }, statusCode: 400 }),
);
```

The labeled object form `{ ok, err }` (also accepting `{ ok, error }`) is equivalent and often reads better at boundaries:

```ts
const response = createUser("person@example.com").match({
  ok: (user) => ({ body: user, statusCode: 201 }),
  err: (error) => ({
    body: { code: "CreateUserFailed", message: error.message },
    statusCode: 400,
  }),
});
```

On `ResultAsync` instances, `match`, `matchTags`, and `matchTagsPartial` return native
`Promise<Out>` terminals and await handler results. Their static/direct/curried forms return
composable `ResultAsync<Out, never>` values. On Task, they remain lazy operators
returning `ResultTask<Out, never, R>`; use `folded.runPromise()` for `Out`, or
match on the Result produced by `runResult`. For an existing Async boundary:

```ts
const response = await fetchUser("usr_123").match({
  ok: (user) => ({ body: user, statusCode: 200 }),
  err: (error) => ({ body: { message: error.message }, statusCode: 502 }),
});
```

Use `matchTags` when every tagged error should be handled explicitly:

```ts
const response = createUser("taken@example.com").matchTags(
  (user) => ({
    body: user,
    statusCode: 201,
  }),
  {
    DatabaseError: (error) => ({
      body: { code: error._tag, message: error.message },
      statusCode: 500,
    }),
    InvalidEmailError: (error) => ({
      body: { code: error._tag, message: error.message },
      statusCode: 400,
    }),
    UserAlreadyExistsError: (error) => ({
      body: { code: error._tag, message: error.message },
      statusCode: 409,
    }),
  },
);
```

If a handler is missing, TypeScript reports it.

Use `matchTagsPartial` when only some errors need custom handling and the rest should share a
fallback:

```ts
const response = createUser("taken@example.com").matchTagsPartial(
  (user) => ({ body: user, statusCode: 201 }),
  {
    InvalidEmailError: (error) => ({
      body: { code: error._tag, message: error.message },
      statusCode: 400,
    }),
  },
  (error) => ({
    body: { code: "UnhandledError", message: error.message },
    statusCode: 500,
  }),
);
```

Use standalone `matchError` when you have an error value instead of a `Result`:

```ts
import { matchError } from "resultar";

declare const error: InvalidEmailError | UserAlreadyExistsError | DatabaseError;

const statusCode = matchError(error, {
  DatabaseError: () => 500,
  InvalidEmailError: () => 400,
  UserAlreadyExistsError: () => 409,
});
```

When plain or untagged `Error` is part of the union, include an `Error` handler.

```ts
declare const error: InvalidEmailError | DatabaseError | Error;

const message = matchError(error, {
  DatabaseError: (err) => err.message,
  Error: (err) => err.message,
  InvalidEmailError: (err) => err.message,
});
```

Use `matchErrorPartial(error, handlers, fallback)` when only selected tagged errors need special
handling:

```ts
const message = matchErrorPartial(
  error,
  {
    InvalidEmailError: (err) => `Invalid input: ${err.email}`,
  },
  (err) => err.message,
);
```

## Recovering Tagged Errors Locally

Use `catchTag` when one tagged error can be recovered before the boundary:

```ts
const result = createUser("bad-email").catchTag("InvalidEmailError", (error) =>
  ok({ email: error.email, id: "draft_user" }),
);
```

Use `catchTags` when a small group of tagged errors share local recovery:

```ts
const result = createUser("taken@example.com").catchTags({
  InvalidEmailError: (error) => ok({ email: error.email, id: "draft_user" }),
  UserAlreadyExistsError: (error) => ok({ email: error.email, id: "existing_user" }),
});
```

`catchTags` is intentionally partial: unhandled tags stay in the error channel.

Use `catchTags` for pipeline recovery. Use `matchTagsPartial` for boundary mapping with a fallback.

## Reasoned Tagged Errors

Some failures have one stable outer error and a smaller nested reason union. This is common for
provider errors, policy decisions, AI/service refusals, validation families, and quota/rate-limit
branches.

Use a parent tagged error when logs and boundaries should keep one stable error tag:

```ts
import { createTaggedError, err, ok, taggedEnum } from "resultar";
import type { StrictResult, TaggedEnum } from "resultar";

const AiReason = taggedEnum<{
  QuotaExceededError: { readonly limit: number };
  RateLimitError: { readonly retryAfterMs: number };
  SafetyBlockedError: { readonly policy: string };
}>();

type AiReason = TaggedEnum<{
  QuotaExceededError: { readonly limit: number };
  RateLimitError: { readonly retryAfterMs: number };
  SafetyBlockedError: { readonly policy: string };
}>;

class AiError extends createTaggedError({
  name: "AiError",
  message: "AI request failed",
}) {
  public readonly reason: AiReason;

  public constructor(props: { readonly cause?: unknown; readonly reason: AiReason }) {
    super({ cause: props.cause });
    this.reason = props.reason;
  }
}

const completePrompt = (): StrictResult<string, AiError> =>
  err(new AiError({ reason: AiReason.RateLimitError({ retryAfterMs: 1_000 }) }));
```

Use `catchReason(parentTag, reasonTag, handler)` for one local recovery path:

```ts
const completed = completePrompt().catchReason("AiError", "RateLimitError", (reason) =>
  ok(`retry after ${reason.retryAfterMs}ms`),
);
```

Use `catchReasons(parentTag, handlers)` when several reasons can recover locally:

```ts
const completed = completePrompt().catchReasons("AiError", {
  QuotaExceededError: (reason) => ok(`quota:${reason.limit}`),
  RateLimitError: (reason) => ok(`retry:${reason.retryAfterMs}`),
});
```

Unhandled reasons stay in the error channel as the original parent error with a narrowed `reason`.
That means local recovery stays precise, while boundary code can still handle `AiError`.

Use `unwrapReason(parentTag)` when a downstream step only cares about the nested reason union:

```ts
const reasonResult = completePrompt().unwrapReason("AiError");

const response = reasonResult.match(
  (value) => ({ body: value, statusCode: 200 }),
  (reason) =>
    AiReason.$match(reason, {
      QuotaExceededError: (quota) => ({
        body: { limit: quota.limit },
        statusCode: 403,
      }),
      RateLimitError: (rateLimit) => ({
        body: { retryAfterMs: rateLimit.retryAfterMs },
        statusCode: 429,
      }),
      SafetyBlockedError: (blocked) => ({
        body: { policy: blocked.policy },
        statusCode: 400,
      }),
    }),
);
```

`ResultAsync` and `ResultTask` provide the same three methods (`catchReason`, `catchReasons`, and
`unwrapReason`). In `ResultTask`, reason handlers may return either a synchronous `Result` or a
`ResultTask` (whose service requirements and error types are merged automatically), and static
curried forms (`ResultTask.catchReason`, `ResultTask.catchReasons`, `ResultTask.unwrapReason`)
work in `.pipe(...)`:

```ts
import { ResultTask } from "resultar";

const task = ResultTask.fromResult(completePrompt())
  .catchReason("AiError", "RateLimitError", (reason) =>
    ResultTask.sleep(reason.retryAfterMs).as("retried-ok"),
  )
  .unwrapReason("AiError");
```

## Fallbacks

Fallbacks are useful when an `Err` has a meaningful recovery path. Resultar keeps fallback behavior
explicit through Result and Task operations. Existing Async fallback APIs remain
available on `ResultAsync` with their eager execution contract.

| Fallback idea       | Resultar API                                          | Use when                                                           |
| ------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| `orElse`            | `result.orElse(() => fallbackResult)`                 | another operation can recover the failure                          |
| `orElseFail`        | `mapErr(...)` or `orElse(() => err(newError))`        | the failure should be normalized or replaced                       |
| `orElseSucceed`     | `orElse(() => ok(defaultValue))`                      | a fallback success should stay in the pipeline                     |
| default at the edge | `unwrapOr(defaultValue)`                              | defaulting is intentional and no more result composition is needed |
| ordered candidates  | `Result.firstSuccessOf` / `ResultTask.firstSuccessOf` | each candidate should run only if earlier candidates fail          |

Use `orElse` for pipeline recovery:

```ts
const user = readUserFromCache(id).orElse(() => readUserFromRemote(id));
```

If recovery depends on the specific error, inspect the error or prefer tagged recovery helpers:

```ts
const user = readUserFromCache(id).orElse((error) =>
  CacheMissError.is(error) ? readUserFromRemote(id) : err(error),
);
```

Use `mapErr` when a low-level error should become a stable domain error:

```ts
class ReadUserError extends createTaggedError({
  name: "ReadUserError",
  message: "Could not read user $id",
}) {}

const user = readUserFromRemote(id).mapErr((cause) => new ReadUserError({ cause, id }));
```

Use `orElse(() => err(newError))` when replacing the failure requires another `Result` branch:

```ts
const user = readUserFromRemote(id).orElse((cause) =>
  ReadUserError.err({
    cause,
    id,
  }),
);
```

Use `orElse(() => ok(defaultValue))` when fallback success is part of the pipeline:

```ts
const user = readUser(id).orElse(() =>
  ok({
    email: "guest@example.com",
    id: "guest",
  }),
);
```

Use instance `unwrapOr(defaultValue)` at a final edge. Result returns a plain value; Async returns
a native Promise of that value; static `ResultAsync.unwrapOr` returns composable Async.
Task returns a lazy fold to execute with `runPromise`:

```ts
const port = parsePort(process.env.PORT ?? "").unwrapOr(3000);
const asyncPort = await loadPortTask().unwrapOr(3000).runPromise();
```

Use `firstSuccessOf` when fallbacks should be lazy and ordered:

```ts
const userTask = ResultTask.firstSuccessOf([
  () => readUserFromCacheTask(id),
  () => readUserFromPrimaryTask(id),
  () => readUserFromReplicaTask(id),
]);
const user = await userTask.runResult();
```

Guidance:

- Use `orElse` for pipeline recovery.
- Use `catchTag` / `catchTags` for recovery from specific tagged errors.
- Use `matchTagsPartial` for boundary fallback mapping.
- Use `unwrapOr` only at final edges where defaulting is intentional.
- Use `firstSuccessOf` when fallback candidates must be tried in order and skipped after success.

## Catching And Recovering Errors

Resultar has several “catch” surfaces because failures appear at different points in a program.
Use this section as the decision map.

| Error source or goal                                     | API                                          | What it catches or handles                                                               |
| -------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| New asynchronous work may throw or reject                | `ResultTask.tryPromise({ try, catch })`      | Defers work to each run and maps expected failures.                                      |
| Synchronous code may throw now                           | `tryResult(fn, toError?)`                    | Runs `fn` immediately and catches thrown values into `Err`.                              |
| Synchronous code should be wrapped for later calls       | `fromThrowable(fn, toError?)`                | Returns a reusable function that catches thrown values.                                  |
| Existing eager Promise may reject (compatibility)        | `fromPromise(promise, toError)`              | Converts rejection into a typed `Err`.                                                   |
| Existing eager boundary may throw/reject (compatibility) | `tryResultAsync(promiseOrFactory, toError?)` | Catches rejections and synchronous throws from the factory form.                         |
| Existing eager function needs a wrapper (compatibility)  | `fromThrowableAsync(fn, toError?)`           | Returns a reusable function that catches synchronous throws and promise rejections.      |
| Existing eager Promise cannot reject (compatibility)     | `fromSafePromise(promise)`                   | Does not catch rejections; use only when rejection is impossible or intentionally fatal. |
| Error should become another error                        | `mapErr(fn)`                                 | Transforms the `Err` channel and leaves `Ok` untouched.                                  |
| Error can recover into another result                    | `orElse(fn)`                                 | Replaces an `Err` with another `Result` / `ResultTask` (Async for compatibility).        |
| One tagged error can recover locally                     | `catchTag(tag, fn)`                          | Handles only that `_tag` and narrows the remaining error union.                          |
| Several tagged errors can recover locally                | `catchTags(handlers)`                        | Handles listed tags and leaves unlisted tags in the error channel.                       |
| One nested tagged reason can recover locally             | `catchReason(parentTag, reasonTag, fn)`      | Handles one nested reason inside a parent tagged error.                                  |
| Several nested tagged reasons can recover locally        | `catchReasons(parentTag, handlers)`          | Handles listed nested reasons and leaves the rest.                                       |
| Boundary needs to convert a whole result                 | `match`, `matchTags`, `matchTagsPartial`     | Converts `Ok` / `Err` into responses, logs, exit codes, or UI state.                     |
| You already have an `Error` value                        | `matchError`, `matchErrorPartial`            | Matches a tagged or plain error without wrapping it in `Result`.                         |
| Linear generator code may throw unexpectedly             | `Result.gen({ try, catch })`                 | Maps thrown values from the generator body; yielded `Err` values are preserved.          |
| Retry policy exhausted                                   | `task.retry(policy).orElse(fallback)`        | Runs fallback only after retry stops with an `Err`.                                      |
| Timeout should be expected, not thrown                   | `task.timeout(ms, onTimeout)`                | Returns a typed timeout `Err` and aborts the task signal.                                |
| You need to detect abort-shaped errors                   | `isAbortError(value)`                        | Detects Resultar, DOM-style, and Node abort-shaped errors.                               |

The high-level rule is simple:

- Use `tryResult` / `fromThrowable` for synchronous edges and `ResultTask.tryPromise`
  for new async edges. Eager Async wrappers remain for existing contracts.
- Use `mapErr`, `orElse`, `catchTag`, `catchTags`, `catchReason`, and `catchReasons` inside result
  pipelines.
- Use `match`, `matchTags`, `matchTagsPartial`, `matchError`, and `matchErrorPartial` at boundaries.
- Keep bugs, impossible states, and truly unrecoverable failures as normal JavaScript throws unless
  you intentionally convert them at a boundary.

### Catch Thrown Code At The Edge

The error type is whatever the mapper returns. In this example, arbitrary thrown values from
`JSON.parse` become `ParseConfigError`, so callers only see `StrictResult<Config, ParseConfigError>`.

```ts
const parsed: StrictResult<Config, ParseConfigError> = tryResult(
  () => JSON.parse(input) as Config,
  (cause) => new ParseConfigError({ cause }),
);
```

Use object form when named `try` and `catch` keys make the boundary clearer:

```ts
const parsed: StrictResult<Config, ParseConfigError> = tryResult({
  try: () => JSON.parse(input) as Config,
  catch: (cause) => new ParseConfigError({ cause }),
});
```

For reusable adapters, wrap the throwing function once:

```ts
const parseConfig: (input: string) => StrictResult<Config, ParseConfigError> = fromThrowable(
  (input: string) => JSON.parse(input) as Config,
  (cause) => new ParseConfigError({ cause }),
);
```

### Catch Rejected Async Work

For new async work, `ResultTask.tryPromise` maps synchronous factory throws and
Promise rejections to its typed error channel on each run:

```ts
const fetchResponse = (url: string) =>
  ResultTask.tryPromise({
    try: (signal) => fetch(url, { signal }),
    catch: (cause) => new FetchPayloadError({ cause, url }),
  });

const response = await fetchResponse(url).runResult();
```

#### Retained eager rejection wrappers

The following examples return eager `ResultAsync` and keep their original eager behavior.
Use `fromPromise` when the promise already exists:

```ts
const response: StrictResultAsync<Response, FetchPayloadError> = fromPromise(
  fetch(url),
  (cause) => new FetchPayloadError({ cause, url }),
);
```

Use `tryResultAsync` factory form when creating the promise may throw synchronously:

```ts
const response: StrictResultAsync<Response, FetchPayloadError> = tryResultAsync(
  () => fetch(url),
  (cause) => new FetchPayloadError({ cause, url }),
);
```

Use `fromThrowableAsync` for reusable async adapters:

```ts
const fetchJson: (url: string) => StrictResultAsync<unknown, FetchPayloadError> =
  fromThrowableAsync(
    async (url: string) => {
      const response = await fetch(url);
      return response.json() as Promise<unknown>;
    },
    (cause) => new FetchPayloadError({ cause, url: "unknown" }),
  );
```

### Recover Inside A Pipeline

In the async examples below, repository and use-case functions return Task values.
Use `mapErr` when recovery is just error normalization; composition stays lazy:

```ts
const user: ResultTask<User, ReadUserError> = readUserFromDatabase(id).mapErr(
  (cause: DatabaseError) => new ReadUserError({ cause, id }),
);
```

The original `DatabaseError` no longer appears in the public error channel. It is preserved as
`cause` inside `ReadUserError`.

Use `orElse` when recovery is another fallible operation:

```ts
const user: ResultTask<User, CacheUnavailableError | DatabaseError> = readUserFromCache(id).orElse(
  (error) => (CacheMissError.is(error) ? readUserFromDatabase(id) : err(error)),
);
```

Here `CacheMissError` is handled and removed. `CacheUnavailableError` remains because it is returned
unchanged, and `DatabaseError` is added by the fallback branch.

Use tagged catch helpers when only specific domain failures are recoverable:

```ts
type CreateUserError = InvalidEmailError | UserAlreadyExistsError | DatabaseError;

const user: ResultTask<User, DatabaseError> = createUser(input).catchTags({
  InvalidEmailError: (error) => ok({ email: error.email, id: "draft_user" }),
  UserAlreadyExistsError: (error) => readExistingUser(error.email),
});
```

`InvalidEmailError` and `UserAlreadyExistsError` are handled, so only unhandled `DatabaseError`
remains in the error channel. If a handler returns its own `Err`, that handler error is added to the
remaining union.

Use reason catch helpers when one parent error carries a nested reason union:

```ts
type AiErrorReason = RateLimitError | SafetyBlockedError | QuotaExceededError;
type RemainingAiReason = SafetyBlockedError | QuotaExceededError;
type RemainingAiError = AiError & { readonly reason: RemainingAiReason };

const answer: StrictResult<string, RemainingAiError> = askAi(prompt).catchReason(
  "AiError",
  "RateLimitError",
  (reason) => ok(`retry after ${reason.retryAfterMs}ms`),
);
```

`catchReason` removes only the handled nested reason. The parent `AiError` stays in the error
channel with the remaining reason type.

### Catch At Boundaries

Use `matchTags` when every tagged error should become an explicit boundary result:

```ts
const response: HttpResponse = createUser(input).matchTags(
  (user) => ({ body: user, statusCode: 201 }),
  {
    InvalidEmailError: (error) => ({ body: { code: error._tag }, statusCode: 400 }),
    UserAlreadyExistsError: (error) => ({ body: { code: error._tag }, statusCode: 409 }),
  },
);
```

`matchTags` consumes the whole result. Its return type is the union of every handler return type, not
another `Result`.

Use `matchTagsPartial` when selected errors need custom handling and the rest share a fallback:

```ts
const response: HttpResponse = createUser(input).matchTagsPartial(
  (user) => ({ body: user, statusCode: 201 }),
  {
    InvalidEmailError: (error) => ({ body: { code: error._tag }, statusCode: 400 }),
  },
  (error) => ({ body: { code: error._tag }, statusCode: 500 }),
);
```

At runtime the fallback handles unmatched errors. Existing Result and Async instance
signatures retain the full error union; newer functional forms narrow it to unmatched
errors. Use this at boundaries where one default error
response is acceptable.

Use `matchError` when a framework already handed you an `Error` value:

```ts
const statusCode: number = matchError(error, {
  DatabaseError: () => 500,
  InvalidEmailError: () => 400,
  UserAlreadyExistsError: () => 409,
});
```

If plain `Error` can appear, include an `Error` handler or use `matchErrorPartial` with a fallback.

### Callback Failure Semantics

Transform callbacks are part of the pipeline. If they throw, reject, or return a rejected
`ResultAsync`, the resulting promise rejects:

```ts
const result = ok(1).map(() => {
  throw new Error("mapping failed");
});
```

Observation callbacks are best-effort. `inspect`, `inspectError`, and `log` ignore thrown or rejected
callback failures and preserve the original result. Use `andThen`, `orElse`, `tryResult`, or
`tryResultAsync` when callback failure should affect control flow.

## Concurrent Racing And Timeouts

Prefer Task racing and time policies for new workflows. They execute at a run
boundary and preserve resource cleanup and structured causes.

### Task Racing, Timeouts, Timing, And Virtual Clock

`ResultTask` provides structured racing and time helpers (`ResultTask.race`, `ResultTask.raceFirst`,
`ResultTask.timeout`, `ResultTask.sleep`, `ResultTask.delay`, `ResultTask.now`, and
`ResultTask.timed`) that own their child scopes, interrupt losers, and await loser finalizers before
resolving:

```ts
import { Clock, ResultTask, createTaggedError } from "resultar";

class QueryDeadlineError extends createTaggedError({
  name: "QueryDeadlineError",
  message: "Query exceeded $ms ms",
}).withProps<{ readonly ms: number }>() {}

const clock = Clock.virtual();

const replicaRace = ResultTask.race(
  ResultTask.sleep(10).as("primary"),
  ResultTask.sleep(50).as("replica"),
)
  .timed()
  .timeout(100, () => new QueryDeadlineError({ ms: 100 }));

const running = replicaRace.runResult({ clock });
await clock.advanceBy(10);
const outcome = await running; // Ok([10, "primary"])
```

`Clock.virtual()` provides `advanceBy`, `flush`, `now` and `pending`. It drives Task
`sleep`, `delay`, `timed`, `timeout` and `retry` without wall-clock timers.

### Deprecated Async racing and timeout policies

The following eager factory APIs remain supported for existing Async workflows.
They do not share Task's scope or cause-tree semantics.

`ResultAsync` racing helpers accept signal-aware task factories and start work when called. The task shape is:

```ts
type ResultAsyncRaceTask<T, E> = (signal: ResultAsyncAbortSignal) => ResultAsync<T, E>;
```

Tasks are functions, not already-created `ResultAsync` values. This matters because cancellation is
cooperative: Resultar can abort the signal, but the task must pass that signal to the underlying
operation. The public signal type is structural, so platform `AbortSignal` values are compatible
without forcing every consumer to include DOM or Node ambient types.

#### `race`

`ResultAsync.race(left, right)` starts both tasks immediately and returns the first `Ok`. If one task
returns `Err`, `race` keeps waiting for the other task. If both fail, it returns the last completed
`Err`.

```ts
const user = ResultAsync.race(
  (signal) => readUserFromPrimary(id, { signal }),
  (signal) => readUserFromReplica(id, { signal }),
);
```

When a success wins, still-pending losers are aborted and interrupted. Tasks that already completed are not aborted
later. Scoped `ResultTask` children await their registered finalizers before completing.

#### `raceAll`

`ResultAsync.raceAll(tasks)` is the collection form of `race`. It starts every task immediately,
returns the first `Ok`, and returns the last completed `Err` if every task fails.

```ts
const user = ResultAsync.raceAll([
  (signal) => readUserFromReplicaA(id, { signal }),
  (signal) => readUserFromReplicaB(id, { signal }),
  (signal) => readUserFromReplicaC(id, { signal }),
] as const);
```

Use a non-empty tuple when you want precise union inference for all values and errors.

Use `raceAll` when several equivalent providers can satisfy the same read and an early failure
should not hide a later success:

```ts
const user = ResultAsync.raceAll([
  (signal) => readUserFromEdgeCache(id, { signal }),
  (signal) => readUserFromPrimaryRegion(id, { signal }),
  (signal) => readUserFromReplicaRegion(id, { signal }),
] as const);
```

If one provider returns `Err` quickly, `raceAll` keeps waiting. If a later provider returns `Ok`,
that success wins and pending providers receive an abort signal. If every provider fails, the last
completed error is returned.

#### `raceFirst`

`ResultAsync.raceFirst(left, right)` returns the first completed `Result`, whether it is `Ok` or
`Err`.

```ts
const firstDone = ResultAsync.raceFirst(
  (signal) => doWork(id, { signal }),
  (signal) => pollCancellation(id, { signal }),
);
```

Use `raceFirst` when an early failure should win. Use `race` when an early failure should not stop
waiting for a possible success.

#### `timeout`

`ResultAsync.timeout(task, options)` is a `raceFirst` convenience. If the task settles first, its
original `Ok` or `Err` is returned. If the timer wins, `onTimeout()` creates the typed timeout error
and the task signal is aborted with that error.

```ts
class FetchUserTimeoutError extends createTaggedError({
  name: "FetchUserTimeoutError",
  message: "Fetch user $id timed out after $timeoutMs milliseconds",
}) {}

const user = ResultAsync.timeout((signal) => fetchUser(id, { signal }), {
  timeoutMs: 2_000,
  onTimeout: () => new FetchUserTimeoutError({ id, timeoutMs: 2_000 }),
});
```

Timeouts stay in the expected error channel, so response mapping can stay exhaustive:

```ts
const response = (await user).matchTags((loadedUser) => ({ body: loadedUser, statusCode: 200 }), {
  FetchUserError: (error) => ({ body: { code: error._tag }, statusCode: 502 }),
  FetchUserTimeoutError: (error) => ({
    body: { code: error._tag, message: error.message },
    statusCode: 504,
  }),
});
```

`timeout` does not use a rejected timeout promise. Timeout is just another typed `Err`.

#### `raceWith`

`ResultAsync.raceWith(left, right, handlers)` is the low-level primitive. The first completed side
calls its finisher with the completed `Result` and a handle for the loser.

```ts
const result = ResultAsync.raceWith(primary, fallback, {
  onLeftDone: (leftResult, fallbackHandle) => {
    if (leftResult.isOk()) {
      fallbackHandle.abort();
      return leftResult;
    }

    return fallbackHandle.wait();
  },
  onRightDone: (rightResult, primaryHandle) => {
    primaryHandle.abort();
    return rightResult;
  },
});
```

The loser handle exposes:

- `signal`
- `abort(reason?)`
- `wait()`

Use `raceWith` when neither `race` nor `raceFirst` expresses the desired policy.

#### Abort Errors

`AbortError` is Resultar's own abort error class. `isAbortError(value)` detects Resultar
`AbortError`, DOM-style `{ name: 'AbortError' }`, and Node abort-shaped `{ code: 'ABORT_ERR' }`
values.

```ts
import { AbortError, isAbortError } from "resultar";

const aborted = new AbortError("cancelled");

isAbortError(aborted); // true
isAbortError({ name: "AbortError" }); // true
isAbortError({ code: "ABORT_ERR" }); // true
```

Resultar racing uses cooperative abort. If a task ignores the signal, Resultar stops observing the
loser and returns the winner, but it cannot force the underlying work to stop.

## Retrying Async Work

Apply `task.retry(Retry.policy(...))` to
repeatable Task operations. Retry only the operation that is safe to execute again.

### Portable Retry Policies And ResultTask Retry

`Retry.policy(options)` constructs an immutable, reusable retry policy that works with both
`ResultTask.retry` and `ResultAsync.retry`. When used with `ResultTask.retry`, each attempt runs in
its own resource scope and closes all acquired resources before the retry delay or the next attempt:

With the default live clock, a computed retry delay of zero starts the next attempt without a
timer. The task scheduler still yields cooperatively during long retry sequences. Custom and
virtual clocks retain their `sleep(0)` behavior; positive delays always use the active clock.

```ts
import { Clock, ResultTask, Retry } from "resultar";

const transientPolicy = Retry.policy<{ readonly _tag: string }>({
  times: 2,
  delayMs: ({ nextAttempt }) => nextAttempt * 10,
  while: (error) => error._tag === "TransientError",
});

const clock = Clock.virtual();
let attempts = 0;

const task = ResultTask.sync(() => ++attempts)
  .andThen((attempt) =>
    attempt < 3 ? ResultTask.err({ _tag: "TransientError" as const }) : ResultTask.ok("ready"),
  )
  .retry(transientPolicy);

const running = task.runResult({ clock });
await clock.advanceBy(30);
const result = await running; // Ok("ready") after 10ms + 20ms virtual time
```

### Deprecated Async retry factories

The following reference preserves the eager Async retry contract. These factories
start work when called, rather than when an explicit Task runner is invoked.

`ResultAsync.retry(factory, options)` starts its retry loop eagerly and invokes the
attempt factory again after a retryable `Err`. The factory receives the zero-based
attempt number and a `ResultAsyncAbortSignal`-compatible signal.

```ts
const user = ResultAsync.retry((attempt, signal) => fetchUser(id, { attempt, signal }), {
  times: 2,
  delayMs: ({ nextAttempt }) => nextAttempt * 100,
  while: (error) => error._tag === "RateLimitError",
});
```

`times` is the number of retries after the first attempt. `times: 0` runs once. If the task returns
`Ok`, retrying stops immediately. If it keeps returning `Err`, the last error is returned after the
retry budget is exhausted.

The retry context passed to `delayMs`, `while`, `onRetry`, and `orElse` has this shape:

```ts
interface ResultAsyncRetryContext {
  readonly attempt: number;
  readonly nextAttempt: number;
  readonly retriesRemaining: number;
}
```

Use `while` when only some errors are retryable. Use `delayMs` for fixed or context-derived delays.
Use `onRetry` for diagnostics; callback failures are ignored and do not alter the result.

```ts
const saved = ResultAsync.retry((attempt, signal) => saveInvoice(invoice, { attempt, signal }), {
  times: 3,
  delayMs: 50,
  while: (error) => error._tag === "DatabaseBusyError",
  onRetry: (error, context) => {
    logger.warn({ attempt: context.attempt, error }, "retrying invoice save");
  },
});
```

`ResultAsync.retryOrElse(task, options)` runs the same retry policy, then calls `orElse` only when
the policy stops with an error. The fallback can return either `Result` or `ResultAsync`.

```ts
const user = ResultAsync.retryOrElse((attempt, signal) => fetchUser(id, { attempt, signal }), {
  times: 2,
  orElse: () => readCachedUser(id),
});
```

Use `retryOrElse` when the fallback is part of the domain policy, not an exception handler:

```ts
const profile = ResultAsync.retryOrElse(
  (attempt, signal) => loadProfileFromApi(userId, { attempt, signal }),
  {
    times: 3,
    delayMs: ({ nextAttempt }) => nextAttempt * 250,
    while: (error) => error._tag === "RateLimitError" || error._tag === "GatewayTimeoutError",
    orElse: (error) =>
      error._tag === "RateLimitError"
        ? loadProfileSnapshot(userId)
        : err(new ProfileUnavailableError({ cause: error, userId })),
  },
);
```

Platform abort signals are accepted structurally:

```ts
const controller = new AbortController();

const imported = ResultAsync.retry((attempt, signal) => importPage(page, { attempt, signal }), {
  signal: controller.signal,
  times: 5,
  delayMs: 100,
});

controller.abort(new Error("request closed"));
```

Invalid `times` values and invalid retry delays reject with an `IllegalArgumentException`-named
`Error`. An external `ResultAsyncAbortSignal`-compatible signal aborts before a new attempt or
during retry delay and returns a typed `AbortError`.

## Async Concurrency Mapping

Use `ResultTask.all`, `forEach` and `validateAll` for new asynchronous collections.
They are lazy, default to sequential execution and accept explicit concurrency limits:

```ts
const saveBatch = ResultTask.forEach(users, (user) => saveUserTask(user), {
  concurrency: 4,
}).asVoid();
const saved = await saveBatch.runResult();
```

Task collections retain service requirements and own the lifetime of active children.
Fail-fast operations interrupt active siblings and await cleanup; `validateAll` collects
simple typed failures in input order. Defects, interruption and cleanup causes retain
the Task runtime's structured semantics.

### Deprecated Async concurrency reference

The eager Async helpers below retain their independent scheduling contracts. Keep
these APIs for existing workflows; they do not acquire Task scopes by being awaited.

| Async concurrency idea       | Resultar API                                                            | Notes                                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Sequential execution         | `ResultAsync.forEach(items, fn)` / `ResultAsync.validateAll(items, fn)` | Default `concurrency` is `1`.                                                                                   |
| Numbered concurrency         | `{ concurrency: n }`                                                    | `n` must be a positive integer. Invalid runtime values reject with an `IllegalArgumentException`-named `Error`. |
| Unbounded concurrency        | `{ concurrency: "unbounded" }`                                          | Starts every mapped `ResultAsync` task immediately.                                                             |
| Already-created async values | `ResultAsync.combine(results)`                                          | The values are already running or already created; `combine` only aggregates them.                              |
| Racing                       | `race`, `raceAll`, `raceFirst`, `raceWith`, `timeout`                   | Starts signal-aware factories eagerly.                                                                          |
| Retrying                     | `retry`, `retryOrElse`                                                  | Invokes fresh attempt factories by policy.                                                                      |
| Interruption                 | race/retry task signal                                                  | Cooperative only. Tasks must pass the signal to underlying work.                                                |

```ts
const saved = await ResultAsync.forEach(users, (user) => saveUser(user), {
  concurrency: 4,
  discard: true,
});
```

```ts
const validation = await ResultAsync.validateAll(fields, (field) => validateField(field), {
  concurrency: "unbounded",
});
```

Use bounded `forEach` for side-effecting batch work where the first expected failure should stop
new scheduling:

```ts
const result = await ResultAsync.forEach(
  invoices,
  (invoice) => chargeInvoice(invoice).andThen((receipt) => markInvoicePaid(invoice.id, receipt)),
  { concurrency: 6, discard: true },
);
```

Use mapped `validateAll` when every independent item should run and every validation failure should
be returned:

```ts
const validation = await ResultAsync.validateAll(
  rows,
  (row, index) => validateImportRow(row).mapErr((error) => ({ index, error })),
  { concurrency: 12 },
);
```

`ResultAsync.forEach` stops scheduling new work after the first `Err`, waits for already-started
tasks to settle, and returns the first error by input order among started tasks.

`ResultAsync.validateAll` keeps scheduling until every item has run and returns all validation
errors in input order.

ResultAsync does not include inherited concurrency, fibers, standalone interruption hooks, detached
background interruption, or runtime cause trees.

## Structured Task Concurrency, Fibers, And Semaphores

When you need structured child tasks, background fiber handles, shared concurrency permits,
cooperative yielding, or lossless failure cause trees, use `ResultTask` together with `Fiber`,
`Semaphore`, `Cause`, and `Scheduler`:

```ts
import { Cause, Fiber, ResultTask, Scheduler, Semaphore } from "resultar";

const semaphore = Semaphore.make(2); // or ResultTask.makeSemaphore(2)

const workflow = ResultTask.scoped(
  ResultTask.gen(function* () {
    // Fork a child fiber owned by the enclosing scope:
    const background = yield* ResultTask.forkChild(
      semaphore.withPermit(ResultTask.sleep(10).as("indexed")),
    );

    // Run bounded collection work sharing the same semaphore:
    const items = yield* ResultTask.forEach(
      [1, 2, 3, 4],
      (item) => semaphore.withPermit(ResultTask.sync(() => item * 10)),
      { concurrency: "unbounded" },
    );

    const status = yield* Fiber.join(background);
    return { items, status };
  }),
).ensuring((exit) =>
  ResultTask.sync(() => {
    if (exit._tag === "Failure") {
      console.error(Cause.pretty(exit.cause));
    }
  }),
);

const result = await workflow.runResult({
  yieldEvery: 2,
  scheduler: Scheduler.live,
});
```

- **Fibers (`ResultTask.forkChild`, `task.runFork`, `Fiber`)**: `forkChild` starts a child
  fiber attached to the current `ResultTaskScope`; closing the scope interrupts and awaits any
  still-running children. `runFork` starts an independent root fiber and returns a `FiberHandle`
  supporting `.join()`, `.interrupt()`, `.poll()`, and `.addObserver(listener)`.
  Observe its full Exit with `Fiber.await(fiber)`; `Fiber.poll(fiber) === undefined` means it is running.
- **Semaphores (`Semaphore.make`, `ResultTask.makeSemaphore`)**: `withPermit` and `withPermits(n)`
  gate task execution across arbitrary fibers or collection workers and automatically release
  permits on `Success`, `Fail`, `Die`, or `Interrupt`.
- **Cooperative Yielding (`yieldEvery`, `scheduler`, `Scheduler`)**: pass `{ yieldEvery, scheduler }`
  in `ResultTaskRunOptions` (`task.runResult`, `runPromise`, `runExit`, `runFork`) to yield
  the worker back to the runtime `TaskScheduler` (`Scheduler.live` by default) every `N` steps so
  long-running pipelines can observe interruption signals and interleave with sibling fibers.
- **Causes, Sandboxing, and Finalizers (`Cause`, `catchCause`, `sandbox`, `unsandbox`, `ensuring`, `onExit`)**:
  `exit.cause` preserves `Fail`, `Die`, `Interrupt`, `Sequential` (e.g. body failure + finalizer
  failure), and `Parallel` (e.g. dual race failure or `validateAll`). Use `Cause.failures`,
  `Cause.defects`, `Cause.findError`, and `Cause.pretty` to inspect cause trees, or
  `task.sandbox()` / `task.catchCause(...)` to recover from composite causes inside the pipeline.

## Resourceful Async Iterables

For new resource lifetimes, use Task `acquireRelease` / `acquireDisposable` inside
`ResultTask.scoped`. Scope closure awaits release and preserves release failures in
the cause tree, including interruption paths. See [native resources](#native-disposable-resources).

### Deprecated Async resource compatibility

Use `ResultAsync.withResource` to preserve an existing eager acquire/use/release
contract. The helper starts acquisition eagerly, passes a `ResultAsyncAbortSignal`-compatible
signal to acquire and use, and always runs `release` after successful acquisition.

```ts
const fileResult = ResultAsync.withResource({
  acquire: (signal) => openFile(path, { signal }),
  use: (file, signal) => readFileContents(file, { signal }),
  release: (file) => file.close(),
});
```

The release callback is a finalizer. It may return `void`, a `Promise`, `Result`, or `ResultAsync`,
but failures from that callback are ignored so cleanup diagnostics do not replace the original
result. If cleanup failure must affect control flow, model cleanup explicitly inside the `use` step.

```ts
const imported = ResultAsync.withResource({
  acquire: (signal) => connectToWarehouse({ signal }),
  use: (connection, signal) =>
    importRows(connection, rows, { signal }).andThen((summary) =>
      closeAndAudit(connection).map(() => summary),
    ),
  release: (connection) => connection.close(),
});
```

For transactions, put commit in the `use` step and reserve `release` for best-effort rollback or
close behavior:

```ts
const created = ResultAsync.withResource({
  acquire: (signal) => db.beginTransaction({ signal }),
  use: (tx, signal) =>
    ResultAsync.forEach(users, (user) => insertUser(tx, user, { signal }), {
      concurrency: 4,
      discard: true,
    }).andThen(() => tx.commit({ signal })),
  release: (tx, context) => {
    if (context.result?.isErr()) {
      return tx.rollback();
    }

    return tx.close();
  },
});
```

If the provided signal is already aborted, acquisition is skipped and the result is an `AbortError`.
If the signal is aborted after acquisition but before the use step starts, the resource is released
and the result is an `AbortError`. During the use step, cancellation remains cooperative: pass the
signal to the underlying client and make that adapter close or roll back concrete resources when the
signal is observed.

For pull-based streams, Resultar does not add a stream runtime. Use native async iterables that
yield `Result<T, E>` values and release resources with `finally`:

```ts
async function* readLineResults(path: string): AsyncIterable<Result<string, FileError>> {
  const opened = await openFile(path);

  if (opened.isErr()) {
    yield err(opened.error);
    return;
  }

  const file = opened.value;

  try {
    for await (const line of file.lines()) {
      yield ok(line);
    }
  } catch (cause) {
    yield err(new FileReadError({ cause }));
  } finally {
    await file.close().catch(() => undefined);
  }
}
```

Consumers can stop on the first error or collect validation-like failures depending on the workflow:

```ts
for await (const line of readLineResults(path)) {
  if (line.isErr()) {
    return err(line.error)
  }

  processLine(line.value)
}
```

This covers the resourceful part of stream-shaped work without adding backpressure queues,
transducers, sinks or channels. Task scopes remain available for lazy resource ownership.

<a id="safe-try"></a>

## Result Generators

`Result.gen` gives you linear control flow when a chain of `andThen` calls becomes harder to read.

```ts
import { err, ok, Result } from "resultar";
import type { StrictResult } from "resultar";

const createUser = (email: string): StrictResult<User, CreateUserError> =>
  Result.gen(function* () {
    const validEmail = yield* validateEmail(email);
    const user = yield* insertUser(validEmail);

    return user;
  });
```

For new asynchronous workflows, prefer a synchronous Task generator whose steps
include Tasks. It stays lazy and repeatable until an explicit run:

```ts
const saveUser = (email: string) =>
  ResultTask.gen(function* () {
    const validEmail = yield* validateEmail(email);
    return yield* insertUserTask(validEmail);
  });

const result = await saveUser("person@example.com").runResult();
```

### Async Result generators for eager compatibility

`Result.gen` / `Result.fn` from `resultar` also support eager async bodies that yield Results
and `ResultAsync` values:

```ts
import { Result } from "resultar";

const saveUserLegacy = (email: string): StrictResultAsync<User, CreateUserError> =>
  Result.gen(async function* () {
    const validEmail = yield* validateEmail(email);
    const user = yield* insertUserAsync(validEmail);

    return user;
  });

const task = ResultTask.fromResultAsync(() => saveUserLegacy("person@example.com"));
```

The factory bridge creates a fresh eager workflow on each Task run. An existing
Async passed directly to the bridge is shared instead.

### Result generator error mapping and legacy safeTry

The object form lets you map unexpected throws from inside the generator:

```ts
class ParseConfigError extends Error {
  public constructor(public readonly cause: unknown) {
    super("parse config failed");
  }
}

const loadConfig = (raw: string) =>
  Result.gen({
    *try() {
      const input = yield* ok<string, string>(raw);

      return JSON.parse(input) as Config;
    },
    catch: (cause) => new ParseConfigError(cause),
  });
```

The object-form `catch` handles thrown exceptions from the generator body. It does not rewrite
yielded `Err` values:

```ts
const result = Result.gen({
  *try() {
    const raw = yield* err<string, string>("missing config");

    return JSON.parse(raw) as Config;
  },
  catch: (cause) => new ParseConfigError(cause),
});

// Err('missing config'), not ParseConfigError
result;
```

Prefer `yield* result`. `result.safeUnwrap()` remains callable with a deprecation annotation, but new code usually does
not need it.

`ResultAsync#safeUnwrap()` and `safeTryAsync()` are not public APIs. Inside
`Result.gen(async function* () { ... })`, use `yield* resultAsync`.

`Result.gen` / `Result.fn` accept synchronous and asynchronous generators with plain success returns.
A plain return is wrapped in Ok without inspecting the payload; use `yield*`
for final fallible steps or early errors. Returning a Result, Async or Task as a final
fallible step instead of delegating it is rejected by the modern signatures.

`safeTry` from `resultar` retains the legacy sync and async final-Result signatures and behavior
separately from modern `Result.gen`. Task workflows use `ResultTask.gen`, with no `ResultTask.safeTry` alias.
Object forms use `ResultGenOptions` / `SafeTryOptions` for sync bodies
and `AsyncResultGenOptions` / `SafeTryAsyncOptions` for async bodies.
`ResultGenerator`, `ResultAsyncGenerator`, `ResultTaskGenerator` and `ResultTaskYieldOf` are available from `resultar`.

An early yielded Err returns without closing a Result/Async generator, so `finally`
does not run on that path. `ResultTask.gen` closes its generator and executes yielded
cleanup tasks before completing.

## Conditional Helpers

Use conditional helpers when branching itself is part of a result pipeline.

`Result.if(condition, { onTrue, onFalse })` runs one branch and preserves the skipped branch:

```ts
const result = Result.if(input.enabled, {
  onTrue: () => validateEnabledInput(input),
  onFalse: () => ok({ status: "skipped" } as const),
});
```

The condition can be a boolean, a thunk, or a `Result<boolean, E>`. When the condition result is
`Err`, neither branch runs and the condition error is returned.

```ts
const result = Result.if(readFeatureFlag(), {
  onTrue: () => runEnabledFlow(),
  onFalse: () => runDisabledFlow(),
});
```

Use `when` and `unless` for optional work. A skipped branch returns `Ok(undefined)`. Across `Result`,
`ResultAsync`, and `ResultTask`, `when` and `unless` support direct, curried (`pipe`), and fluent
instance (`.when(condition)` / `.unless(condition)`) forms. All accept boolean predicates
and Result conditions; Async also accepts Async conditions, while Task accepts Task
conditions. Use the corresponding bridge when crossing execution models. Bodies may be
direct values or factories returning that model's Resultar values:

```ts
const maybeSaved = Result.when(input.shouldSave, () => saveInput(input));
const maybeValidated = Result.when(validateCanSave(input), () => saveInput(input));
const maybeSkipped = saveInput(input).unless(input.disabled);
```

`whenResult` and `unlessResult` remain available on `Result` and `ResultAsync` with their existing
signatures:

```ts
const maybeSaved = Result.whenResult(validateCanSave(input), () => saveInput(input));
```

`ResultAsync` and `ResultTask` provide the same conditional helpers (`if`, `when`, `unless`):

```ts
const result = ResultAsync.if(loadRemoteFlag(), {
  onTrue: () => saveInputAsync(input),
  onFalse: () => ok({ status: "skipped" } as const),
});
```

## Unwrapping Results

Prefer `match`, `matchTags`, `andThen`, or `Result.gen` in application code. Use unwrapping only at
tests, scripts, and final edges where throwing or defaulting is intentional.

Instance `unwrapOr(defaultValue)` selects the success value or the provided default. Result returns
it directly, Async returns a native Promise, and Task returns a lazy fold for `runPromise`.
Static `ResultAsync.unwrapOr` returns a composable Async value. At instance boundaries:

```ts
const port = parsePort(process.env.PORT ?? "").unwrapOr(3000);
const asyncPort = await loadPortTask().unwrapOr(3000).runPromise();
```

`unwrapOrThrow()` returns the success value or throws the error:

```ts
const user = await fetchUser("usr_123").unwrapOrThrow();
```

`_unsafeUnwrap()` and `_unsafeUnwrapErr()` are test helpers:

```ts
expect(ok(42)._unsafeUnwrap()).toBe(42);
expect(err("failed")._unsafeUnwrapErr()).toBe("failed");
```

## Validation Error Recipes

Keep validation errors as normal tagged errors. Convert validator-specific issue formats at the edge
of your adapter, then keep the rest of the application using one stable domain shape.

```ts
type ValidationIssue = {
  readonly message: string;
  readonly path: string;
};

class ValidationError extends createTaggedError({
  name: "ValidationError",
  message: "Invalid input",
}) {
  public readonly issues: readonly ValidationIssue[];

  public constructor(props: {
    readonly cause?: unknown;
    readonly issues: readonly ValidationIssue[];
  }) {
    super({ cause: props.cause });
    this.issues = props.issues;
  }
}
```

Use a tiny path normalizer at the adapter boundary:

```ts
const issueFromPath = (path: readonly (number | string)[], message: string): ValidationIssue => ({
  message,
  path: path.join("."),
});
```

For Zod:

```ts
const fromZodIssue = (issue: {
  readonly message: string;
  readonly path: readonly (number | string)[];
}): ValidationIssue => issueFromPath(issue.path, issue.message);
```

For Standard Schema-style issues:

```ts
const fromStandardIssue = (issue: {
  readonly message: string;
  readonly path?: readonly (number | string)[];
}): ValidationIssue => issueFromPath(issue.path ?? [], issue.message);
```

For schema libraries with formatted issue output, map that output into `ValidationIssue[]` in your
adapter. Resultar should not import validator packages directly.

```ts
const decodeInput = (input: unknown): StrictResult<DecodedInput, ValidationError> => {
  const decoded = decodeWithValidator(input);

  return decoded.isOk()
    ? ok(decoded.value)
    : err(new ValidationError({ cause: decoded.error, issues: decoded.error.issues }));
};
```

Use `combineWithAllErrors` or `validateAll` when several independent fields should all report
failures:

```ts
const validation = Result.combineWithAllErrors({
  email: validateEmail(input.email),
  name: validateName(input.name),
  password: validatePassword(input.password),
});
```

## Unexpected Errors

Expected application failures live in the `Err` channel. Unexpected bugs, impossible states, and
truly unrecoverable conditions stay as normal JavaScript throws or rejected promises unless you
intentionally convert them at a boundary.

Use Resultar wrappers only where uncontrolled code enters your system:

```ts
const parsed = tryResult(
  () => JSON.parse(input) as Config,
  (cause) => new ParseConfigError({ cause }),
);

const loaded = ResultTask.tryPromise({
  try: (signal) => fetch(url, { signal }),
  catch: (cause) => new FetchPayloadError({ cause, url }),
})
  .andThen((response) =>
    response.ok ? ok(response) : FetchPayloadStatusError.err({ status: response.status, url }),
  )
  .andThen((response) =>
    ResultTask.tryPromise({
      try: () => response.json() as Promise<Payload>,
      catch: (cause) => new ParsePayloadError({ cause, url }),
    }),
  );
```

For unrecoverable failures, throw normally:

```ts
const divide = (a: number, b: number): number => {
  if (b === 0) {
    throw new Error("Cannot divide by zero");
  }

  return a / b;
};
```

At a Task boundary, `runPromise` resolves success or rejects failure. Result and legacy
Async retain `unwrapOrThrow()` for their terminal conversion:

```ts
const user = await fetchUserTask("usr_123").runPromise();
```

For a custom conversion, run the Task and match its Result:

```ts
const user = (await fetchUserTask("usr_123").runResult()).match(
  (value) => value,
  (error) => {
    throw new Error("Could not fetch user", { cause: error });
  },
);
```

The object form of `Result.gen` can map unexpected throws from inside a linear generator:

```ts
const config = Result.gen({
  *try() {
    const raw = yield* readConfigFile();
    return JSON.parse(raw) as Config;
  },
  catch: (cause) => new ParseConfigError({ cause }),
});
```

In JavaScript applications, handle uncaught throws and rejected promises at the runtime edge: HTTP
server error handlers, worker/job supervisors, CLI top-level `try/catch`, test assertions, or
`Promise.catch`.

## Observation And Cleanup

Use side-effect helpers for best-effort observation:

- `inspect(fn)` runs only for `Ok`.
- `inspectError(fn)` runs only for `Err`.
- `inspectBoth(handlers)` runs the matching handler for `Ok` or `Err`.
- `log(fn)` runs for both states as `(value, error)`.

They preserve the original outcome and ignore callback errors across all three models,
without executing returned Tasks. Deprecated `Result` and `ResultAsync` `tap` / `tapError`
retain best-effort observation; prefer `inspect` / `inspectError`. Only Task `tap`,
`tapError`, `tapCause` and `tapBoth` compose fallible side operations, propagating their
errors and defects.

```ts
const observed = fetchUserTask("usr_123")
  .inspect((user) => metrics.increment("user.loaded", { id: user.id }))
  .inspectError((error) => metrics.increment("user.failed", { tag: error.name }))
  .log((user, error) => logger.info({ error, user }, "fetch user result"));
const result = await observed.runResult();
```

Callback errors are intentionally ignored. If callback failure should affect control flow, use
`andThen`, `orElse`, `tryResult`, or `ResultTask.tryPromise`. Existing eager flows
can continue to use `tryResultAsync`.

For Node.js 24 explicit resource management, use Task `acquireDisposable` in a scope.
Existing Result and Async boundaries also retain their best-effort disposable wrappers:

```ts
using result = findUser("usr_123").toDisposable((_user, _error) => {
  span.end();
});

await using asyncResult = fetchUser("usr_123").toAsyncDisposable(async (_user, _error) => {
  await span.end();
});
```

`Result#finally` and `ResultAsync#finally` are not part of the current API. Use `log` for immediate
side effects, `toDisposable` for `using`, and `toAsyncDisposable` for `await using`.
Use `ResultAsync.withResource` to preserve eager acquisition/use with best-effort release.
Use Task `acquireRelease` + `scoped` when release must be awaited and failures preserved.

## Callback Failure Semantics

Resultar makes a sharp distinction between transformation callbacks and observation callbacks.

Transformation callbacks are part of control flow:

- `map`
- `asyncMap`
- `mapErr`
- `andThen`
- `asyncAndThen`
- `orElse`
- `match`
- `catchTag`
- `catchTags`

On Task, a thrown transformation callback becomes a `Die` defect. `runExit` exposes
that cause as a value; `runResult` and `runPromise` can reject. Task `map` is synchronous:
it preserves a returned Promise as data, so use `andThen` plus `tryPromise` for an async step.

```ts
const exit = await ResultTask.ok(1)
  .map(() => {
    throw new Error("callback failed");
  })
  .runExit();
// Failure with Cause.Die
```

### Deprecated Async callback compatibility

On eager Async, a transformation callback that throws or rejects makes the outer
Promise reject. It does not become a typed `Err`:

```ts
await okAsync(1).map(() => {
  throw new Error("callback failed");
});
```

Observation callbacks are best-effort:

- `inspect`
- `inspectError`
- `log`
- `toDisposable`
- `toAsyncDisposable`

If those callbacks throw or reject, Resultar preserves the original result:

```ts
const result = await okAsync<number, Error>(1).inspect(() => {
  throw new Error("metrics failed");
});

result.isOk();
```

## No-Discard Validation

Resultar values should not be ignored. Use `resultar-check` to run the native TypeScript-Go compiler
and Resultar diagnostics through one command.

```sh
pnpm add -D resultar-check
```

Add a check script:

```json
{
  "scripts": {
    "check": "resultar-check"
  }
}
```

`resultar-check` defaults to `tsconfig.json` and runs TypeScript with no emit.

These fail in the default `must-use` mode:

```ts
saveUser(input);
const result = saveUser(input);
```

These are intentional:

```ts
return saveUser(input);
void saveUser(input);
saveUser(input).match(handleSaved, handleError);
```

The default mode is neverthrow-style `must-use`: it also reports assigned `Result` values that are
only passed around and never consumed with `match`, `unwrapOr`, `_unsafeUnwrap`, `isOk`, `isErr`,
returned, or explicitly discarded (including across `Promise<Result>` / `Promise.all(...).then(...)` and array `.map` / `.forEach` / `.flatMap` callbacks when the outer Promise or collection is consumed). Use `--mode direct` for the lower-noise expression-only check.

Configure Resultar rules in `tsconfig.json`:

```json
{
  "$schema": "./node_modules/resultar-check/schema.json",
  "compilerOptions": {
    "plugins": [
      {
        "name": "resultar-check",
        "ignoreFilePatterns": ["*.test.ts"],
        "noDiscard": "error"
      }
    ]
  }
}
```

The `compilerOptions.plugins` entry is configuration consumed by the native CLI and its stdio LSP
mode. Start `resultar-check lsp` from the editor's language-server configuration; no TypeScript
plugin installation is required.

The schema composes the standard [SchemaStore tsconfig schema](https://json.schemastore.org/tsconfig.json)
with Resultar configuration, preserving editor completion and validation for both TypeScript options
and Resultar rules. Resolving the standard schema requires editor access to SchemaStore or its cache.
Compiler compatibility is checked separately by TypeScript-Go; JSON Schema does not select or inherit
an installed TypeScript version.

### Task requirement safety

`ResultTask<T, E, R>` separates success `T`, expected errors `E`, and service/scope requirements `R`.
Safety diagnostics also inspect `R`:

| Rule                           | What it checks                                                                               | Default severity |
| ------------------------------ | -------------------------------------------------------------------------------------------- | ---------------- |
| `no-unknown-task-requirements` | Rejects `any` or `unknown` requirements, including type aliases.                             | `suggestion`     |
| `unsafe-result-type-assertion` | Rejects assertions that erase errors, services, or scope markers, including `as unknown as`. | `warning`        |
| `unused-suppression`           | Reports unknown IDs and unused suppression entries for enabled rules.                        | `suggestion`     |

Satisfy requirements through providers and scopes. Assertions must preserve required services and
pending release errors; a genuine `R = never` is valid. The existing assertion rule now identifies
whether a cast narrows `E`, `R`, or both.

### Unused suppression diagnostics

`unused-suppression` evaluates each entry against enabled findings before suppression filtering.
A directive with several rules can have just one unused entry. Wildcard directives are reported
when they suppress nothing, and removal fixes retain justification comments. Disabled rules do not
generate unused-entry warnings merely because they were not analyzed.

The new `noUnknownTaskRequirements` and `unusedSuppression` options default to `suggestion`.
The default `failOn: "message"` includes suggestions, so updating the checker can introduce new CI
failures. Adjust per-rule severities or the `failOn` threshold when adopting the rules gradually.

### Editor diagnostics and refactors

The LSP overlays all open project buffers, including new included files and unsaved changes in
imported dependencies. Changes are debounced for 150 ms; hover and code-action requests analyze the
latest accepted version immediately. Closing a buffer restores the disk-backed contents.

Hover shows `T`, `E`, and `R` separately for tasks, including `yield*` operands. `MatchMatcher` hover
shows the match input, remaining cases, and matched output. Service hover shows the identifier and
contract; `Result` and `ResultAsync` show their success/error channels.

Contextual refactors offer previews for generators that only delegate to an initialized constant
task, converting `(...args) => ResultTask.gen(...)` / `Result.gen(...)` into `ResultTask.fn` / `Result.fn`,
converting between `pipe(value, ...)` and `value.pipe(...)`, tag dispatch in recovery, and consecutive
`catchTag` calls. Unsafe candidates are declined, including generators with `finally` and earlier
handlers that could introduce a later handled error. Edits use UTF-16 ranges and document versions
so the editor can reject stale actions.

### Inspection commands

From a consuming project:

```sh
pnpm exec resultar-check overview --project tsconfig.json --json
pnpm exec resultar-check quickfixes --project tsconfig.json --file src/workflow.ts
pnpm exec resultar-check quickfixes --project tsconfig.json --json
```

`overview` inventories exported Resultar functions/values, tagged errors, and services. JSON output
is one document with `schemaVersion: 1`, sorted entries, declaration/export locations, type channels,
and service/tag details where applicable. Reexports retain their original declaration locations.

`quickfixes` previews diagnostics with proposed edits. Human output shows old/new snippets; JSON
output is JSONL with fix titles, kinds, explanations, and text edits. Contextual refactors remain
editor actions.

Both commands accept `--file`, `--format human|json`, and `--json`, and leave files unchanged.
They exit `0` after valid analysis even when fixes exist; configuration/compiler failures exit `1`.
Use the default `pnpm exec resultar-check --project tsconfig.json` command for the CI diagnostic gate.
See the [checker reference](packages/check/README.md#command-line) for configuration and exit policy.

## Testing Resultar Code

Use runtime assertions for behavior and type assertions for inference.

```ts
import { equal, ok as assertOk } from "node:assert";
import { describe, expectTypeOf, it } from "vite-plus/test";
import { createTaggedError, ok } from "resultar";
import type { StrictResult } from "resultar";

class InvalidEmailError extends createTaggedError({
  name: "InvalidEmailError",
  message: "Invalid email $email",
}) {}

const validateEmail = (email: string): StrictResult<string, InvalidEmailError> =>
  email.includes("@") ? ok(email) : InvalidEmailError.err({ email });

describe("validateEmail", () => {
  it("returns tagged errors", () => {
    const result = validateEmail("bad");

    assertOk(result.isErr());
    expectTypeOf(result.error).toEqualTypeOf<InvalidEmailError>();
    equal(result.error._tag, "InvalidEmailError");
  });
});
```

Use `// @ts-expect-error` for intentional negative type tests:

```ts
import { err } from "resultar";

if (false) {
  // @ts-expect-error StrictResult error types must extend Error.
  const invalid: StrictResult<number, string> = err("invalid");

  JSON.stringify(invalid);
}
```

Use `_unsafeUnwrap()` and `_unsafeUnwrapErr()` in tests when direct values make the assertion
clearer. Avoid them in application code.

## API Decision Guide

Use this as the first stop when choosing an operation:

| Need                                                 | Use                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| Create a sync success                                | `ok(value)`                                                         |
| Create a sync failure                                | `err(error)` or `ErrorClass.err(props)`                             |
| Create an async success                              | `ResultTask.ok(value)`                                              |
| Create an async failure                              | `ResultTask.err(error)` / `ErrorClass.taskErr(props)`               |
| Create an `Ok(undefined)`                            | `unit()` / `ResultTask.ok(undefined)`                               |
| Convert a throwing sync function now                 | `tryResult(fn, toError?)`                                           |
| Convert a throwing sync function with named handlers | `tryResult({ try, catch })`                                         |
| Convert a throwing function for later use            | `fromThrowable(fn, toError?)`                                       |
| Preserve an existing eager Promise execution         | `tryResultAsync(promise, toError?)` (compatibility)                 |
| Preserve an existing eager Async boundary            | `fromPromise(promise, toError)` (compatibility)                     |
| Preserve an infallible eager Promise boundary        | `fromSafePromise(promise)` (compatibility)                          |
| Convert a Promise factory that may throw             | `ResultTask.tryPromise({ try, catch })`                             |
| Convert a reusable async function                    | Return `ResultTask.tryPromise({ try, catch })` from a function      |
| Reject a Task failure at an edge                     | `task.runPromise()`                                                 |
| Transform an `Ok` value                              | `map(fn)`                                                           |
| Replace an `Ok` value                                | `as(value)`                                                         |
| Transform an `Err` value                             | `mapErr(fn)`                                                        |
| Validate an `Ok` value                               | `filterOrElse(predicate, onFalse)`                                  |
| Continue with sync fallible work                     | `andThen(fn)`                                                       |
| Continue from sync to async fallible work            | `ResultTask.gen` / `ResultTask.fromResult(result).andThen(fn)`      |
| Recover from an error                                | `orElse(fn)`                                                        |
| Replace an error with another error                  | `mapErr(fn)` or `orElse(() => err(newError))`                       |
| Replace an error with success                        | `orElse(() => ok(defaultValue))`                                    |
| Recover one tagged error locally                     | `catchTag(tag, fn)`                                                 |
| Recover several tagged errors locally                | `catchTags(handlers)`                                               |
| Recover one nested tagged reason                     | `catchReason(parentTag, reasonTag, fn)`                             |
| Recover several nested tagged reasons                | `catchReasons(parentTag, handlers)`                                 |
| Move nested reasons into the error channel           | `unwrapReason(parentTag)`                                           |
| Handle a simple boundary                             | `match(okFn, errFn)`                                                |
| Handle a simple boundary with named handlers         | `match({ ok, error })`                                              |
| Handle every tagged boundary error                   | `matchTags(okFn, handlers)`                                         |
| Handle selected boundary errors                      | `matchTagsPartial(okFn, handlers, fallback)`                        |
| Write linear result code                             | Sync: `Result.gen`; async: `ResultTask.gen` / `fn`                  |
| Map unexpected throws inside linear code             | `Result.gen({ try, catch })`                                        |
| Run one of two result branches                       | `Result.if` / `ResultTask.if`                                       |
| Run optional work                                    | `when`, `unless`, `whenResult`, `unlessResult`                      |
| Combine two independent results                      | `zip`                                                               |
| Combine many independent results                     | `all`, `combine`, `combineWithAllErrors`                            |
| Combine named independent results                    | `all({ key: result })` or `combine({ key: result })`                |
| Collect all validation failures                      | `validateAll` or `combineWithAllErrors`                             |
| Try fallback candidates                              | `firstSuccessOf`                                                    |
| Bound lazy async traversal                           | `ResultTask.forEach(items, fn, { concurrency })`                    |
| Bound lazy async validation                          | `ResultTask.validateAll(items, fn, { concurrency })`                |
| Race two async tasks for first success               | `ResultTask.race(left, right)`                                      |
| Preserve an eager multi-provider race                | `ResultAsync.raceAll(factories)` (compatibility)                    |
| Race two async tasks for first completion            | `ResultTask.raceFirst(left, right)`                                 |
| Preserve a custom eager race policy                  | `ResultAsync.raceWith(left, right, handlers)` (compatibility)       |
| Add a cooperative timeout                            | `task.timeout(ms, onTimeout)`                                       |
| Retry transient async work                           | `task.retry(Retry.policy(...))`             |
| Recover after retry exhaustion                       | `task.retry(policy).orElse(fallback)`                               |
| Pair async acquisition with cleanup                  | `ResultTask.acquireRelease` + `ResultTask.scoped`                   |
| Detect abort-shaped failures                         | `isAbortError(value)`                                               |
| Create lightweight tagged unions                     | `taggedEnum<Members>()`                                             |
| Redact secrets from error output                     | `redact(value, label?)`                                             |
| Loop without throwing                                | `loop`, `iterate`, `forEach`                                        |
| Throw intentionally at an edge                       | Result: `unwrapOrThrow()`; Task: `task.runPromise()`                |
| Default intentionally at an edge                     | Result: `unwrapOr(value)`; Task: `task.unwrapOr(value).runPromise()` |
| Add observation without changing the result          | `inspect`, `inspectError`, `inspectBoth`, `log`                     |

## Combining And Iterating

Result collections compute synchronous values; Task collections describe new async
workflows. The Async examples below are retained eager compatibility references.

### ResultTask Collections And Loops

`ResultTask` provides lazy, scope-aware collection and loop operators that preserve service
requirements (`R`) and interrupt in-flight siblings on fail-fast errors:

```ts
import { ResultTask } from "resultar";

// Record or tuple combination (sequential by default; pass { concurrency: n | "unbounded" })
const dashboard = ResultTask.all(
  {
    profile: loadProfile(userId),
    orders: loadRecentOrders(userId),
    quotas: loadQuotas(userId),
  },
  { concurrency: 2 },
);

// Pair two tasks concurrently
const pair = loadProfile(userId).zip(loadQuotas(userId), { concurrent: true });

// Lazy bounded traversal (fail-fast: interrupts active siblings and awaits finalizers on first Err)
const synced = ResultTask.forEach(accounts, (account, index) => syncAccount(account, index), {
  concurrency: 4,
}).asVoid();

// Accumulated validation (runs every item and collects all Err values in input order)
const validated = ResultTask.validateAll(rows, (row, index) => validateRowTask(row, index), {
  concurrency: 8,
});

// Sequential fallback across lazy candidate tasks
const resolvedConfig = ResultTask.firstSuccessOf([
  loadRemoteConfig(),
  loadCachedConfig(),
  loadDefaultConfigTask(),
]);

// Lazy stateful loops
const pages = ResultTask.loop(
  { cursor: 0, items: [] as string[] },
  {
    while: (state) => state.cursor < 3,
    step: (state) => ({ ...state, cursor: state.cursor + 1 }),
    body: (state) => ResultTask.ok(`page:${state.cursor + 1}`),
  },
);

const finalCursor = ResultTask.iterate(0, {
  while: (cursor) => cursor < 3,
  body: (cursor) => ResultTask.ok(cursor + 1),
});
```

### Result and deprecated Async collection reference

Use collection helpers when the shape of the workflow matters more than the individual steps.

#### `zip`

`Result.zip(left, right)` combines exactly two independent results. It returns an `Ok` tuple when
both succeed, or the first error when either fails.

```ts
const paired = Result.zip(validateEmail(email), validateName(name));
```

`ResultAsync.zip(left, right)` does the same for async results:

```ts
const paired = await ResultAsync.zip(loadUser(id), loadPermissions(id));
```

#### `all` / `combine`

`Result.all(results)` and `Result.combine(results)` turn many results into one result. They return `Ok` with a tuple/list of
success values when every result succeeds, or the first error when any result fails.

```ts
const combined = Result.all([validateEmail(email), validateName(name)]);

const payload = combined.match(
  ([email, name]) => ({ email, name }),
  (error) => ({ error }),
);
```

It preserves array values as values; it does not flatten nested arrays:

```ts
const combined = Result.combine([ok(["a", "b"]), ok([1, 2])]);

// Ok<[string[], number[]]>
combined;
```

`ResultAsync.all(results)` and `ResultAsync.combine(results)` do the same for async results:

```ts
const combined = await ResultAsync.all([loadUser(id), loadPermissions(id)]);
```

`all` and `combine` also accept records. Use this when the result names matter more than tuple positions:

```ts
const context = Result.all({
  org: loadOrg(orgId),
  user: loadUser(userId),
});

const response = context.match(
  ({ org, user }) => ({ orgId: org.id, userId: user.id }),
  (error) => ({ error: error.message }),
);
```

The async version preserves the same record shape:

```ts
const context = await ResultAsync.all({
  org: loadOrgAsync(orgId),
  user: loadUserAsync(userId),
});
```

For non-array iterables, `all` and `combine` return a readonly array of success values:

```ts
const values = Result.all(new Set([parseNumber("1"), parseNumber("2")]));
// Result<readonly number[], ParseNumberError>
```

#### `combineWithAllErrors`

`Result.combineWithAllErrors(results)` collects all errors.

```ts
const validation = Result.combineWithAllErrors([
  validateEmail(input.email),
  validateName(input.name),
  validatePassword(input.password),
]);

const response = validation.match(
  ([email, name, password]) => ({ email, name, password }),
  (errors) => ({ errors: errors.map((error) => error.message) }),
);
```

Use `combine` when the first failure is enough. Use `combineWithAllErrors` when the caller needs a
complete validation report.

Record inputs are useful for form and command validation because the output keeps field names:

```ts
const validation = Result.combineWithAllErrors({
  email: validateEmail(input.email),
  name: validateName(input.name),
  password: validatePassword(input.password),
});

const response = validation.match(
  (valid) => createUser(valid),
  (errors) => ({ errors: errors.map((error) => error.message) }),
);
```

#### `validateAll`

`Result.validateAll(results)` is the validation-focused name for `combineWithAllErrors`.

```ts
const validation = Result.validateAll([
  validateEmail(input.email),
  validateName(input.name),
  validatePassword(input.password),
]);
```

Use `Result.validateAll(items, fn)` when the inputs are a collection:

```ts
const validation = Result.validateAll(input.items, (item) => validateLineItem(item));
```

`ResultAsync.validateAll(results)` provides the same shape for already-created async validations.
Use `ResultAsync.validateAll(items, fn, options?)` to start optionally bounded validation
eagerly. For a lazy, repeatable workflow, use `ResultTask.validateAll`:

```ts
const validation = ResultAsync.validateAll(input.items, (item) => validateLineItemAsync(item), {
  concurrency: 4,
});
```

The async mapped form defaults to sequential execution. With `{ concurrency: n }`, it starts at most
`n` validations at a time. With `{ concurrency: "unbounded" }`, it starts every mapped validation
immediately. Success values and collected errors preserve input order.

#### `firstSuccessOf`

`Result.firstSuccessOf(candidates)` tries candidates sequentially until one succeeds. It does not
call later candidates after the first success.

```ts
const config = Result.firstSuccessOf([
  () => readConfigFromEnv(),
  () => readConfigFromFile(),
  () => readDefaultConfig(),
]);
```

If every candidate fails, it returns the last error. If the candidate collection is empty, the sync
version throws and the async version rejects with an `IllegalArgumentException`.

```ts
const user = await ResultAsync.firstSuccessOf([
  () => readUserFromCache(id),
  () => readUserFromDatabase(id),
  () => readUserFromReplica(id),
]);
```

#### `loop`

`Result.loop(initial, options)` is a result-aware `while` loop. It collects body values by default,
stops on the first `Err`, and skips the body when the initial condition is false.

```ts
const doubled = Result.loop(1, {
  while: (state) => state <= 3,
  step: (state) => state + 1,
  body: (state) => ok<number, string>(state * 2),
});

// Ok([2, 4, 6])
doubled;
```

Use `discard: true` for side-effect loops where the collected values are not needed:

```ts
const visited = Result.loop(1, {
  while: (state) => state <= 3,
  step: (state) => state + 1,
  body: (state) => writeAuditEvent(state),
  discard: true,
});

// Ok(undefined)
visited;
```

#### `iterate`

`Result.iterate(initial, options)` repeatedly transforms state and returns the final state:

```ts
const finalCursor = Result.iterate(0, {
  while: (cursor) => cursor < 10,
  body: (cursor) => ok<number, string>(cursor + 1),
});
```

Use it when each step returns the next state. Use `loop` when each step returns a value that should
be collected separately from the loop state.

#### `forEach`

`Result.forEach(iterable, fn, options?)` processes sync items sequentially, passes `(value, index)`,
and collects success values by default.

```ts
const parsed = Result.forEach(["1", "2", "3"], (value, index) =>
  parseNumber(value).map((number) => ({ index, number })),
);
```

It stops on the first error and does not call later items. `ResultAsync.forEach` defaults to the
same sequential behavior, but also accepts `{ concurrency: n }` or `{ concurrency: "unbounded" }` for
eagerly started async traversal.

Use `{ discard: true }` when the callback is only needed for effects:

```ts
const saved = ResultAsync.forEach(users, (user, index) => saveUser(user, index), {
  concurrency: 4,
  discard: true,
});
```

For loops and collections, use:

- `Result.loop(initial, options)`
- `Result.iterate(initial, options)`
- `Result.forEach(iterable, fn, options?)`
- `ResultAsync.loop(initial, options)`
- `ResultAsync.iterate(initial, options)`
- `ResultAsync.forEach(iterable, fn, options?)`
- `ResultTask.loop(initial, options)`
- `ResultTask.iterate(initial, options)`
- `ResultTask.forEach(iterable, fn, options?)`
- `ResultTask.all(tasks, options?)`
- `ResultTask.validateAll(tasksOrItems, fnOrOptions?, options?)`

`ResultAsync.loop` and `ResultAsync.iterate` run sequentially. `ResultAsync.forEach` runs
sequentially by default, can be bounded with `{ concurrency: n }`, and short-circuits scheduling on
the first `Err` while waiting for already-started work to settle.

## Coming From Other Styles

### From try/catch

Use `tryResult` for synchronous edges and `ResultTask.tryPromise` for new asynchronous
edges: JSON parsing, platform APIs, third-party libraries, I/O and network calls.
`tryResultAsync` remains available when preserving an eager compatibility boundary.

```ts
class ParseConfigError extends createTaggedError({
  name: "ParseConfigError",
  message: "Could not parse config",
}) {}

const parseConfig = (input: string): StrictResult<Config, ParseConfigError> =>
  tryResult(
    () => JSON.parse(input) as Config,
    (cause) => new ParseConfigError({ cause }),
  );
```

After that edge conversion, keep your own domain functions returning `Result` values instead of
throwing expected failures.

### From neverthrow-style wrappers

Resultar keeps the explicit wrapper model, but the current major line leans into Resultar-specific tagged errors,
strict service-boundary aliases, and ESM-only packaging.

Use `.value` only after `isOk()` and `.error` only after `isErr()`, or prefer `match` and
`matchTags` at boundaries.

### From raw `T | Error`

Raw unions are concise, but they rely on the convention that a successful value is never an `Error`
instance. Resultar keeps success and failure structurally separate, so `Ok<Error>` is still a valid
success value when a domain needs it.

### From Application Runtimes

Resultar keeps the scope narrow: explicit error values, typed expected failures, and composable
recovery. Choose it when you want those pieces without adopting a full application runtime.

## What Stays Out Of Core

Resultar keeps explicit error values and a small lazy task runtime. `Result`, `ResultTask`, in-flight `ResultAsync`, and deprecated eager `ResultAsync` orchestration APIs are exported from `resultar`, independently of task services, scopes, fibers and clocks.

- No application framework, platform layer, `Stream`, STM, clustering, or RPC runtime.
- No `Layer` system in core; optional service graph composition belongs to `resultar-di`.
- No general scheduling algebra; portable retry uses a small `Retry.policy` configuration contract.
- No implicit global runtime or detached child work: each run owns a scope and its children.
- No preemptive cancellation of JavaScript or drivers that ignore their `AbortSignal`.
- No raw `Error | T` conversion API.

Task races and timeouts interrupt losing children and await their cleanup. ResultAsync keeps
its existing eager policies and best-effort resource release. Choose the execution model that
matches the operation's ownership and lifetime. Detaching a promise wait can leave external work
running; it does not create a detached task fiber or transfer scope ownership.

## Public Entry Point

Import core helpers, in-flight `ResultAsync`, and eager compatibility exports from `resultar`:

```ts
import {
  AbortError,
  Cause,
  Clock,
  Fiber,
  Match,
  Retry,
  Scheduler,
  Semaphore,
  VirtualClock,
  Result,
  ResultAsync,
  ResultTask,
  createTaggedError,
  err,
  errAsync,
  findCause,
  fromCallback,
  fromPromise,
  fromSafePromise,
  fromThrowable,
  fromThrowableAsync,
  isAbortError,
  isError,
  isRedacted,
  isServiceTag,
  matchError,
  matchErrorPartial,
  ok,
  okAsync,
  redact,
  revealRedacted,
  runPromise,
  runSync,
  safeTry,
  serviceTag,
  taggedEnum,
  tryResult,
  tryResultAsync,
  unit,
  unitAsync,
} from "resultar";

import type {
  TaskClock,
  TaskScheduler,
  RetryContext,
  RetryPolicy,
  RetryPolicyOptions,
  ResultAsyncGenerator,
  ResultGenerator,
  ResultTaskGenerator,
  ResultTaskYieldOf,
  ResultTaskConcurrencyOptions,
  ResultTaskYieldable,
  ResultTaskZipOptions,
  DisposableResult,
  DisposableResultAsync,
  ErrResult,
  OkResult,
  Redacted,
  ResultAsyncAbortSignal,
  ResultAsyncConcurrency,
  ResultAsyncRaceHandle,
  ResultAsyncRaceTask,
  ResultAsyncTimeoutOptions,
  ResultOperations,
  StrictResult,
  StrictResultAsync,
  TaggedEnum,
  TaggedEnumFactory,
  TaggedErrorClass,
  TaggedErrorInstance,
  TaggedErrorOptions,
} from "resultar";
```

Core `tryResult`, `try` and the default export are the same synchronous helper;
`tryCatch` remains its deprecated alias. Core `Result.gen` / `Result.fn` support sync and async
bodies with modern plain returns; `safeTry` supports both forms with final-Result returns.

`tryResultAsync` is the active in-flight constructor; `tryAsync` and `tryCatchAsync` retain their
deprecated eager alias behavior. `ResultAsync.fromTask(task)` eagerly starts one Task run;
static/instance `ResultTask.toResultAsync` and tagged `.errAsync` methods also remain supported.
Prefer `errAsync(new DomainError(props))` in new eager recipes.

`Result#finally`, `ResultAsync#finally`, `ResultAsync#safeUnwrap` and `safeTryAsync`
remain absent. Use observers, disposables and compatibility `safeTry(async function* () {})`
where an existing eager contract requires them.

## API Map

### Function helpers

- `pipe(value, ...transforms)`
- `flow(first, ...transforms)`
- `identity(value)`
- `constant(value)`

### ResultTask function and resource helpers

- `ResultTask.ok(value)`
- `ResultTask.err(error)`
- `ResultTask.fn(generator, ...ops)`
- `ResultTask.gen(generator)`
- `ResultTask.mapErr(task, mapper)` / `ResultTask.mapErr(mapper)(task)`
- `ResultTask.andThen(task, next)` / `ResultTask.andThen(next)(task)`
- `ResultTask.orElse(task, recover)` / `ResultTask.orElse(recover)(task)`
- `ResultTask.orElseSucceed(task, recover)` / `ResultTask.orElseSucceed(recover)(task)`
- `ResultTask.unwrapOr(task, defaultValue)` / `ResultTask.unwrapOr(defaultValue)(task)`
- `task.catchCause(onCause)` / `ResultTask.catchCause(task, onCause)` / `ResultTask.catchCause(onCause)(task)`
- `task.sandbox()` / `ResultTask.sandbox(task)` / `ResultTask.sandbox()`
- `task.unsandbox()` / `ResultTask.unsandbox(task)` / `ResultTask.unsandbox()`
- `task.match({ ok, err })` / `task.match(onOk, onErr)`
- `task.matchTags(okFn, handlers)` / `task.matchTagsPartial(okFn, handlers, fallback)`
- `task.inspect(observer)` / `task.inspectError(observer)` / `task.inspectCause(observer)` / `task.inspectBoth(handlers)` (best-effort)
- `ResultTask.inspectCause(task, observer)` / `ResultTask.inspectCause(observer)(task)`
- `ResultTask.inspectBoth(task, handlers)` / `ResultTask.inspectBoth(handlers)(task)`
- `task.tap(fn)` / `task.tapError(fn)` / `task.tapCause(fn)` / `task.tapBoth(handlersOrOnOk, onErr?)` (effectful)
- `ResultTask.tapCause(task, fn)` / `ResultTask.tapCause(fn)(task)`
- `ResultTask.tapBoth(task, handlersOrOnOk, onErr?)` / `ResultTask.tapBoth(handlersOrOnOk, onErr?)(task)`
- `task.catchTag(tag, handler)`
- `task.catchTags(handlers)`
- `task.catchReason(parentTag, reasonTag, handler)`
- `task.catchReasons(parentTag, handlers)`
- `task.unwrapReason(parentTag)`
- `ResultTask.catchTag(task, tag, handler)` / `ResultTask.catchTag(tag, handler)(task)`
- `ResultTask.catchTags(task, handlers)` / `ResultTask.catchTags(handlers)(task)`
- `ResultTask.catchReason(task, parentTag, reasonTag, handler)` / `ResultTask.catchReason(parentTag, reasonTag, handler)(task)`
- `ResultTask.catchReasons(task, parentTag, handlers)` / `ResultTask.catchReasons(parentTag, handlers)(task)`
- `ResultTask.unwrapReason(task, parentTag)` / `ResultTask.unwrapReason(parentTag)(task)`
- `ResultTask.acquireDisposable(acquireTask)`
- `ResultTask.acquireRelease(options)`
- `ResultTask.scoped(task)`
- `task.ensuring(finalizer)` / `ResultTask.ensuring(task, finalizer)` / `ResultTask.ensuring(finalizer)(task)`
- `task.onExit(cleanup)` / `ResultTask.onExit(task, cleanup)` / `ResultTask.onExit(cleanup)(task)`
- `task.delay(milliseconds)` / `ResultTask.delay(task, milliseconds)` / `ResultTask.delay(milliseconds)(task)`
- `task.timed()` / `ResultTask.timed(task)` / `ResultTask.timed()`
- `task.asVoid()` / `ResultTask.asVoid(task)` / `ResultTask.asVoid()`
- `task.zip(right, options?)` / `ResultTask.zip(left, right, options?)` / `ResultTask.zip(right, options?)(left)`
- `ResultTask.makeSemaphore(permits)` / `Semaphore.make(permits)` / `Semaphore.withPermit` / `Semaphore.withPermits`
- `ResultTask.firstSuccessOf(candidates)`
- `ResultTask.if(condition, { onTrue, onFalse })` / `ResultTask.if({ onTrue, onFalse })(condition)`
- `task.when(condition)` / `ResultTask.when(condition, body)` / `ResultTask.when(condition)(task)`
- `task.unless(condition)` / `ResultTask.unless(condition, body)` / `ResultTask.unless(condition)(task)`
- `ResultTask.loop(initial, options)` / `ResultTask.loop(options)(initial)`
- `ResultTask.iterate(initial, options)` / `ResultTask.iterate(options)(initial)`
- `ResultTask.tryPromise({ try, catch, interruption: 'wait' | 'detach' })`
- `task.runResult(options?)` / `ResultTask.runResult(task, options?)` returns `ResultAsync<T, E | ScopeError<R>>`
- `task.runPromise(options?)` / `ResultTask.runPromise(task, options?)` returns `Promise<T>`
- `task.runExit(options?)` / `ResultTask.runExit(task, options?)` returns `Promise<Exit<T, E>>`
- `task.runFork(options?)` / `ResultTask.runFork(task, options?)` returns a running native `FiberHandle`
- `Fiber.join(fiber, options?)`, `Fiber.await(fiber)`, `Fiber.interrupt(fiber)`
- Native fiber `id`, `Fiber.poll(fiber)` and `Fiber.addObserver(fiber, callback)`
- Run options `yieldEvery` / `scheduler: TaskScheduler`; `Scheduler.live` is the default dispatcher
- `Retry.policy(options)` for shared ResultAsync / ResultTask retry configuration

See the [core task reference](packages/resultar/README.md#lazy-workflows-with-resulttask) for the full
execution, services, and composition API.

### Cause helpers

`Cause` is available as both a runtime namespace and the existing `Cause<E>` type:

- `Cause.isCause(value)` narrows runtime values to `Cause<unknown>`.
- `Cause.hasFails(cause)` checks for typed failures anywhere in the tree.
- `Cause.hasDies(cause)` checks for defects.
- `Cause.hasInterrupts(cause)` checks for interruptions.
- `Cause.failures(cause)` collects all `Fail` errors in left-to-right order.
- `Cause.defects(cause)` collects all `Die` defects in left-to-right order.
- `Cause.findError(cause)` returns `Result<E, Cause<never>>`, selecting the first typed error
  in left-to-right order. When none exists, its `Err` retains the original tree by identity.
- `Cause.pretty(cause)` renders each leaf with its kind in the same order, retaining Error
  stacks and handling circular payloads and JSON redaction. Formatting is diagnostic text.

Traversal is iterative and preserves repeated leaves, `Sequential` and `Parallel` structures.
These helpers do not execute tasks or change `runExit`, `runResult`, or `runPromise` behavior.
`findCause(error, ErrorClass)` remains the helper for a JavaScript Error's own cause chain.

### Result helpers

- `ok(value)`
- `err(error)`
- `unit()`
- `tryResult(fn, toError?)`
- `tryResult({ try, catch? })`
- `try(fn, toError?)` (deprecated alias)
- `tryCatch(fn, toError?)` (deprecated alias)
- `fromThrowable(fn, toError?)`
- `Result.gen(generator)`
- `Result.gen({ try, catch? })`
- `Result.fn(generator, ...ops)`
- `safeTry(generator)` / `safeTry({ try, catch? })` (separate deprecated helper, original final-Result signatures and behavior)
- `redact(value, label?)`
- `isRedacted(value)`
- `revealRedacted(value)`
- `StrictResult<T, E extends Error>`

### Result methods

- `isOk()`
- `isErr()`
- `map(fn)`
- `asyncMap(fn)`
- `as(value)`
- `asVoid()`
- `mapErr(fn)`
- `filterOrElse(predicate, onFalse)`
- `when(condition)`
- `unless(condition)`
- `andThen(fn)`
- `asyncAndThen(fn)`
- `orElse(fn)`
- `orElseSucceed(fn)`
- `catchTag(tag, fn)`
- `catchTags(handlers)`
- `catchReason(parentTag, reasonTag, fn)`
- `catchReasons(parentTag, handlers)`
- `unwrapReason(parentTag)`
- `match(okFn, errFn)`
- `matchTags(okFn, handlers)`
- `matchTagsPartial(okFn, handlers, fallback)`
- `pipe(fn, ...)`
- `inspect(fn)`
- `inspectError(fn)`
- `inspectBoth(handlers)`
- `tap(fn)` / `tapError(fn)` (deprecated; same best-effort observation)
- `log(fn)`
- `toDisposable(fn)`
- `unwrapOr(defaultValue)`
- `unwrapOrThrow()`
- `_unsafeUnwrap()`
- `_unsafeUnwrapErr()`
- `safeUnwrap()` (deprecated; prefer `yield* result`)

### Result static methods

- `Result.ok(value)`
- `Result.err(error)`
- `Result.unit()`
- `Result.asyncMap(result, fn)` / `Result.asyncMap(fn)(result)`
- `Result.asyncAndThen(result, fn)` / `Result.asyncAndThen(fn)(result)`
- `Result.asVoid(result)` / `Result.asVoid()`
- `Result.try(fn, toError?)` / `Result.try({ try, catch? })`
- `Result.tryCatch(fn, toError?)` (deprecated alias)
- `Result.fromThrowable(fn, toError?)`
- `Result.fromNullishOr(value, onNullish)` / `Result.fromNullishOr(onNullish)(value)`
- `Result.liftPredicate(value, predicateOrRefinement, onFalse)`
- `Result.liftPredicate(predicateOrRefinement, onFalse)(value)`
- `Result.orElseSucceed(result, fn)` / `Result.orElseSucceed(fn)(result)`
- `Result.unwrapOr(result, defaultValue)` / `Result.unwrapOr(defaultValue)(result)`
- `Result.catchReason(result, parentTag, reasonTag, fn)` / `Result.catchReason(parentTag, reasonTag, fn)(result)`
- `Result.catchReasons(result, parentTag, handlers)` / `Result.catchReasons(parentTag, handlers)(result)`
- `Result.unwrapReason(result, parentTag)` / `Result.unwrapReason(parentTag)(result)`
- `Result.zip(left, right)`
- `Result.all(results)` / `Result.all(record)` / `Result.all(iterable)`
- `Result.combine(results)`
- `Result.combine(record)`
- `Result.combine(iterable)`
- `Result.combineWithAllErrors(results)`
- `Result.combineWithAllErrors(record)`
- `Result.combineWithAllErrors(iterable)`
- `Result.validateAll(results)`
- `Result.validateAll(iterable, fn)`
- `Result.firstSuccessOf(candidates)`
- `Result.if(condition, { onTrue, onFalse })`
- `Result.when(condition, body)` / `Result.when(condition)(result)`
- `Result.whenResult(conditionResult, body)`
- `Result.unless(condition, body)` / `Result.unless(condition)(result)`
- `Result.unlessResult(conditionResult, body)`
- `Result.loop(initial, options)`
- `Result.iterate(initial, options)`
- `Result.forEach(iterable, fn, options?)`

<a id="resultasync-helpers"></a>

### ResultAsync helpers

In-flight `ResultAsync` constructors (`okAsync`, `errAsync`, `unitAsync`, `fromPromise`, `fromSafePromise`, `tryResultAsync`) and deprecated eager compatibility helpers (`fromCallback`, `fromThrowableAsync`, `tryAsync`, `tryCatchAsync`, `safeTry`, `runPromise`) are exported from `resultar`; prefer `ResultTask` for new async workflows.

- `safeTry(body)` / object form (deprecated; legacy sync and async final-Result bodies)
- `runPromise(resultAsync)` (deprecated)
- `AsyncResultGenOptions`, `ResultAsyncGenerator`, `SafeTryAsyncOptions`
- `okAsync(value)`
- `errAsync(error)`
- `unitAsync()`
- `fromPromise(promise, toError)`
- `fromSafePromise(promise)`
- `fromCallback(options)` (deprecated)
- `fromThrowableAsync(fn, toError?)` (deprecated)
- `tryResultAsync(promiseOrFactory, toError?)`
- `tryResultAsync({ try, catch? })`
- `tryAsync(promiseOrFactory, toError?)` (deprecated alias)
- `tryCatchAsync(promiseOrFactory, toError?)` (deprecated alias)
- `AbortError`
- `isAbortError(value)`
- `StrictResultAsync<T, E extends Error>`
- `ResultAsyncAbortSignal`
- `ResultAsyncConcurrency`
- `ResultAsyncRaceTask<T, E>`
- `ResultAsyncRaceHandle<T, E>`
- `ResultAsyncTimeoutOptions<E>`
- `ResultAsyncRetryContext`
- `ResultAsyncRetryTask<T, E>`
- `ResultAsyncRetryOptions<E>`
- `ResultAsyncRetryOrElseOptions<E, F, U>`

<a id="resultasync-methods"></a>

### ResultAsync methods

`ResultAsync` is the active in-flight `Result` (`PromiseLike<Result<T, E>>`). `map` / `mapErr` await Promise-returning callbacks; `filterOrElse` supports async
callbacks. `match`, `matchTags`, `matchTagsPartial`, and `unwrapOr` return native
Promises containing the unwrapped output.

- `map(fn)`
- `as(value)`
- `asVoid()`
- `mapErr(fn)`
- `when(condition)`
- `unless(condition)`
- `andThen(fn)`
- `orElse(fn)`
- `orElseSucceed(fn)`
- `catchTag(tag, fn)`
- `catchTags(handlers)`
- `catchReason(parentTag, reasonTag, fn)`
- `catchReasons(parentTag, handlers)`
- `unwrapReason(parentTag)`
- `match(okFn, errFn)`
- `matchTags(okFn, handlers)`
- `matchTagsPartial(okFn, handlers, fallback)`
- `pipe(fn, ...)`
- `inspect(fn)`
- `inspectError(fn)`
- `inspectBoth(handlers)`
- `tap(fn)` / `tapError(fn)` (deprecated best-effort aliases of `inspect` / `inspectError`)
- `log(fn)`
- `toAsyncDisposable(fn)`
- `unwrapOr(defaultValue)`
- `unwrapOrThrow()`

<a id="resultasync-static-methods"></a>

### ResultAsync static methods

`ResultAsync.ok`, `ResultAsync.err`, `ResultAsync.unit`, `ResultAsync.okAsync`, `ResultAsync.errAsync`, `ResultAsync.unitAsync`, `ResultAsync.fromPromise`, `ResultAsync.fromSafePromise`, and `ResultAsync.try` are active in-flight constructors; `ResultAsync.tryCatch`, `ResultAsync.fromTask`, `ResultAsync.fromThrowable`, `ResultAsync.fromCallback`, and the static orchestration methods below remain deprecated for existing eager contracts (prefer `ResultTask` for new workflows):

- `ResultAsync.ok(value)`
- `ResultAsync.err(error)`
- `ResultAsync.unit()`
- `ResultAsync.okAsync(value)`
- `ResultAsync.errAsync(error)`
- `ResultAsync.unitAsync()`
- `ResultAsync.asVoid(result)` / `ResultAsync.asVoid()`
- `ResultAsync.try(promiseOrFactory, toError?)` / `ResultAsync.try({ try, catch? })`
- `ResultAsync.tryCatch(promiseOrFactory, toError?)` (deprecated alias)
- `ResultAsync.fromSafePromise(promise)`
- `ResultAsync.fromPromise(promise, toError)`
- `ResultAsync.fromTask(task)` (deprecated compatibility bridge; eagerly executes once)
- `ResultAsync.fromThrowable(fn, toError?)` (deprecated)
- `ResultAsync.fromCallback(options)` (deprecated)
- `ResultAsync.zip(left, right)`
- `ResultAsync.all(results)` / `ResultAsync.all(record)` / `ResultAsync.all(iterable)`
- `ResultAsync.combine(results)`
- `ResultAsync.combine(record)`
- `ResultAsync.combine(iterable)`
- `ResultAsync.combineWithAllErrors(results)`
- `ResultAsync.combineWithAllErrors(record)`
- `ResultAsync.combineWithAllErrors(iterable)`
- `ResultAsync.race(left, right)`
- `ResultAsync.raceAll(tasks)`
- `ResultAsync.raceFirst(left, right)`
- `ResultAsync.raceWith(left, right, handlers)`
- `ResultAsync.timeout(task, options)`
- `ResultAsync.retry(task, options)`
- `ResultAsync.retryOrElse(task, options)`
- `ResultAsync.withResource(options)`
- `ResultAsync.validateAll(results)`
- `ResultAsync.validateAll(iterable, fn)`
- `ResultAsync.validateAll(iterable, fn, { concurrency })`
- `ResultAsync.firstSuccessOf(candidates)`
- `ResultAsync.if(condition, { onTrue, onFalse })`
- `ResultAsync.when(condition, body)` / `ResultAsync.when(condition)(result)`
- `ResultAsync.whenResult(conditionResult, body)`
- `ResultAsync.unless(condition, body)` / `ResultAsync.unless(condition)(result)`
- `ResultAsync.unlessResult(conditionResult, body)`
- `ResultAsync.loop(initial, options)`
- `ResultAsync.iterate(initial, options)`
- `ResultAsync.forEach(iterable, fn, options?)`
- `ResultAsync.forEach(iterable, fn, { concurrency, discard? })`

### Tagged error helpers

- `createTaggedError(options)`
- `matchError(error, handlers)`
- `matchErrorPartial(error, handlers, fallback)`
- `isError(value)`
- `findCause(error, ErrorClass)`
- `taggedEnum<Members>()`
- `TaggedEnum<Members>`
- `TaggedEnumFactory<Members>`
- `TaggedErrorClass`
- `TaggedErrorInstance`
- `TaggedErrorOptions`

## Reference Docs

Use this guide as the curated reference for API behavior, examples, and production style. The public
entry point and API map above list the exported runtime helpers and type-only names.

## Workspace

This repository is a pnpm workspace:

- `packages/resultar`: the Resultar runtime package.
- `packages/check`: native TypeScript 7 checks plus type-aware Resultar diagnostics.
- `benchmarks`: benchmark workspace package.
- `examples/cookbook`: runnable core Resultar cookbook.

Common commands:

```sh
pnpm install
pnpm run fmt:check
pnpm run check
pnpm test
pnpm run test:cov
pnpm run build
pnpm run check:full
pnpm run test:examples
pnpm --filter resultar run test:mutation
pnpm run bench
```

### Workspace toolchain and validation

The workspace uses Vite+ `1.1.0` with Vitest, UI, and V8 coverage aligned at its bundled version,
`5.0.3`. Validation on October 7, 2026 passed `check:full` with 832 tests (629 in the core), build,
package smoke tests, all example suites, and the agent evaluation graders.

`check:full` also runs `test:release`, which exercises JSR version synchronization with the
package formatter configurations and checks that repeated runs preserve the output. The
`sync:jsr-version` command formats each manifest from its owning package directory so generated
release commits follow the same configuration as package validation.

Mutation testing keeps `coverageAnalysis: "perTest"` and uses a tracked pnpm patch for Stryker 10's
Vitest runner. Vitest 5 joins suite and test names with `>`; both the runner's filters and its
bundled coverage setup must use that separator. Without the patch, covered mutants can be reported
as survivors with zero completed tests. Keep the patch until the upstream runner supports these
names. Keep Vitest and its coverage/UI packages aligned with Vite+'s bundled version (5.0.3 for
Vite+ 1.1.0). After changing the runner or its configuration, regenerate the report and incremental cache
with `pnpm --filter resultar run test:mutation --force`. The JSON report is written to
`packages/resultar/reports/mutation/mutation.json`.

The previous report contained 52 survivors with zero completed tests. After fixing test selection,
strengthening the pipeline/service-resolver tests, and forcing a fresh run on October 7, 2026, the
report recorded 2,052 killed mutants, 61 detected by timeout, zero survivors, and zero uncovered
mutants: a 100% mutation score. The 290 ignored mutants include nine documented exclusions in three
unreachable defensive defaults of the private interpreter. These results cover the ten configured
source files and preserve runtime behavior and public execution contracts.

## License

MIT
