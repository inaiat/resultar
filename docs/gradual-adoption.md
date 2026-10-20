# Adopt Resultar gradually

Start by making one expected failure explicit with `Result<T, E>`. Keep existing
Promise APIs at their boundaries and prefer `ResultTask` for new asynchronous
workflows. Add time policies, service requirements or owned concurrent work as
needed. `ResultAsync` represents an in-flight `Result` returned at execution boundaries (`runResult()`) and by active in-flight constructors (`okAsync`, `errAsync`, `unitAsync`, `fromPromise`, `fromSafePromise`, `tryResultAsync`), while deprecated eager orchestration helpers from `resultar/async` preserve legacy boundaries during migration.
Each step is useful on its own; an application can keep all three models.

`Result<T, E>` uses `T` for success and `E` for expected errors.
`ResultTask<T, E, R>` adds a third parameter, `R`, for required services and
resource scopes.

This guide describes the APIs in this checkout. Check the installed package's
types before adopting capabilities from a newer release. The
[v4 migration reference](migrations/v4.md) lists retained deprecated APIs and
their preferred names; changing those spellings is independent of adopting tasks.

| Adopt when you need | Contract | When work starts |
| --- | --- | --- |
| One synchronous validation or domain operation | `Result<T, E>` | When the function is called |
| New async work, with optional service/scope requirements (`R`) and runtime options | `ResultTask<T, E, R>` | At an explicit `run*` boundary, again on each run |
| An in-flight async `Result` (`task.runResult()`) or existing eager async contract | `ResultAsync<T, E>` | Immediately when `runResult()` (or an in-flight constructor) is called; repeated awaits observe one execution |

The TypeScript blocks below are independent examples. Copy one into an ESM
module; blocks using `await` use top-level await.

## 1. Return a Result from one function

Choose an expected failure that callers currently handle with a sentinel or
exception. Keep the surrounding application and turn that one outcome into a
value. Use `match` at the existing boundary.

```ts
import { createTaggedError, ok, type Result } from "resultar";

class InvalidPortError extends createTaggedError({
  name: "InvalidPortError",
  message: "Invalid port $input",
}) {}

const parsePort = (input: string): Result<number, InvalidPortError> => {
  const port = Number(input);
  return Number.isInteger(port) && port > 0 && port <= 65_535
    ? ok(port)
    : InvalidPortError.err({ input });
};

const response = parsePort("8080").match({
  ok: (port) => ({ status: 200, body: { port } }),
  err: (error) => ({ status: 400, body: { message: error.message } }),
});

console.log(response);
```

`T` and `E` remain concrete as callers adopt `map`, `andThen` and `mapErr`.
`StrictResult<T, E extends Error>` is also available when a boundary should accept
only real Error instances. A tagged error works with either contract.

Runnable example: [synchronous validation](../examples/cookbook/src/sync-validation.ts).

## 2. Compose Results before adding a runtime

When several Result-returning functions form a use case, `Result.gen` makes the
steps linear. `yield*` extracts an `Ok` value or short-circuits on the first `Err`.
The generator returns a **plain success value**, which becomes `Ok(value)`; fallible steps
and early errors short-circuit via `yield*`.

```ts
import { Result, createTaggedError, ok, type Result as ResultValue } from "resultar";

class InvalidHostError extends createTaggedError({
  name: "InvalidHostError",
  message: "Host must not be empty",
}) {}

class InvalidPortError extends createTaggedError({
  name: "InvalidPortError",
  message: "Invalid port $input",
}) {}

const parseHost = (input: string): ResultValue<string, InvalidHostError> =>
  input.trim().length > 0 ? ok(input.trim()) : InvalidHostError.err();

const parsePort = (input: string): ResultValue<number, InvalidPortError> => {
  const port = Number(input);
  return Number.isInteger(port) && port > 0 && port <= 65_535
    ? ok(port)
    : InvalidPortError.err({ input });
};

const parseAddress = (host: string, port: string) =>
  Result.gen(function* () {
    const parsedHost = yield* parseHost(host);
    const parsedPort = yield* parsePort(port);
    return { host: parsedHost, port: parsedPort };
  });

console.log(parseAddress("localhost", "8080").unwrapOr({ host: "localhost", port: 3000 }));
```

The inferred error channel contains both validation errors. This still executes
synchronously and needs no Clock, services or Fibers. Existing `safeTry` workflows
keep their Result-returning generator contract while migrating to `Result.gen` plain-value returns.
These helpers are separate functions; the modern generator wraps its plain return
without inspecting the payload.
Do not rely on generator `finally` for cleanup after an early `Err` in this model;
use task resource scopes when cleanup becomes part of the workflow contract.

Runnable example: [domain composition](../examples/cookbook/src/domain-workflow.ts).

