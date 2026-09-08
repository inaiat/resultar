# RFC 0001: ResultTask and the next core architecture

- Status: Draft
- Date: 2026-09-01
- Scope: `resultar` package
- Intended compatibility: incremental evolution before an eventual major

## Summary

This RFC proposes separating the three concepts that are currently partially overlapping in the core:

```ts
Result<A, E> // resultado síncrono já calculado
ResultTask<A, E, R> // descrição lazy de um programa
ResultAsync<A, E> // PromiseLike<Result<A, E>> para compatibilidade
```

`Result` remains the small, direct data type that identifies the project. The new abstraction
`ResultTask` takes over async execution, cancellation, concurrency, retry, timeout,
resources, and dependencies. `ResultAsync` remains available during the migration and may, over time,
be implemented as a `ResultTask` execution facade.

The main inspiration comes from Effect v4: programs are lazy values; execution belongs to a
runtime; resources live in scopes; concurrency is structured; dependencies are explicit; and
`yield*` ergonomics does not imply that distinct types are structurally interchangeable.

The goal is not to turn Resultar into a reduced implementation of Effect. The goal is to adopt
the ideas that solve concrete limitations of the current core without losing Resultar's simple API.

## Motivation

Today `ResultAsync<A, E>` directly stores a `Promise<Result<A, E>>`. In many constructors the
Promise starts executing before any explicit runtime call. Combinators are
implemented by chaining `then`, `catch`, `Promise.all`, and local abort controllers.

This model works well for simple composition, but creates limits as the package gains
production operations:

- an instance does not represent a reusable program, but an already-started execution;
- cancellation is cooperative and specific to each helper;
- `race`, `timeout`, retry, callbacks, and resources each have their own protocols;
- there is no single scope that knows all finalizers and child tasks;
- there is no central place for clock, scheduler, logs, metrics, or tracing;
- expected failure, interruption, and implementation defects have no common representation;
- `Result` and `ResultAsync` repeat a relevant share of types and combinators;
- the async file concentrates model, execution, concurrency, resource safety, and public API.

Adding more helpers directly to `ResultAsync` increases this complexity without fixing the cause:
the Promise is simultaneously the description and the execution.

## Goals

1. Preserve `Result<A, E>` as an explicit value, small and runtime-independent.
2. Introduce a lazy representation for sync and async workflows.
3. Make cancellation, timeout, concurrency, and cleanup properties of the runtime.
4. Allow typed dependencies without requiring a global DI container.
5. Keep expected failures in the `E` channel and distinguish interruptions and defects.
6. Keep `yield*` as safe ergonomics for linear code.
7. Migrate without immediately breaking `ResultAsync` users.
8. Reduce duplication and make the core internally modular.

## Non-goals

- Implement `Stream`, STM, cache, cluster, RPC, or a full platform.
- Reproduce the entire Effect API.
- Require services/context for simple uses.
- Add an implicit global runtime.
- Remove `ResultAsync` in the first delivery.
- Change the meaning of `Ok`, `Err`, or the existing tagged errors.
- Automatically capture programming bugs as expected failures in `E`.

## Design principles

### Result is data; ResultTask is program

Building a `Result` computes or receives a value immediately. Building a `ResultTask` only
describes work. Work starts only on an explicit execution operation.

```ts
const result = parsePort(input)
// parsePort já executou

const task = ResultTask.tryPromise({
  try: () => fetchUser(id),
  catch: (cause) => new FetchUserError({ cause }),
})
// fetchUser ainda não executou

const resolved = await ResultTask.runResult(task)
```

### The simple path stays simple

No custom service or runtime should be needed for:

```ts
const task = ResultTask.succeed(1).map((value) => value + 1)
const result = await ResultTask.runResult(task)
```

### Policies are values

Retry, backoff, jitter, and repetition should be described by reusable values instead of large
option objects coupled to a single operation.

### Resources belong to scopes

Acquisition and release must be recorded in the same execution context. The runtime must run
finalizers on success, failure, defect, interruption, or timeout.

### Different types stay different

