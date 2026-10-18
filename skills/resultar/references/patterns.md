# Resultar Implementation Patterns

Use these v4 patterns as starting points, then align names and types with the consuming domain.
New async recipes use lazy, nonthenable `ResultTask` from `resultar`. Preserve deprecated
`ResultAsync` from the `resultar/async` subpath where a boundary requires eager execution;
both entry points ship in one npm package, and existing main-entry Async exports remain available.

## Contents

- [Model A Domain Failure](#model-a-domain-failure)
- [Compose Sync And Async Steps](#compose-sync-and-async-steps)
- [Write A Linear Workflow](#write-a-linear-workflow)
- [Wrap External Work](#wrap-external-work)
- [Apply Retry And Timeout Policy](#apply-retry-and-timeout-policy)
- [Process Batches](#process-batches)
- [Acquire And Release Resources](#acquire-and-release-resources)
- [Recover Locally And Match At Boundaries](#recover-locally-and-match-at-boundaries)
- [Add Observability](#add-observability)
- [Migrate Incrementally](#migrate-incrementally)
- [Preserve An Eager Compatibility Contract](#preserve-an-eager-compatibility-contract)
- [Test Runtime And Type Behavior](#test-runtime-and-type-behavior)

## Model A Domain Failure

```ts
import { createTaggedError, ok } from "resultar";
import type { StrictResult } from "resultar";

class InvalidEmailError extends createTaggedError({
  name: "InvalidEmailError",
  message: "Invalid email $email",
}) {}

const validateEmail = (email: string): StrictResult<string, InvalidEmailError> =>
  email.includes("@") ? ok(email.trim().toLowerCase()) : InvalidEmailError.err({ email });
```

Use real tagged errors when the failure crosses a service, HTTP, job, queue, CLI, or integration
boundary. Keep strings, enums, or `TaggedEnum` variants for intentionally local flows.

## Compose Sync And Async Steps

```ts
type CreateUserError = InvalidEmailError | UserAlreadyExistsError | SaveUserError;

const createUser = (input: CreateUserInput): ResultTask<User, CreateUserError> =>
  ResultTask.fromResult(validateEmail(input.email))
    .andThen(ensureEmailAvailable)
    .andThen((email) => saveUser({ ...input, email }));
```

- `ensureEmailAvailable` and `saveUser` return Tasks. Use `map` only for a synchronous value transform;
  `ResultTask.map(asyncCallback)` stores a Promise as the success value.
- Use `filterOrElse` for predicate validation.
- Use `andThen` when the next operation can fail.
- Use `ResultTask.fromResult` to enter a lazy workflow from a synchronous Result. The free
  `asyncAndThen(result, callback)` from `resultar/async` bridges into the eager compatibility model;
  Existing Result `asyncAndThen` methods and statics remain supported.
- Keep each function's error type narrow and allow the final union to be inferred.

## Write A Linear Workflow

```ts
const createUser = (input: CreateUserInput): ResultTask<User, CreateUserError> =>
  ResultTask.gen(function* () {
    const email = yield* validateEmail(input.email);
    yield* ensureEmailAvailable(email);
    const user = yield* saveUser({ ...input, email });

    return user;
  });
```

Use `yield*` for every fallible step and return the plain success value. This generator can compose
Tasks, synchronous Results, and service tags. Wrap uncontrolled Promise factories with
`ResultTask.tryPromise`; adapt an eager adapter inside `ResultTask.fromResultAsync(factory)`.
`return yield* finalStep()` executes the last step; `return finalStep()` leaves its Task as a value.
Execute the workflow explicitly at its boundary.

For a wholly synchronous linear flow, use `Result.gen(function* () { ... })` with the same
plain-value return convention. `Result.gen` / `Result.fn` also support eager async bodies;
`safeTry` supports both forms with final-Result returns. Explicit eager recipes use
`gen` / `fn` / `safeTry` from `resultar/async`, usually imported with
`Async` aliases. The legacy `safeTry` contract returns a final Result; it is not an alias of modern
plain-value `gen`.

## Wrap External Work

```ts
class ProfileApiError extends createTaggedError({
  name: "ProfileApiError",
  message: "Profile API failed for $userId",
}) {}

type LoadProfileOptions = {
  readonly attempt?: number;
};

const loadProfile = (
  userId: string,
  options: LoadProfileOptions = {},
): ResultTask<Profile, ProfileApiError> =>
  ResultTask.tryPromise({
    try: (signal) => profileClient.load(userId, { ...options, signal }),
    catch: (cause) => new ProfileApiError({ cause, userId }),
  });
```

The Promise factory runs on each Task execution, catching both synchronous throws and rejections.
Pass its signal into the client. Building a Task around an already-created Promise cannot defer or
repeat that Promise's work.

Existing `fromCallback` returns eager, deprecated Async. Invoke it inside a Task factory and return
cleanup from `subscribe`:

```ts
import { fromCallback } from "resultar/async";

const message = ResultTask.fromResultAsync((signal) =>
  fromCallback<Message, SubscriptionError>({
    catch: (cause) => new SubscriptionError({ cause, topic }),
    signal,
    subscribe: ({ resolve, reject }) => {
      const subscription = client.subscribe(topic, resolve, reject);

      return () => subscription.close();
    },
  }),
);
```

Check the installed `ResultAsyncFromCallbackOptions` type for exact client integration details.

## Apply Retry And Timeout Policy

```ts
const profile = loadProfile(userId)
  .retry(
    Retry.policy<ProfileApiError>({
      times: 2,
      delayMs: ({ nextAttempt }) => nextAttempt * 100,
      jittered: 0.2,
      while: (error) => error._tag === "ProfileApiError",
    }),
  )
  .timeout(1_500, () => new ProfileTimeoutError({ timeoutMs: 1_500, userId }));
```

Forward the supplied signal into the underlying operation. Confirm whether the desired timeout
covers each attempt or the complete retry budget, then nest the policies accordingly. Use
`orElse` after retry only when fallback after exhaustion is domain policy. `retryOrElse` remains an
Async compatibility helper; it is not a Task method.

For a policy reused across Task workflows and an existing eager contract, construct the portable
contract explicitly:

```ts
import { Retry } from "resultar";
import { ResultAsync } from "resultar/async";

const retryPolicy = Retry.policy({
  times: 2,
  delayMs: 100,
  backoff: 2,
  jittered: 0.2,
});

const lazy = loadProfile(userId).retry(retryPolicy);
// Existing eager adapter; loadProfileAsync still returns deprecated ResultAsync.
const eager = ResultAsync.retry(
  (attempt, signal) => loadProfileAsync(userId, { attempt, signal }),
  { ...retryPolicy, signal: requestSignal },
);
```

Both use zero-based context in `delayMs`, `while`, and `onRetry` callbacks; `times` counts retries
after the initial attempt. With `times: 2`, the first failure has two retries remaining. Canonical
`while` is called only when another retry can run, and `onRetry` is awaited but best-effort. Reuse
shares configuration, not progress. Task's older options remain supported: its callback retry index
is one-based and `jittered: true` samples between zero and the delay. Eager Async options have their
own callback arguments and jitter behavior; use the portable policy when sharing configuration.

For a task adapter, choose how interruption handles an uncooperative promise:

```ts
const read = ResultTask.tryPromise({
  try: (signal) => client.read(signal),
  catch: (cause) => new ReadError({ cause }),
  interruption: "detach",
});
```

The default is `"wait"`. `"detach"` allows interruption to finish without waiting for the promise,
while registered scope finalizers are still awaited. It does not stop the client. Keep resource
acquisition on `"wait"` when its completion must precede release; a detached adapter owns anything
it acquires after the task has stopped waiting.

At execution, configure cooperative yields when a long instruction chain must share the event loop:

```ts
const exit = await ResultTask.runExit(lazy, { yieldEvery: 256 });
```

The default is 2048 instructions with `Scheduler.live`. A custom `TaskScheduler` receives the
execution signal in `yield(signal)`. `Infinity` disables automatic yields. This does not interrupt
a synchronous client callback midway; it is separate from `clock` and retry timing.

Choose races deliberately:

- `ResultTask.race(left, right)`: first success wins; if both fail, preserve their causes in `Parallel`.
- `ResultTask.raceFirst(left, right)`: first completed outcome wins.

Task races and timeouts own their children and await loser cleanup. Existing Async `race` /
`raceAll` return the first `Ok` or the last completed `Err` if all fail; `raceFirst` returns the first
Result, and `raceWith` exposes a handle for custom policy. Those eager races and timeouts abort
pending losers without waiting for their settlement or cleanup.

For a scope-owned child, use `Fiber.await(child)` to observe its full Exit without requesting
interruption. Use `Fiber.join(child)` to compose its result, and `Fiber.interrupt(child)` to request
cancellation and await cleanup. Keep the parent scope open until child consumers finish.

## Process Batches

Stop at the first error with bounded concurrency:

```ts
const saved = ResultTask.forEach(rows, saveRow, { concurrency: 8 });
```

Collect all independent errors instead:

```ts
const validated = ResultTask.validateAll(rows, validateRow, { concurrency: 8 });
```

The mappers return Tasks; lift a synchronous validation with `ResultTask.fromResult` when needed.
Use `.asVoid()` on the returned Task when its successful array is intentionally unused; the
`{ discard: true }` option belongs to Result and Async collections. The Task still needs composition
or an explicit runner; discarding it does not run the batch.

## Acquire And Release Resources

```ts
const imported = ResultTask.scoped(
  ResultTask.gen(function* () {
    const session = yield* ResultTask.acquireRelease({
      acquire: openImportSession(),
      release: (resource) => resource.close(),
    });

    return yield* importRows(session, rows);
  }),
);
```

Here `openImportSession`, `resource.close`, and `importRows` return Tasks. Release runs once after
successful acquisition, is awaited on every exit, and preserves failures. The scope folds deferred
release errors into the workflow's error channel. Use `acquireDisposable` for native disposables,
or `ensuring(finalizer)` for unconditional Task cleanup that does not acquire a resource.

## Recover Locally And Match At Boundaries

Recover only where the fallback is part of application policy:

```ts
const profile = findProfile(userId).catchTags({
  ProfileNotFoundError: () => ok(defaultProfile),
  ProfileDisabledError: () => ok(disabledProfile),
});
```

Unhandled tags remain in the error channel. At the HTTP boundary, map the complete union:

```ts
const responseTask = createUser(input).matchTags((user) => ({ body: user, statusCode: 201 }), {
  InvalidEmailError: (error) => ({ body: error.toJSON(), statusCode: 400 }),
  UserAlreadyExistsError: (error) => ({ body: error.toJSON(), statusCode: 409 }),
  SaveUserError: (error) => ({ body: error.toJSON(), statusCode: 500 }),
});

const response = await ResultTask.runPromise(responseTask);
```

Use `matchTagsPartial` only when a shared fallback is intentional. Keep HTTP status codes out of
domain functions. Task matching is a lazy fold, so it remains composable until the runner.
`runExit` is the boundary to choose when defects, interruption, or composite causes also need inspection.

## Add Observability

```ts
const observed = loadProfile(userId)
  .inspect((profile) => metrics.increment("profile.loaded", { userId: profile.userId }))
  .inspectError((error) => metrics.increment("profile.failed", { tag: error._tag }))
  .log((profile, error) => logger.info({ error, profile }, "profile result"));
```

`inspect`, `inspectError`, `inspectBoth`, and `log` are best-effort across `Result`, `ResultAsync`, and `ResultTask`: observer failures are ignored, returned tasks are not executed, and the original result is preserved.
Deprecated `Result` and `ResultAsync` `tap` / `tapError` retain their best-effort behavior.
Only `ResultTask` `tap`, `tapError`, `tapCause`, and `tapBoth` compose effectful side operations:
they propagate returned Task failures and turn callback throws or rejected Promises into defects.
Use Task `tap`, `andThen`, or `orElse` when auditing, publishing, or cleanup must affect control flow.

## Migrate Incrementally

1. Identify the outermost throwing or rejecting dependency.
2. Create concrete tagged errors for expected domain and infrastructure failures.
3. Wrap synchronous throws with `tryResult` and new async work with `ResultTask.tryPromise`.
4. Return Tasks directly from lazy services and compose with `map`, `andThen`, and `mapErr`.
5. Move transport conversion to one boundary matcher.
6. Replace broad error types and unsafe casts with inferred unions.
7. Enable `resultar-check` rules and remove narrow temporary exceptions.

Avoid converting the whole codebase in one unsafe cast. A wrapper at an integration seam lets the
typed error channel spread in reviewable steps.

## Preserve An Eager Compatibility Contract

Import from `resultar/async` when compatibility is needed; the subpath ships with `resultar`.
`ResultAsync<T, E>` and `StrictResultAsync<T, E>` remain deprecated and retain eager behavior. Keep them when callers depend
on starting once at construction or awaiting the same execution:

```ts
import { ResultAsync, tryResultAsync } from "resultar/async";
import type { StrictResultAsync } from "resultar/async";

const loadProfileAsync = (userId: string): StrictResultAsync<Profile, ProfileApiError> =>
  tryResultAsync({
    try: () => profileClient.load(userId),
    catch: (cause) => new ProfileApiError({ cause, userId }),
  });

const loadProfileTask = (userId: string): ResultTask<Profile, ProfileApiError> =>
  ResultTask.fromResultAsync(() => loadProfileAsync(userId));

// A legacy caller receives one eagerly started execution.
const existingCaller = ResultAsync.fromTask(loadProfileTask(userId));
```

Use `fromPromise` for an already-created Promise and `fromSafePromise` only when rejection is
impossible by contract. Async `map` / `mapErr` still await Promise-returning callbacks; `andThen`
accepts Result or Async. Existing Result async methods remain supported; new eager recipes can
use the equivalent free functions:

```ts
import { asyncMap, asyncAndThen, okAsync } from "resultar/async";

const eagerMapped = asyncMap(ok(20), async (value) => value + 1);
const eagerChained = asyncAndThen(ok(20), (value) => okAsync(value + 1));
```

Both helpers also accept curried calls for `pipe`. All eager constructors and helpers, including
`errAsync`, are available from `resultar/async`; main-entry exports remain supported. Prefer
`errAsync(new DomainError(props))` and `ResultAsync.fromTask(task)` in new eager recipes;
`DomainError.errAsync(props)` and static/instance `ResultTask.toResultAsync` remain callable.
Async instance `match` / `matchTags` / `matchTagsPartial` return native Promises; static/curried
forms return composable Async values. Task matching returns a Task.

The eager facade keeps `retry` / `retryOrElse`, `timeout`, races, collections, and control flow.
Use Async factories for retries, and retain `withResource({ acquire, use, release })` where its
best-effort release is the existing contract. A cleanup failure that must affect that eager result
needs an explicit fallible step. These policies and deprecated observer methods are documented in
[the compatibility API reference](api.md#eager-async-compatibility-policies).

Core `Result.gen` / `Result.fn` support eager async bodies, and core `safeTry` supports legacy
async final-Result bodies. The subpath makes the eager generator imports explicit:

```ts
import { gen as genAsync, fn as fnAsync, safeTry as safeTryAsync } from "resultar/async";

const eagerWorkflow = genAsync(async function* () {
  const profile = yield* loadProfileAsync(userId);
  return profile;
});

const reusableEager = fnAsync(async function* (id: string) {
  return yield* loadProfileAsync(id);
});

const legacyEager = safeTryAsync(async function* () {
  const profile = yield* loadProfileAsync(userId);
  return ok(profile);
});
```

Do not change legacy `safeTry` generators to return plain values: their final value is a Result.
Modern `genAsync` retains plain-value returns. New synchronous generators use core `Result.gen`;
new lazy workflows use `ResultTask.gen`. Move legacy imports to `resultar/async` while preserving
eagerness; migrate a service to Task by changing creation, composition, runners, and callers together.

## Test Runtime And Type Behavior

```ts
import { equal, ok as assert } from "node:assert";
import { describe, expectTypeOf, it } from "vite-plus/test";

describe("validateEmail", () => {
  it("returns a typed tagged error", () => {
    const result = validateEmail("invalid");

    assert(result.isErr());
    equal(result.error._tag, "InvalidEmailError");
    expectTypeOf(result.error).toEqualTypeOf<InvalidEmailError>();
  });
});
```

Test every expected error path, not just `Ok`. Add type tests for inferred unions, required tagged
error props, narrowing, and exhaustive handlers. Use deterministic fake clocks, signals, and
clients for retry, timeout, cancellation, race, concurrency, and cleanup tests.
