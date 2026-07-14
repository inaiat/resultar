# Resultar Implementation Patterns

Use these patterns as starting points, then align names and types with the consuming domain.

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

const createUser = (input: CreateUserInput): StrictResultAsync<User, CreateUserError> =>
  validateEmail(input.email)
    .asyncAndThen(ensureEmailAvailable)
    .andThen((email) => saveUser({ ...input, email }));
```

- Use `map` only for an infallible value transform.
- Use `filterOrElse` for predicate validation.
- Use `andThen` when the next operation can fail.
- Use `asyncAndThen` only for the sync-to-async bridge.
- Keep each function's error type narrow and allow the final union to be inferred.

## Write A Linear Workflow

```ts
const createUser = (input: CreateUserInput): StrictResultAsync<User, CreateUserError> =>
  safeTry(async function* () {
    const email = yield* validateEmail(input.email);
    yield* ensureEmailAvailable(email);
    const user = yield* saveUser({ ...input, email });

    return ok(user);
  });
```

Use `yield*` for every fallible Resultar step. Wrap an uncontrolled promise with
`tryResultAsync` before yielding it. Do not mix raw `await` or broad `try/catch` into the generator.

## Wrap External Work

```ts
class ProfileApiError extends createTaggedError({
  name: "ProfileApiError",
  message: "Profile API failed for $userId",
}) {}

type LoadProfileOptions = {
  readonly attempt?: number;
  readonly signal?: AbortSignal;
};

const loadProfile = (
  userId: string,
  options: LoadProfileOptions = {},
): StrictResultAsync<Profile, ProfileApiError> =>
  tryResultAsync(
    () => profileClient.load(userId, options),
    (cause) => new ProfileApiError({ cause, userId }),
  );
```

Prefer a promise factory because creating the promise may throw synchronously. Use
`fromPromise(existingPromise, mapper)` only when the promise already exists, and use
`fromSafePromise` only when non-rejection is guaranteed by contract.

For callback or subscription APIs, use `fromCallback` and return cleanup from `subscribe`:

```ts
const message = fromCallback<Message, SubscriptionError>({
  catch: (cause) => new SubscriptionError({ cause, topic }),
  signal,
  subscribe: ({ resolve, reject }) => {
    const subscription = client.subscribe(topic, resolve, reject);

    return () => subscription.close();
  },
});
```

Check the installed `ResultAsyncFromCallbackOptions` type for exact client integration details.

## Apply Retry And Timeout Policy

```ts
const profile = ResultAsync.timeout(
  (signal) =>
    ResultAsync.retry(
      (attempt, retrySignal) => loadProfile(userId, { attempt, signal: retrySignal }),
      {
        times: 2,
        delayMs: ({ nextAttempt }) => nextAttempt * 100,
        jittered: 0.2,
        while: (error) => error._tag === "ProfileApiError",
        signal,
      },
    ),
  {
    timeoutMs: 1_500,
    onTimeout: () => new ProfileTimeoutError({ timeoutMs: 1_500, userId }),
  },
);
```

Forward the supplied signal into the underlying operation. Confirm whether the desired timeout
covers each attempt or the complete retry budget, then nest the policies accordingly. Use
`retryOrElse` only when fallback after exhaustion is domain policy.

Choose races deliberately:

- `race` / `raceAll`: first settled `Ok` or `Err` wins.
- `raceFirst`: first `Ok` wins; both must fail before an `Err` is returned.
- `raceWith`: winner-specific logic needs access to the still-running task.

## Process Batches

Stop at the first error with bounded concurrency:

```ts
const saved = ResultAsync.forEach(rows, saveRow, { concurrency: 8 });
```

Collect all independent errors instead:

```ts
const validated = ResultAsync.validateAll(rows, validateRow, { concurrency: 8 });
```

Use `{ discard: true }` with `forEach` when successful values are intentionally unused. Do not
silently discard the returned `ResultAsync` itself.

## Acquire And Release Resources

```ts
const imported = ResultAsync.withResource({
  acquire: (signal) => openImportSession({ signal }),
  use: (session, signal) => importRows(session, rows, { signal }),
  release: (session) => session.close(),
});
```

Release runs after every successful acquire path, but release failures are best-effort. If cleanup
failure must affect the returned result, include that operation in `use` or otherwise model it as a
typed Resultar step.

## Recover Locally And Match At Boundaries

Recover only where the fallback is part of application policy:

```ts
const profile = loadProfile(userId).catchTags({
  ProfileNotFoundError: () => ok(defaultProfile),
  ProfileDisabledError: () => ok(disabledProfile),
});
```

Unhandled tags remain in the error channel. At the HTTP boundary, map the complete union:

```ts
const response = await createUser(input).matchTags((user) => ({ body: user, statusCode: 201 }), {
  InvalidEmailError: (error) => ({ body: error.toJSON(), statusCode: 400 }),
  UserAlreadyExistsError: (error) => ({ body: error.toJSON(), statusCode: 409 }),
  SaveUserError: (error) => ({ body: error.toJSON(), statusCode: 500 }),
});
```

Use `matchTagsPartial` only when a shared fallback is intentional. Keep HTTP status codes out of
domain functions.

## Add Observability

```ts
const observed = loadProfile(userId)
  .tap((profile) => metrics.increment("profile.loaded", { userId: profile.userId }))
  .tapError((error) => metrics.increment("profile.failed", { tag: error._tag }))
  .log((profile, error) => logger.info({ error, profile }, "profile result"));
```

These callbacks are best-effort and cannot change the result. Use `andThen` or `orElse` when a
logging, auditing, publishing, or cleanup failure must affect control flow.

## Migrate Incrementally

1. Identify the outermost throwing or rejecting dependency.
2. Create concrete tagged errors for expected domain and infrastructure failures.
3. Wrap throws and rejections at that edge with `tryResult` or `tryResultAsync`.
4. Change callers to compose with `map`, `andThen`, `asyncAndThen`, and `mapErr`.
5. Move transport conversion to one boundary matcher.
6. Replace broad error types and unsafe casts with inferred unions.
7. Enable `resultar-check` rules and remove narrow temporary exceptions.

Avoid converting the whole codebase in one unsafe cast. A wrapper at an integration seam lets the
typed error channel spread in reviewable steps.

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