`Result`, `ResultAsync`, `ResultTask`, `Fiber`, and service references may support `yield*`, but
must not be structurally accepted as if they were the same type. Every conversion outside a
generator must be explicit.

## Proposed public API

The names below are an API direction, not a frozen list for the first implementation.

### Model

```ts
declare const ResultTaskTypeId: unique symbol

export interface ResultTask<out A, out E = never, out R = never> extends Pipeable {
  readonly [ResultTaskTypeId]: {
    readonly success: (_: never) => A
    readonly error: (_: never) => E
    readonly requirements: (_: never) => R
  }

  [Symbol.iterator](): ResultTaskIterator<ResultTask<A, E, R>>
}
```

`A` is the success value, `E` is an expected failure, and `R` represents execution requirements.

The actual constructor and the internal execution function are not part of the public interface. This allows
changing the program representation without breaking consumers.

### Minimal constructors

```ts
ResultTask.succeed<A>(value: A): ResultTask<A>
ResultTask.fail<E>(error: E): ResultTask<never, E>
ResultTask.fromResult<A, E>(result: Result<A, E>): ResultTask<A, E>
ResultTask.sync<A>(evaluate: () => A): ResultTask<A>

ResultTask.try<A, E>(options: {
  readonly try: () => A
  readonly catch: (cause: unknown) => E
}): ResultTask<A, E>

ResultTask.tryPromise<A, E>(options: {
  readonly try: (signal: AbortSignal) => PromiseLike<A>
  readonly catch: (cause: unknown) => E
}): ResultTask<A, E>
```

`sync` is used for computations that must not throw. If one throws, that is a defect. `try` and
`tryPromise` are explicit boundaries that convert external causes into `E`.

### Composition

```ts
ResultTask.map(task, f)
ResultTask.mapError(task, f)
ResultTask.flatMap(task, f)
ResultTask.andThen(task, f) // alias orientado à API atual
ResultTask.catchAll(task, f)
ResultTask.catchTag(task, tag, f)
ResultTask.tap(task, f)
ResultTask.tapError(task, f)
ResultTask.match(task, handlers)
ResultTask.as(task, value)
```

The API must support `pipe`. Instance methods may exist for ergonomics, but the canonical
implementation must live in module functions to reduce duplication and ease tree shaking.

### Generator

```ts
const createAccount = (input: Input) =>
  ResultTask.gen(function* () {
    const email = yield* validateEmail(input.email)
    const users = yield* Users
    const account = yield* users.create(email)
    yield* Audit.record({ type: 'AccountCreated', accountId: account.id })
    return account
  })
```

The normal generator return must be the `A` value, not `ok(A)`. Failures produced by tasks
interrupt the generator and accumulate in the `E` type.

Compatibility with the current style may be offered during the migration, but the form above must be
the recommended API for `ResultTask.gen`.

To keep the same language between the eager and lazy models, `Result.gen` is an exact alias of
`safeTry`. The legacy name remains available, but new examples of `Result` workflows may use
`Result.gen` alongside `ResultTask.gen`. The semantics remain different: `Result.gen` runs the
generator immediately and returns `Result` or `ResultAsync`, while `ResultTask.gen` creates a
lazy description and returns the success value when executed.

### Execution

```ts
ResultTask.runResult(task): Promise<Result<A, E>>
ResultTask.runResult(task, { services, signal }): Promise<Result<A, E>>
ResultTask.runExit(task): Promise<Exit<A, E>>
ResultTask.runPromise(task): Promise<A>
ResultTask.runFork(task): Fiber<A, E>
```

Without `R` requirements, `services` is optional. If `R` is not `never`, TypeScript must require the remaining
services.

`runResult` is Resultar's default boundary. `runPromise` rejects on `Err`, interruption, or defect and
is intended for integration with Promise APIs. `runExit` preserves all execution information.

### Services and context

The first version must use lightweight tokens, without a full Layer system:

```ts
interface ServiceTag<Identifier, Service> {
  readonly key: symbol
  readonly identifier: Identifier
}

const Database = ResultTask.service<Database, 'Database'>('Database')

const program: ResultTask<User, DatabaseError, typeof Database> = ResultTask.gen(function* () {
  const database = yield* Database
  return yield* database.findUser('u1')
})

const runnable = ResultTask.provideService(program, Database, databaseLive)
```

