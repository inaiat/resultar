# Adopt Resultar gradually

Start by making one expected failure explicit with `Result<T, E>`. Keep existing
Promise APIs at their boundaries, then move one use case to `ResultTask` when it
needs reusable execution, time policies, service requirements or owned concurrent
work. Each step is useful on its own; an application can keep all three models.

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
| Requirement-free async work (`R = never`) | `ResultAsync<T, E>` (`ResultTask<T, E, never>`) | When `await`ed or passed to `run*` (or immediately if wrapping an existing `Promise`) |
| A reusable workflow with service/scope requirements (`R`) or custom runtime options | `ResultTask<T, E, R>` | At a `run*` boundary (or `await` once `R = never`), again on each run |

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

Runnable example: [synchronous validation](../examples/resultar/src/sync-validation.ts).

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
Do not rely on generator `finally` for cleanup after an early `Err` in this model;
use task resource scopes when cleanup becomes part of the workflow contract.

Runnable example: [domain composition](../examples/resultar/src/domain-workflow.ts).

## 3. Wrap existing Promises with ResultAsync

Adopt typed asynchronous errors with `ResultAsync<T, E>` (`ResultTask<T, E, never>`).
`tryResultAsync` wraps both synchronous throws while creating a Promise and
later rejections, and can be `await`ed directly to produce `Result<T, E>`. For an already-created Promise,
use `ResultAsync.fromPromise(promise, toError)`.

```ts
import { Result, createTaggedError, ok, tryResultAsync, type ResultAsync } from "resultar";

interface User {
  readonly id: string;
  readonly name: string;
}

class LoadUserError extends createTaggedError({
  name: "LoadUserError",
  message: "Could not load user $id",
}) {}

// Stand-in for an existing driver; replace its body with your Promise API.
const readUser = async (id: string): Promise<User> => ({ id, name: "Ada" });

const loadUser = (id: string): ResultAsync<User, LoadUserError> =>
  tryResultAsync({
    try: () => readUser(id),
    catch: (cause) => new LoadUserError({ id, cause }),
  });

const greeting = (id: string) =>
  Result.gen(async function* () {
    const user = yield* loadUser(id);
    return `Hello, ${user.name}`;
  });

const result = await greeting("user_123");
const response = result.match({
  ok: (message) => ({ status: 200, body: { message } }),
  err: (error) => ({ status: 503, body: { message: error.message } }),
});

console.log(response);
```

`Result.gen` with an async generator returns `ResultAsync` and wraps the returned plain
value in `Ok`; use `yield*` for fallible steps and early error returns. Yield wrapped Results instead of raw Promises. Callers that
must return a native Promise can keep a small Promise adapter at their framework
boundary while the internal use case returns `ResultAsync` directly.

Runnable examples: [edge wrapping](../examples/resultar/src/edge-wrapping.ts) and
[async resilience](../examples/resultar/src/async-resilience.ts).

## 4. Move one use case to ResultTask

Introduce `ResultTask.gen` for a selected use case and reuse its existing `Result` and
`ResultAsync` helpers directly via `yield*`. Task generators return a **plain success value**.

```ts
import { ResultTask, createTaggedError, ok, tryResultAsync, type Result } from "resultar";

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
    const user = yield* loadUser(id);
    return `Hello, ${user.name}`;
  });

// Existing callers keep an awaitable ResultAsync contract (since R = never).
const greeting = (id: string) => ResultTask.toResultAsync(greetingTask(id));

console.log((await greeting("user_123")).unwrapOr("Unavailable"));

// Callers can also pass a task to an explicit execution boundary with runtime options.
const task = greetingTask("user_123");
const result = await ResultTask.runResult(task);
console.log(result.unwrapOr("Unavailable"));
```

Because `ResultAsync<T, E>` is `ResultTask<T, E, never>`, `toResultAsync` accepts any
task with no remaining requirements (`R = never`). Provide services
and wrap scope-dependent work with `ResultTask.scoped` before bridging or `await`ing when
needed. Its underlying `runResult` boundary can still reject on defects,
interruption or composite causes.

For Promise adapters that need the active cancellation signal, use `ResultTask.tryPromise({ try: signal => ..., catch })`
or `ResultTask.fromResultAsync(signal => load(signal))` and pass the signal to a cooperative driver.