## 3. Add asynchronous work with ResultTask

Use `ResultTask.tryPromise` to turn a Promise factory into lazy, repeatable work.
Pass its signal to the driver and map expected failures in `catch`. Constructing
the Task does not start the operation; the outer boundary chooses when to run it.

```ts
import { ResultTask, createTaggedError } from "resultar";

interface User {
  readonly id: string;
  readonly name: string;
}

class LoadUserError extends createTaggedError({
  name: "LoadUserError",
  message: "Could not load user $id",
}) {}

// Stand-in for an existing driver; replace its body with your Promise API.
const readUser = async (id: string, signal: AbortSignal): Promise<User> => {
  signal.throwIfAborted();
  return { id, name: "Ada" };
};

const loadUser = (id: string): ResultTask<User, LoadUserError> =>
  ResultTask.tryPromise({
    try: (signal) => readUser(id, signal),
    catch: (cause) => new LoadUserError({ id, cause }),
  });

const greeting = (id: string) =>
  ResultTask.gen(function* () {
    const user = yield* loadUser(id);
    return `Hello, ${user.name}`;
  });

const response = await greeting("user_123")
  .runResult()
  .match({
    ok: (message) => ({ status: 200, body: { message } }),
    err: (error) => ({ status: 503, body: { message: error.message } }),
  });

console.log(response);
```

`ResultTask.gen` uses a synchronous generator even when its steps perform async I/O.
Return a plain success value, and compose fallible Results or Tasks with `yield*`.
Use `andThen` and `tryPromise` for an asynchronous transformation; Task `map` is
synchronous. At the outer boundary, `runResult` returns `ResultAsync<T, E>` (`PromiseLike<Result<T, E>>`);
`runExit` preserves every failure cause as a value and `runPromise` resolves the
success value or rejects.

Runnable examples: [task resilience](../examples/cookbook/src/task-resilience.ts) and
[application lifecycle](../examples/cookbook/src/application-lifecycle.ts).

## 4. Bridge existing eager APIs during migration

`ResultAsync` and `StrictResultAsync` represent an in-flight `Result` (`PromiseLike<Result<T, E>>`)
and are exported from both `resultar` and `resultar/async`. Active in-flight constructors
such as `tryResultAsync` and `fromPromise` are also exported from both entry points to keep
their eager, single-execution behavior where existing callers
depend on that contract. For a new Task workflow, adapt the existing operation with
`fromResultAsync`; a factory creates fresh work on each run. The following
`loadUser` represents such an existing eager adapter.

```ts
import { ResultTask, createTaggedError, ok, tryResultAsync, type Result, type ResultAsync } from "resultar";

class InvalidIdError extends createTaggedError({
  name: "InvalidIdError",
  message: "User id must not be empty",
}) {}

class LoadUserError extends createTaggedError({
  name: "LoadUserError",
  message: "Could not load user $id",
}) {}

const validateId = (id: string): Result<string, InvalidIdError> =>
  id.trim().length > 0 ? ok(id.trim()) : InvalidIdError.err();

const loadUser = (id: string) =>
  tryResultAsync({
    try: async () => ({ id, name: "Ada" }),
    catch: (cause) => new LoadUserError({ id, cause }),
  });

const greetingTask = (input: string) =>
  ResultTask.gen(function* () {
    const id = yield* validateId(input);
    const user = yield* ResultTask.fromResultAsync(() => loadUser(id));
    return `Hello, ${user.name}`;
  });

// runResult() eagerly starts one execution and returns ResultAsync for existing callers.
const greeting = (id: string): ResultAsync<string, InvalidIdError | LoadUserError> =>
  greetingTask(id).runResult();

console.log(await greeting("user_123").unwrapOr("Unavailable"));

// Callers can also pass runtime options at the execution boundary.
const task = greetingTask("user_123");
const result = await task.runResult();
console.log(result.unwrapOr("Unavailable"));
```

`task.runResult()` (and its deprecated aliases `ResultAsync.fromTask(task)` and `task.toResultAsync()`)
starts the task once and captures that execution in a `ResultAsync` facade. Provide
services and wrap scope-dependent work with `ResultTask.scoped` before running, or pass `{ services }` to `runResult({ services })`.
The `runResult` boundary can still reject on defects, interruption or
composite causes. A Task itself has no `.then`; awaiting it does not execute it.

For Promise adapters that need the active cancellation signal, use `ResultTask.tryPromise({ try: signal => ..., catch })`
or `ResultTask.fromResultAsync(signal => load(signal))` and pass the signal to a cooperative driver.