Composition adapters may resolve tags on demand with `ResultTask.provideServiceResolver`.
The adapter provides a typed map from identifiers to lazy providers. Each provider returns
a `ResultTask` compatible with the contract. Its errors and external requirements are preserved,
as are scope requirements. `makeScope()` allows ownership across executions and
`memoize()` shares pending initialization, with retry after failure.

Requirements must compose without depending on a global singleton. A `Layer` API should only
be considered after real cases demonstrate the need to build service graphs
with their own lifecycle.

**DX in a separate package (updated on 2026-09-05):** a private consumer migration motivated
[`resultar-di`](../../packages/di/README.md), an optional composition package over the core's public APIs.
The main API defines tokens with `service(name, dependencies, factory)` for sync creation,
`service(name, task)` for initialization with ResultTask, and `resource(name, { acquire, release })`
for resources. Dependencies are a typed object of tokens or requirements declared via
`yield*`; registering tokens in the module requires no dependency order.

`createModule` registers these tokens with `.singleton`, `.scoped`, or `.transient`: respectively,
one instance per root, one per child scope, or one per resolution. `.value` provides already-created
values under external ownership. `merge` combines modules and `override` replaces services with
contract checking. Class-based tokens (`Service`), overloads with names and dependency lists,
and the `.task`/`.resource` registration methods live in `resultar-di/advanced`, outside the main
autocomplete.

`use` on the module runs an isolated root and awaits its completion; `scope()` keeps a root alive across
executions, with one child per `use` and explicit closing via `close()`. `withServices` provides local
values. The `http`/`fetch` adapters keep the response scope open until the body is consumed or cancelled.
Selection infers the errors and requirements of reachable dependencies, including the requirements
of the `use` callback; to limit compiler cost, analysis uses the conservative union of the graph
once it reaches eight expansion steps. This type approximation does not execute unselected services.

The core keeps `ServiceTag`, requirement provisioning and resolution, resource ownership,
task memoization, finalization, interruption, and causes. Registries, lifetimes, service caches,
graph validation, and HTTP integration belong to `resultar-di`. The core does not depend on that package,
and composition uses the existing ResultTask runtime, without adding a `Layer` to the core.

### Scope and resources

```ts
const connection = ResultTask.acquireRelease({
  acquire: ResultTask.tryPromise({
    try: () => pool.connect(),
    catch: (cause) => new ConnectionError({ cause }),
  }),
  release: (connection, exit) => ResultTask.sync(() => connection.release(exit)),
})

const query = ResultTask.scoped(
  ResultTask.gen(function* () {
    const db = yield* connection
    return yield* db.query(sql)
  }),
)
```

Rules:

- finalizers run in LIFO order;
- each finalizer runs at most once;
- interruption must not prevent cleanup;
- the region's `Exit` is available to the finalizer;
- release failure must not be silently discarded in `runExit`;
- `runResult` must apply a documented policy when use and release fail together.

### Implemented slice: resources (2026-09-05)

The incremental Phase 3 implementation includes a root scope per execution, `scoped`, `acquireRelease`,
awaited LIFO finalizers shielded from the interruption signal, and `Cause.Sequential`/`Interrupt`.
It does not include fibers, race, timeout, scheduler, or `Cause.Parallel`; Phase 3 remains partial.

Decisions in this slice:

- `acquireRelease` accumulates release errors in `ResultTaskScope<ReleaseError>`, a nominal requirement
  in `R`. The error cannot live only in `E`: `catchAll` could remove it before the finalizer runs.
- `scoped` removes scope requirements and folds their errors into `E`. The `run*` boundaries provide
  the root scope automatically and fold its errors into the output. Services remain required
  when service tags are present in `R`; providing services does not remove scope requirements.
- All finalizers receive the same `Exit` of the region body. Cleanup failures are appended in
  execution order as `Sequential`; the remaining finalizers keep running.