| Bridge | Execution behavior |
| --- | --- |
| `ResultTask.fromResult(result)` | Wraps a synchronous `Result` that has already been computed |
| `ResultTask.fromResultAsync(existing)` | Wraps an existing `ResultAsync` / `ResultTask<T, E, never>` |
| `ResultTask.fromResultAsync(signal => load(signal))` | Evaluates the factory with the active `AbortSignal` on each task run |
| `ResultTask.tryPromise({ try, catch })` | Calls the Promise factory on each task run |
| `ResultTask.toResultAsync(task)` | Returns the requirement-free `ResultTask<T, E, never>` as `ResultAsync<T, E>` |

Capturing an already-started `Promise` via `fromPromise` cannot undo its execution; use
`tryResultAsync` or `ResultTask.tryPromise` so each task run and retry creates a fresh operation. `fromResult` has no
factory overload; defer a Result-producing call inside `ResultTask.gen` as above.

## 5. Add services where a task needs them

Keep ordinary function parameters until a task benefits from typed service
requirements. A service tag records its requirement in `R`; the run boundary
supplies the implementation. The repository can still return ResultAsync.

```ts
import { ResultTask, createTaggedError, tryResultAsync, type ResultAsync } from "resultar";

interface User {
  readonly id: string;
  readonly name: string;
}

class LoadUserError extends createTaggedError({
  name: "LoadUserError",
  message: "Could not load user $id",
}) {}

interface UserRepository {
  readonly load: (id: string, signal: AbortSignal) => ResultAsync<User, LoadUserError>;
}

const Users = ResultTask.service<UserRepository>()("Users");

const greeting = ResultTask.gen(function* () {
  const users = yield* Users;
  const user = yield* ResultTask.fromResultAsync((signal) => users.load("user_123", signal));
  return `Hello, ${user.name}`;
});

const users: UserRepository = {
  load: (id, signal) =>
    tryResultAsync({
      try: async () => {
        signal.throwIfAborted();
        return { id, name: "Ada" };
      },
      catch: (cause) => new LoadUserError({ id, cause }),
    }),
};

const result = await ResultTask.runResult(greeting, { services: { Users: users } });
console.log(result.unwrapOr("Unavailable"));
```

Omitting `Users` is a type error. Bind it earlier with
`ResultTask.provideService(greeting, Users, users)` when an eager compatibility
facade needs a requirement-free task. A DI container is optional; see the
[service guide](../packages/resultar/README.md#lazy-workflows-with-resulttask) and
[resultar-di](../packages/di/README.md) when lifetimes span several use cases.

## 6. Reuse retry policy and make time deterministic

Introduce retry around an operation that is safe to repeat, such as a read.
`Retry.policy` works with existing eager ResultAsync factories and lazy tasks, so
policy adoption can happen before execution-model migration.

```ts
import { Clock, ResultAsync, ResultTask, Retry, createTaggedError, tryResultAsync } from "resultar";

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

const eager = () =>
  ResultAsync.retry(
    () => tryResultAsync({
      try: async () => "ready",
      catch: (cause) => new ProviderError({ cause }),
    }),
    policy,
  );

console.log((await eager()).unwrapOr("Unavailable"));

let attempts = 0;
const read = ResultTask.sync(() => ++attempts).andThen((attempt) =>
  attempt < 3 ? ResultTask.err(new ProviderError()) : ResultTask.ok("ready"),
);
const task = read.retry(policy);

// Production runs use Clock.live by default. Tests supply time and randomness.
const clock = Clock.virtual(0, () => 0.5);
const running = ResultTask.runResult(task, { clock });
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

Runnable example: [task resilience](../examples/resultar/src/task-resilience.ts).

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
const running = ResultTask.runExit(program, { clock });
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

Runnable examples: [task resilience](../examples/resultar/src/task-resilience.ts)
and [application resource lifetime](../examples/resultar/src/application-lifecycle.ts).

## 8. Choose the outer boundary explicitly

Use `runResult` when an integration expects `Promise<Result<T, E>>` and already
has a rejection policy for unexpected failures. It turns a single typed failure
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
const exit = await ResultTask.runExit(task);

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
Keep these execution decisions at the transport, job or application boundary;
the inner use case can remain lazy.

Run the checked cookbook from the repository root with
`pnpm run example:resultar`. The [cookbook index](../examples/resultar/README.md)
links to the synchronous, async, task and resource examples, and the
[API guide](../packages/resultar/README.md) documents their complete contracts.