| Bridge | Execution behavior |
| --- | --- |
| `ResultTask.fromResult(result)` | Wraps a synchronous `Result` that has already been computed |
| `ResultTask.fromResultAsync(existing)` | Reuses an existing eager `ResultAsync` execution on every task run |
| `ResultTask.fromResultAsync(signal => load(signal))` | Evaluates the factory with the active `AbortSignal` on each task run |
| `ResultTask.tryPromise({ try, catch })` | Calls the Promise factory on each task run |
| `task.runResult(options?)` | Starts the task once and returns an in-flight `ResultAsync` (`ResultAsync.fromTask` / `toResultAsync` are deprecated aliases) |

Capturing an already-started `Promise` via `fromPromise` cannot undo its execution; use
`ResultTask.tryPromise` or `fromResultAsync(() => tryResultAsync(...))` so each task
run and retry creates a fresh operation. `fromResult` has no
factory overload; defer a Result-producing call inside `ResultTask.gen` as above.

The incoming bridge accepts any `PromiseLike<Result<T, E>>`. Core `Result.gen` and
`Result.fn` accept synchronous and asynchronous generators with plain return values;
legacy `safeTry` preserves the final Result. Existing root imports remain supported,
and `resultar/async` provides the eager helpers in the same package; see the
[v4 migration table](migrations/v4.md).

## 5. Add services where a task needs them

Keep ordinary function parameters until a task benefits from typed service
requirements. A service tag records its requirement in `R`; the run boundary
supplies the implementation. New repositories can return Tasks directly; existing
eager repositories use the bridge from the previous section.

```ts
import { ResultTask, createTaggedError } from "resultar";

interface User {
  readonly id: string;
  readonly name: string;
}

class LoadUserError extends createTaggedError({
  name: "LoadUserError",
  message: "Could not load user $id",
}) {}

interface UserRepository {
  readonly load: (id: string) => ResultTask<User, LoadUserError>;
}

const Users = ResultTask.service<UserRepository>()("Users");

const greeting = ResultTask.gen(function* () {
  const users = yield* Users;
  const user = yield* users.load("user_123");
  return `Hello, ${user.name}`;
});

const users: UserRepository = {
  load: (id) =>
    ResultTask.tryPromise({
      try: async (signal) => {
        signal.throwIfAborted();
        return { id, name: "Ada" };
      },
      catch: (cause) => new LoadUserError({ id, cause }),
    }),
};

const result = await greeting.runResult({ services: { Users: users } });
console.log(result.unwrapOr("Unavailable"));
```