- `runResult` returns a single `Fail` as `Err`, rejects `Die` with the original defect, `Interrupt`
  with `AbortError`, and `Sequential` with `ResultTaskCauseError`. The `cause` field preserves the tree.
  This is the policy chosen in this slice for open question no. 6, without widening all of `E`
  with an aggregate type or dropping one of the failures.
- `catchAll` recovers only simple `Fail`. A composite cause is preserved inside
  `Die(ResultTaskCauseError)`: this prevents removed variants of `E` from reappearing in `runExit`.
  Recovering after `scoped` allows handling an isolated release failure.
- Release captures the services available at acquisition time and runs with a fresh, non-aborted signal.
  Resources acquired by the release itself belong to a private cleanup scope.
- Cancellation remains cooperative: the runtime awaits in-flight operations, records the
  release of acquisitions that finish during abort, and only then closes the scope. There is no promise
  of termination for an operation or finalizer that never settles.
- `ResultAsync.withResource` and the failure-replacement behavior of generator `finally` blocks
  remain compatible. Preserving combined causes belongs to the new scope APIs.

The `examples/resultar/src/application-lifecycle.ts` example validates explicit composition, boot rollback,
and HTTP → session → database shutdown with factories returning `ResultTask` and typed errors.
A private consumer API was integrated into the local build, keeping the use cases in `StrictResultAsync`.
The pilot covers rollback, SSE, cancellation, and the Node HTTP adapter with real local ports.
Validation against live database and session providers is still pending. The scope must cover the whole server lifetime,
not just its creation. This does not require `Layer` or a new container.

### Schedule

```ts
const policy = Schedule.exponentialBackoff(100).jittered().compose(Schedule.recurs(4))

const resilient = ResultTask.retry(loadUser, policy)
```

Minimum delivery:

```ts
Schedule.recurs(times)
Schedule.spaced(duration)
Schedule.exponentialBackoff(base)
Schedule.jittered(schedule)
Schedule.whileInput(schedule, predicate)
```

`Clock` must be injectable by the runtime so retry and timeout are deterministic in tests.

### Structured concurrency

```ts
const fiber = yield * ResultTask.forkChild(task)
const value = yield * Fiber.join(fiber)
yield * Fiber.interrupt(fiber)
```

Rules:

- child fibers belong to the parent scope;
- closing the scope interrupts still-active children;
- `race` interrupts losers and awaits their finalizers;
- `timeout` is a specialized race;
- `all` and `forEach` take a uniform concurrency policy;
- the runtime does not promise preemptive cancellation of sync JavaScript code;
- external integration still depends on cooperative `AbortSignal`.

Initial API:

```ts
ResultTask.all(input, { concurrency, mode })
ResultTask.forEach(items, f, { concurrency, discard })
ResultTask.race(left, right)
ResultTask.timeout(task, duration, onTimeout)
ResultTask.forkChild(task)
```

`mode` must distinguish at least fail-fast from accumulated validation. The current
`combineWithAllErrors` API can be expressed over this distinction.

## Exit and error model

Expected failures stay in `E`. The runtime needs to distinguish two other states:

```ts
export type Cause<E> =
  | { readonly _tag: 'Fail'; readonly error: E }
  | { readonly _tag: 'Die'; readonly defect: unknown }
  | { readonly _tag: 'Interrupt'; readonly reason?: unknown }
  | { readonly _tag: 'Sequential'; readonly left: Cause<E>; readonly right: Cause<E> }
  | { readonly _tag: 'Parallel'; readonly left: Cause<E>; readonly right: Cause<E> }

export type Exit<A, E> =
  | { readonly _tag: 'Success'; readonly value: A }
  | { readonly _tag: 'Failure'; readonly cause: Cause<E> }
```

This model does not need to show up in everyday flow. It exists to preserve information in
cleanup, concurrency, and observability.

Default conversion:

- `Fail<E>` becomes `Err<E>` in `runResult`;
- `Die` rejects the `runResult` Promise;
- `Interrupt` rejects with `AbortError` in `runResult`;
- `runExit` never rejects for states modeled by the runtime;
- multiple causes remain available in `runExit`.

One alternative would be to include `AbortError` automatically in the `E` type. This RFC does not recommend
that direction: interruption is a property of execution, not a domain failure of every function.
Boundaries that want to model cancellation as domain state may use an explicit combinator.

## Initial internal representation

The first implementation does not need to start with bytecode or a complex interpreter. A
lazy function over a runtime context is enough:

```ts
interface RuntimeContext<R> {
  readonly services: ServiceMap<R>
  readonly signal: AbortSignal
  readonly scope: Scope
  readonly clock: Clock
  readonly scheduler: Scheduler
}

type TaskExecutor<A, E, R> = (context: RuntimeContext<R>) => Promise<Exit<A, E>>
```

Each combinator creates a new executor without starting execution. If profiling shows excessive
Promise or recursion cost, the representation may evolve into interpreted instructions without changing the
public interface.

The runtime must be the only component allowed to:

- create the root `AbortController`;
- open and close the root scope;
- create fibers;
- register finalizers;
- query clock and scheduler;
- transform `Exit` into the type requested by the boundary.

## Relationship with Result

`Result` stays eager, context-free, and without cancellation. It must remain appropriate for
parsing, validation, and pure domain rules.

Explicit conversions:

```ts
ResultTask.fromResult(result)
ResultTask.runSync(task) // somente se o tipo provar que a task é síncrona; opcional
```

There is no need to move every `Result` helper to `ResultTask`. Collection helpers,
matching, and tagged errors may share internal primitives while keeping APIs suited to each
abstraction.

## Relationship with ResultAsync

`ResultAsync` stays eager and awaitable during the migration. This preserves the behavior of:

```ts
const resultAsync = tryResultAsync(() => request())
const result = await resultAsync
```

New proposed conversions:

```ts
ResultTask.fromResultAsync(resultAsync) // captura uma execução já iniciada
ResultTask.toResultAsync(task) // inicia imediatamente usando runtime padrão
ResultAsync.fromTask(task) // alias de compatibilidade
```

`ResultAsync` must not be used as the internal representation of `ResultTask`, because that would remove
the lazy property. The correct direction is `ResultTask -> execução -> ResultAsync`.

### Compatibility matrix

| Current API                | Short term   | New recommended API                                |
| -------------------------- | ------------ | ------------------------------------------------------ |
| `ok`, `err`, `Result`      | keep         | no change                                            |
| `okAsync`, `errAsync`      | keep         | `ResultTask.succeed`, `ResultTask.fail` for programs |
| `tryResultAsync`           | keep eager   | `ResultTask.tryPromise`                                |
| `ResultAsync.retry`        | keep         | `ResultTask.retry` + `Schedule`                        |
| `ResultAsync.timeout`      | keep         | `ResultTask.timeout`                                   |
| `ResultAsync.race*`        | keep         | `ResultTask.race` and structured fibers                |
| `ResultAsync.withResource` | keep         | `acquireRelease` + `scoped`                            |
| async `safeTry`            | keep         | `ResultTask.gen`                                       |
| `runPromise(ResultAsync)`  | keep         | overload or explicit name for `ResultTask`           |

No current function may silently change from eager to lazy within the same major. That
change would be observable even when the types keep compiling.

## Module organization

Suggested target structure:

```text
packages/resultar/src/
  result/
    model.ts
    constructors.ts
    combinators.ts
    collections.ts
    match.ts
  task/
    model.ts
    constructors.ts
    combinators.ts
    generator.ts
    runtime.ts
    exit.ts
    cause.ts
    fiber.ts
    scope.ts
    schedule.ts
    services.ts
  async/
    result-async.ts
    adapters.ts
  errors/
    tagged-error.ts
    tagged-match.ts
    abort-error.ts
  internal/
    pipe.ts
    type-utils.ts
```

This structure is a destination, not a prerequisite for starting. The first implementation may
land in `src/task/` and reuse the current core via imports. Moving existing files must happen
separately, after the new API is stable, to keep diffs reviewable.

## Implementation strategy

### Phase 0: contracts and proofs of concept (Done)