Omitting `Users` is a type error. Bind it earlier with
`ResultTask.provideService(greeting, Users, users)` to supply it before execution.
A DI container is optional; see the
[service guide](../packages/resultar/README.md#lazy-workflows-with-resulttask) and
[resultar-di](../packages/di/README.md) when lifetimes span several use cases.

## 6. Reuse retry policy and make time deterministic

Introduce retry around an operation that is safe to repeat, such as a read.
Use `Retry.policy` on the Task representing that operation. The same policy can
also be reused by existing eager ResultAsync factories during migration.

```ts
import { Clock, ResultTask, Retry, createTaggedError } from "resultar";

class ProviderError extends createTaggedError({
  name: "ProviderError",
  message: "Provider is temporarily unavailable",
}) {}

const policy = Retry.policy<ProviderError>({
  times: 2,
  delayMs: 100,
  backoff: 2,
  jittered: 0.2,
  while: (error) => ProviderError.is(error),
});

let attempts = 0;
const read = ResultTask.sync(() => ++attempts).andThen((attempt) =>
  attempt < 3 ? ResultTask.err(new ProviderError()) : ResultTask.ok("ready"),
);
const task = read.retry(policy);

// Production runs use Clock.live by default. Tests supply time and randomness.
const clock = Clock.virtual(0, () => 0.5);
const running = task.runResult({ clock });
await clock.advanceBy(300);
const result = await running;

console.log(result.unwrapOr("Unavailable")); // ready
console.log(attempts, clock.now(), clock.pending); // 3, 300, 0
```

`times: 2` means at most three attempts: the initial attempt plus two retries.
Portable callbacks receive a zero-based `RetryContext`; the first failure has
`attempt: 0`, `nextAttempt: 1` and `retriesRemaining: 2`. The delays above are
100 ms and 200 ms because the virtual random value selects the middle of each
jitter range. A policy holds configuration, not attempt state; executions do not
share their retry progress.

Task retries close each attempt's scope before the next starts. They retry simple
typed failures selected by `while`; defects, interruption and composite causes
propagate. Apply the policy to the repeatable operation, rather than replaying
unrelated writes in the whole use case. Existing retry options retain their own
callback signatures; use `Retry.policy` for a shared contract.

`ResultTask.sleep(ms)`, retry delays and task timeouts use the run clock. Build
the task, start the run with `{ clock }`, advance time, then await the pending run.
Virtual time does not control an external driver's own timers.

Runnable example: [task resilience](../examples/cookbook/src/task-resilience.ts).

## 7. Add owned concurrency with Fibers

For a batch, start with `ResultTask.all` or `forEach` and an explicit concurrency
limit. Use a Fiber when a workflow needs a handle to an individual child, such as
work it may later join, inspect or interrupt. `forkChild` runs during execution
and attaches the child to the current scope.

```ts
import { Clock, Fiber, ResultTask } from "resultar";

const released: string[] = [];
const read = (name: string, milliseconds: number) =>
  ResultTask.scoped(ResultTask.gen(function* () {
    const connection = yield* ResultTask.acquireRelease({
      acquire: ResultTask.ok(name),
      release: (resource) => ResultTask.sync(() => { released.push(resource); }),
    });
    yield* ResultTask.sleep(milliseconds);
    return connection;
  }));

const program = ResultTask.scoped(ResultTask.gen(function* () {
  const primary = yield* ResultTask.forkChild(read("primary", 10));
  const secondary = yield* ResultTask.forkChild(read("secondary", 20));
  const first = yield* Fiber.join(primary);
  const second = yield* Fiber.join(secondary);
  return { first, second };
}));

const clock = Clock.virtual();
const running = program.runExit({ clock });
await clock.advanceBy(20);
console.log(await running);
console.log(released); // ["primary", "secondary"]
```

`Fiber.join` propagates the child's outcome into the parent workflow.
`Fiber.await` observes the complete child Exit without requesting cancellation.
`Fiber.interrupt` requests cancellation, waits for finalizers, then returns that
Exit. These operations are tasks: compose them with `yield*` or execute them at a
run boundary.

When the owning scope closes, it interrupts active children and waits for their
cleanup before releasing parent resources. An unobserved child failure remains
part of the scope's error requirements. Keep the Fiber inside its owner's lifetime
instead of starting detached work from a request. Forward the execution signal to
drivers; cancellation is cooperative and cleanup can outlast a timeout.

Runnable examples: [task resilience](../examples/cookbook/src/task-resilience.ts)
and [application resource lifetime](../examples/cookbook/src/application-lifecycle.ts).

## 8. Choose the outer boundary explicitly

Prefer instance runners in new code. Each has an equivalent static form with the same options,
service checks, and deferred scope error types:

| Instance form               | Equivalent static form                  |
| --------------------------- | --------------------------------------- |
| `task.runResult(options?)`  | `ResultTask.runResult(task, options?)`  |
| `task.runPromise(options?)` | `ResultTask.runPromise(task, options?)` |
| `task.runExit(options?)`    | `ResultTask.runExit(task, options?)`    |
| `task.runFork(options?)`    | `ResultTask.runFork(task, options?)`    |

The options include `services`, `signal`, `clock`, `scheduler`, and `yieldEvery`. Required services
remain checked; pending release errors join the boundary error union (`E | ScopeError<R>` internally).
Every call executes the Task again. There is no public `task.run()` method, and awaiting a Task
without a runner leaves it unexecuted.

Use `runResult` when a boundary wants an in-flight `ResultAsync<T, E>` (`PromiseLike<Result<T, E>>`)
and already has a rejection policy for unexpected failures. It turns a single typed failure
into `Err`; defects, interruption and composite causes reject.

Use `runExit` when the boundary must inspect every task outcome as a value. This
becomes especially useful with Fibers and resources because a body and its cleanup,
or several children, can fail together.

```ts
import { Cause, ResultTask, createTaggedError } from "resultar";

class LoadUserError extends createTaggedError({
  name: "LoadUserError",
  message: "Could not load user $id",
}) {}

const task = ResultTask.err(new LoadUserError({ id: "user_123" }));
const exit = await task.runExit();

if (exit._tag === "Success") {
  console.log(exit.value);
} else if (exit.cause._tag === "Fail") {
  console.log({ status: 503, message: exit.cause.error.message });
} else {
  console.error(Cause.pretty(exit.cause));
}
```

`runExit` retains `Fail`, `Die`, `Interrupt`, `Sequential` and `Parallel` causes.
Use `Cause` helpers to inspect the full tree. `runPromise` is a separate adapter
for a Promise-only boundary that deliberately resolves `T` or rejects a failure.
`task.runFork(options)` immediately starts a root fiber and returns its `FiberHandle`,
which owns observation, interruption, and awaited cleanup.
Keep these execution decisions at the transport, job or application boundary;
the inner use case can remain lazy.

Run the checked cookbook from the repository root with
`pnpm run example:cookbook`. The [cookbook index](../examples/cookbook/README.md)
links to the synchronous, async, task and resource examples, and the
[API guide](../packages/resultar/README.md) documents their complete contracts.