- [x] add type tests for lazy evaluation and `A`, `E`, and `R` inference;
- [x] validate the `ResultTask.gen` design with TypeScript 7;
- [x] measure the cost of a long `flatMap` chain (benchmarks added in `benchmarks/resultar-task-chains.ts`);
- [x] decide public names before exporting through the main entrypoint (consolidated as `ResultTask`);
- [x] implement initially behind an experimental subpath if needed (available at the root with full backward compatibility).

Exit criterion: representative examples compile, lazy evaluation is proven by tests, and the iterative-trampoline representation does not stack-overflow on long chains (validated up to 10,000+ iterations). Details in [`rfc-0001-phase-0-done.md`](./rfc-0001-phase-0-done.md).

### Phase 1: lazy core

- `ResultTask<A, E, R>` and nominal TypeId;
- `succeed`, `fail`, `fromResult`, `sync`, `try`, `tryPromise`;
- `map`, `mapError`, `flatMap`, `catchAll`, `tap`;
- `runExit`, `runResult`, `runPromise`;
- minimal `Exit` and `Cause`;
- adapters for `Result` and `ResultAsync`.

Exit criterion: sequential workflows replace `ResultAsync.andThen` without losing inference and
without starting operations during construction.

### Phase 2: generator and services

- `ResultTask.gen`;
- nominal yieldable contract;
- service tags;
- `service`, `provideService`, `provideServices`, and `provideServiceResolver`;
- missing-service errors as runtime defects;
- inference tests for composite requirements.

Exit criterion: an application workflow can declare and provide database, logger, and clock without
capturing those dependencies via closure.

### Phase 3: scope and interruption

- root scope and child scopes;
- LIFO finalizer registration;
- `acquireRelease` and `scoped`;
- `AbortSignal` propagation;
- `Fiber`, `forkChild`, `join`, and `interrupt`;
- `race` and `timeout` over fibers.

Exit criterion: no race or timeout loser is left ownerless, and finalizers run in all
exit states.

### Phase 4: schedule and collections

- minimal `Schedule`;
- retry over schedule and injectable clock;
- `all`, `forEach`, and accumulated validation;
- uniform concurrency limits;
- fail-fast interruption with cleanup of active items.

Exit criterion: current production helpers have equivalents over the same runtime primitives,
without independent cancellation protocols.

### Phase 5: integration and stabilization

- documentation and cookbook;
- benchmarks against `ResultAsync` and Effect v4;
- migration of the `resultar-request-*` packages as pilot consumers;
- stable subpath or export through the main package;
- deprecations only when there is a mechanical migration path;
- decision on the next major.

Exit criterion: at least one real consumer uses `ResultTask`; API, performance, and error
messages have been validated outside unit tests.

## Test strategy

### Semantics

- building a task does not run effects;
- each `run*` call runs the task again;
- `map` and `flatMap` preserve short-circuiting;
- `catchTag` correctly removes `E` variants;
- defects do not show up as `Err<E>` by accident.

### Interruption and concurrency

- timeout interrupts the task and awaits finalizers;
- race interrupts all losers;
- parent interruption reaches children;
- bounded concurrency never exceeds the limit;
- fail-fast stops starting new items;
- accumulated validation preserves deterministic error order.

### Resources

- release on success, `Err`, defect, and interruption;
- release exactly once;
- LIFO order;
- multiple causes preserved;
- async finalizer completed before `runExit` resolves.

### Types

- error union in `flatMap`;
- tagged-error removal on recovery;
- requirements accumulated and removed by `provideService`;
- `never` does not degrade inference;
- `yield*` does not make `ResultTask` structurally compatible with other yieldables;
- record and tuple inference in `all`.

### Compatibility

- current public API stays covered by the guard test;
- `ResultAsync` stays awaitable and eager;
- adapters do not run a task more than once;
- request packages keep their existing signatures.

## Performance and limits

Benchmarks need to cover:

- building tasks without execution;
- chains of 10, 100, and 10,000 `map`/`flatMap`;
- sequential execution;
- `all` with concurrency 1, bounded, and unbounded;
- `ResultTask.gen` cost;
- scope/finalizer cost;
- memory retained after interruption;
- comparison with current `ResultAsync`, manual Promise, and Effect v4.

Initial goals:

- no operation may start during construction;
- long chains must not overflow the stack;
- overhead must be documented, not hidden;
- the pure-`Result` path must not pay for the runtime;
- tree shaking must allow using `Result` without including the whole task module.

## Risks

### Scope too large

Context, fibers, cause, scope, and schedule together can turn a core improvement into a
long rewrite. The mitigation is to ship by phases, starting from the lazy core and validating each new
primitive with a real consumer.

### Confusion between ResultAsync and ResultTask

During the transition there will be two async abstractions. The documentation must use a clear rule:

- received or need to expose an already-started Promise: `ResultAsync`;
- describing a reusable workflow: `ResultTask`.

### Type complexity

Adding `R`, generator inference, and tagged recovery may increase compile times. TypeScript
benchmarks and inference fixtures need to be part of Phase 0.

### API too inspired by Effect

Copying names and concepts without concrete need dilutes Resultar's identity. Each new
module must answer a problem already present in the core or in real consumers.

### Defect and interruption semantics

Converting everything to `Err` looks simple, but loses the distinction between domain, bug, and cancellation.
On the other hand, exposing `Cause` in every API would make the common path heavy. `Exit` must remain an
advanced boundary, while `runResult` offers the everyday experience.

## Open questions and consolidated decisions

1. **Should the final name be `ResultTask`, `TaskResult`, or another?**
   - **Decision:** `ResultTask`. Keeps the identity with `Result` and parallelism with `ResultAsync`.
2. Should `R` represent service tags in a union or a service shape in an intersection?
3. **Should the first release use a subpath like `resultar/task`?**
   - **Decision:** Exposed directly on the `resultar` root entrypoint, with no breaking changes and keeping the package's unified ergonomics.
4. Will instance methods be part of the canonical API or only pipeable functions?
5. Should `runResult` reject on interruption or return an explicit `Err<AbortError>`?
6. How to represent use failure and release failure together at the simplified boundary?
7. Should `ResultTask.gen` accept `Result` directly via `yield*` or require `fromResult`?
8. Does `Schedule` belong in the core or in an optional subpath/package?
9. Which part of the runtime should be public for tests and tracing integration?

## Recommended preliminary decisions

- use `ResultTask` as the working name;
- keep `Result` without a third parameter;
- do not silently change eager/lazy within the current major;
- expose first via `resultar/task` or an equivalent experimental export;
- use a nominal TypeId and a narrow yieldable contract;
- start with a lazy function executor and keep the representation private;
- include `Exit`/`Cause` in the runtime, but not in the everyday path;
- treat `AbortSignal`, `Scope`, and `Clock` as fundamental capabilities;
- defer `Layer` until there is evidence of real use;
- migrate one request package as proof before stabilizing the API.

## First implementable slice

The smallest pull request that validates the architecture must contain only:

```ts
ResultTask<A, E>
ResultTask.succeed
ResultTask.fail
ResultTask.fromResult
ResultTask.tryPromise
ResultTask.map
ResultTask.flatMap
ResultTask.catchAll
ResultTask.runResult
ResultTask.runExit
```

In addition:

- nominal TypeId;
- tested lazy evaluation;
- tested repeatable execution;
- minimal `Exit` with `Success`, `Fail`, and `Die`;
- no services, fibers, schedules, or scopes yet;
- simple benchmark against current `ResultAsync`;
- experimental export, no deprecations.

This slice answers the main architectural question — does separating description from execution improve the
core? — before committing the project to the whole runtime.

## References

- [Effect v4: `Effect` as a lazy description of a workflow](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Effect.ts)
- [Effect v4: migration to the `Yieldable` trait](https://github.com/Effect-TS/effect/blob/main/migration/yieldable.md)
- [Effect v4: general migration guide](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)
- Current `Result` implementation: `packages/resultar/src/result.ts`
- Current `ResultAsync` implementation: `packages/resultar/src/result-async.ts`
- Current roadmap: `./rfc-0003-phase-3-remainder-and-validation.md` (open items plus archived Done appendix; replaced `packages/resultar/TASKS.md`, removed 2026-09-07).
