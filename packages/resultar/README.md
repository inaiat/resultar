# Resultar

Production-facing error handling for TypeScript, without a runtime.

Full documentation, long-form recipes, and the complete API map live in
[DOCUMENTATION.md](../../DOCUMENTATION.md).

## New In 3.1

Resultar 3.1 turns common production async policies into typed values instead of rejected promises,
hidden timers, or helper code that throws.

- `ResultAsync.timeout`, `retry`, `retryOrElse`, `race`, `raceAll`, and `withResource` cover
  timeouts, retry policy, fallback, replica reads, and cleanup while preserving the expected error
  type.
- `ResultAsync.forEach` and `ResultAsync.validateAll` support sequential work, bounded
  `{ concurrency }`, and explicit unbounded execution for batch processing and validation.
- `AbortError` / `isAbortError` and redacted tagged-error props with `redact`, `isRedacted`, and
  `revealRedacted` make cancellation and sensitive error metadata visible at the type boundary.

## Main Functionalities

Resultar gives you typed `Result` primitives, real `Error`-based tagged failures, async control
helpers, sync/async composition, and optional no-discard diagnostics. It is small enough to adopt in
one module and strict enough to use at service, HTTP, job, queue, CLI, and integration boundaries.

```ts
Result<T, E>
ResultAsync<T, E>
StrictResult<T, E extends Error>
StrictResultAsync<T, E extends Error>
```

Use it when expected failures should be impossible to miss:

- Function signatures show both the success type and the expected error type.
- Domain errors are real `Error` instances with stable tags, messages, `cause`, stack traces, and
  JSON output.
- `ResultAsync` can bound concurrent work, race replicas, apply typed timeouts, retry transient
  failures, and pair acquisition with cleanup without adding a runtime scheduler.
- Sync and async fallible work compose without `try/catch` blocks scattered through application
  code.
- Ignored `Result` values can be reported by a type-aware no-discard check.

Resultar began as an initial fork of `neverthrow`. The v3 line keeps the explicit wrapper model,
then leans into Resultar-specific tagged errors, strict service-boundary types, TypeScript 7-first
diagnostics, and ESM-only packaging.

## Install

```sh
pnpm add resultar
```

```sh
npm install resultar
```

## Requirements

- Node.js 24+
- TypeScript 7 for the canonical Resultar diagnostics workflow
- ESM only

```ts
import { createTaggedError, ok } from 'resultar'
import type { StrictResult } from 'resultar'
```

CommonJS `require('resultar')` is not exported.

## Mutation Testing

The core runtime package has a scoped Stryker setup for mutation testing:

```sh
pnpm --filter resultar test:mutation
```

The setup lives in [`stryker.conf.json`](./stryker.conf.json) and is intentionally separate from
`check:full`. It mutates the central runtime files under `src/`, uses the Vitest runner with
per-test coverage, stores incremental state under `reports/`, and keeps baseline thresholds
report-only while the mutation score is established. The dedicated
[`vitest-stryker.config.ts`](./vitest-stryker.config.ts) maps `vite-plus/test` to `vitest` so
Stryker can run the same tests without the `vp test` bootstrap.

## Why Teams Use It

This signature hides an expected failure:

```ts
const parsePort = (value: string): number => {
  const port = Number(value)

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid port ${value}`)
  }

  return port
}
```

This signature makes the failure part of the contract:

```ts
import { createTaggedError, ok } from 'resultar'
import type { StrictResult } from 'resultar'

class InvalidPortError extends createTaggedError({
  name: 'InvalidPortError',
  message: 'Invalid port $value',
}) {}

const parsePort = (value: string): StrictResult<number, InvalidPortError> => {
  const port = Number(value)

  return Number.isInteger(port) && port > 0 ? ok(port) : InvalidPortError.err({ value })
}
```

Callers now know the success type and the expected error type without reading the implementation.
That is the main trade: expected failures become visible contracts instead of tribal knowledge.

Resultar is intentionally not an application runtime. It gives you explicit error values that work
in normal TypeScript.

## What You Get

| Problem | Resultar gives you |
| --- | --- |
| Expected failures are hidden behind `throw` | `Result<T, E>` and `ResultAsync<T, E>` in function signatures |
| Production errors need stable names and metadata | `createTaggedError` classes with `_tag`, template props, `cause`, and `.toJSON()` |
| Async flows turn into nested `try/catch` | `tryResultAsync`, `andThen`, `asyncAndThen`, `map`, `orElse`, `safeTry` |
| Network calls need timeouts, retries, and fallback policy | `ResultAsync.timeout`, `retry`, `retryOrElse`, `race`, and `raceAll` |
| Batch work needs backpressure without a framework | `ResultAsync.forEach` and mapped `validateAll` with `{ concurrency }` |
| Resourceful work needs cleanup on every path | `ResultAsync.withResource` and native `AsyncIterable<Result<T, E>>` recipes |
| Boundary handlers miss cases | `matchTags` for exhaustive tagged-error handling |
| Results are easy to ignore | `resultar-check` and the `resultar-check` TypeScript plugin |
| You do not want another application runtime | A small ESM library around explicit values |

Nested `try/catch` often masks the error the caller actually needs:

```ts
const getPosts = async (url: string) => {
  try {
    const response = await fetch(url)

    if (response.status >= 400) {
      throw new HttpClientError(response.status)
    }

    return response.json() as Promise<Post[]>
  } catch (cause) {
    throw new InfrastructureError({ cause })
  }
}
```

Resultar keeps each failure explicit and typed:

```ts
const getPosts = (
  url: string,
): StrictResultAsync<Post[], FetchPostsError | HttpClientError | ParsePostsError> =>
  tryResultAsync(fetch(url), (cause) => new FetchPostsError({ cause }))
    .andThen((response) =>
      response.status >= 400 ? HttpClientError.err({ status: response.status }) : ok(response),
    )
    .andThen((response) =>
      tryResultAsync(response.json() as Promise<Post[]>, (cause) => new ParsePostsError({ cause })),
    )
```

## Async Control Without A Runtime

The 3.1 async helpers cover common production workflows while keeping plain `Promise` and
`AbortSignal`-compatible APIs underneath. You choose the policy in the type signature instead of
hiding it in a helper that throws.

Retry transient work and fall back to cache only after the retry policy is exhausted:

```ts
const user = ResultAsync.retryOrElse(
  (attempt, signal) => fetchUser(id, { attempt, signal }),
  {
    times: 2,
    delayMs: ({ nextAttempt }) => nextAttempt * 100,
    jittered: 0.5,
    while: (error) => error._tag === 'RateLimitError' || error._tag === 'ServiceUnavailableError',
    orElse: () => readCachedUser(id),
  },
)
```

`jittered` randomizes the computed retry delay by a percentage factor to avoid synchronized retries.
For example, `delayMs: 100` with `jittered: 0.5` waits between `50ms` and `150ms`; omit it or use
`0` to keep the exact delay.

Race a primary and replica with cooperative loser abort:

```ts
const user = ResultAsync.race(
  (signal) => readUserFromPrimary(id, { signal }),
  (signal) => readUserFromReplica(id, { signal }),
)
```

Keep timeout as a typed `Err`, not a rejected promise:

```ts
const user = ResultAsync.timeout(
  (signal) => readUserFromPrimary(id, { signal }),
  {
    timeoutMs: 1_500,
    onTimeout: () => new FetchUserTimeoutError({ id, timeoutMs: 1_500 }),
  },
)
```

Process batches with bounded concurrency and explicit cleanup:

```ts
const imported = ResultAsync.withResource({
  acquire: (signal) => openImportSession({ signal }),
  use: (session, signal) =>
    ResultAsync.forEach(
      rows,
      (row) => importRow(session, row, { signal }),
      { concurrency: 8, discard: true },
    ),
  release: (session) => session.close(),
})
```

## Quick Start

```ts
import { createTaggedError, ok } from 'resultar'
import type { StrictResult } from 'resultar'

class InvalidEmailError extends createTaggedError({
  name: 'InvalidEmailError',
  message: 'Invalid email $email',
}) {}

class UserAlreadyExistsError extends createTaggedError({
  name: 'UserAlreadyExistsError',
  message: 'User $email already exists',
}) {}

type User = {
  readonly email: string
  readonly id: string
}

const validateEmail = (email: string): StrictResult<string, InvalidEmailError> =>
  email.includes('@') ? ok(email) : InvalidEmailError.err({ email })

const ensureUserDoesNotExist = (
  email: string,
): StrictResult<string, UserAlreadyExistsError> =>
  email === 'taken@example.com' ? UserAlreadyExistsError.err({ email }) : ok(email)

const insertUser = (email: string): StrictResult<User, never> =>
  ok({ email, id: 'usr_123' })

const createUser = (
  email: string,
): StrictResult<User, InvalidEmailError | UserAlreadyExistsError> =>
  validateEmail(email).andThen(ensureUserDoesNotExist).andThen(insertUser)

const response = createUser('taken@example.com').matchTags(
  (user) => ({ body: user, statusCode: 201 }),
  {
    InvalidEmailError: (error) => ({
      body: { code: error._tag, message: error.message },
      statusCode: 400,
    }),
    UserAlreadyExistsError: (error) => ({
      body: { code: error._tag, message: error.message },
      statusCode: 409,
    }),
  },
)
```

## Core Model

`Result<T, E>` is a synchronous fallible value. It is either an `Ok<T>` or an `Err<E>`.

```ts
const result = parsePort('3000')

if (result.isOk()) {
  result.value
}

if (result.isErr()) {
  result.error
}
```

`ResultAsync<T, E>` is the async version. It wraps promise-based fallible work while keeping the
same composition API.

```ts
import { createTaggedError, fromPromise, ok, tryResultAsync } from 'resultar'
import type { StrictResult, StrictResultAsync } from 'resultar'

type User = {
  readonly id: string
}

class FetchUserError extends createTaggedError({
  name: 'FetchUserError',
  message: 'Failed to fetch user $id',
}) {}

class UserResponseError extends createTaggedError({
  name: 'UserResponseError',
  message: 'User request $id failed with status $status',
}) {}

class ParseUserError extends createTaggedError({
  name: 'ParseUserError',
  message: 'Failed to parse user $id response',
}) {}

class DecodeUserError extends createTaggedError({
  name: 'DecodeUserError',
  message: 'Invalid user $id response payload',
}) {}

const decodeUser = (input: unknown, id: string): StrictResult<User, DecodeUserError> => {
  if (
    typeof input === 'object' &&
    input !== null &&
    'id' in input &&
    typeof input.id === 'string'
  ) {
    return ok({ id: input.id })
  }

  return DecodeUserError.err({ id })
}

const fetchUser = (
  id: string,
): StrictResultAsync<User, FetchUserError | UserResponseError | ParseUserError | DecodeUserError> =>
  fromPromise(fetch(`https://example.com/users/${id}`), (cause) => new FetchUserError({ cause, id }))
    .andThen((response) =>
      response.ok ? ok(response) : UserResponseError.err({ id, status: response.status }),
    )
    .andThen((response) =>
      tryResultAsync<unknown, ParseUserError>(
        () => response.json(),
        (cause) => new ParseUserError({ cause, id }),
      ),
    )
    .andThen((input) => decodeUser(input, id))

const label = await fetchUser('usr_123').match(
  (user) => `User ${user.id}`,
  (error) => error.message,
)
```

This keeps network failures, non-2xx responses, JSON parse failures, and payload decode failures
separate. In production, treat parsing bytes into `unknown` and decoding `unknown` into a domain
type as different failure modes.

Use generic `Result<T, E>` for local flows where strings, enums, or small domain objects are useful
as `E`. Prefer `StrictResult<T, E extends Error>` and
`StrictResultAsync<T, E extends Error>` at service, HTTP, job, queue, CLI, and integration
boundaries.

## Tagged Errors

`createTaggedError` creates real `Error` subclasses with stable tags and typed message-template
props.

```ts
import { createTaggedError } from 'resultar'

class UserNotFoundError extends createTaggedError({
  name: 'UserNotFoundError',
  message: 'User $id not found in $source',
}) {}

const error = new UserNotFoundError({
  id: 'usr_123',
  source: 'database',
})

error instanceof Error // true
error instanceof UserNotFoundError // true
error._tag // 'UserNotFoundError'
error.message // 'User usr_123 not found in database'
error.id // string | number
error.source // string | number
```

Tagged errors include:

- `_tag`
- `messageTemplate`
- `fingerprint`
- `cause`
- `.toJSON()`
- `.findCause(ErrorClass)`
- static `.is(value)` for nominal checks
- static `.err(props)` for returning `Err`

Template variables are inferred from `$variables` in the message. Missing variables are TypeScript
errors.

```ts
new UserNotFoundError({ id: 'usr_123', source: 'database' })

// @ts-expect-error source is required
new UserNotFoundError({ id: 'usr_123' })
```

Use `TaggedEnum` only for lightweight tagged unions that do not need to be real errors.

```ts
import { taggedEnum } from 'resultar'
import type { TaggedEnum } from 'resultar'

type PaymentError = TaggedEnum<{
  CardDeclined: { readonly code: string }
  InsufficientFunds: { readonly balance: number }
}>

const PaymentError = taggedEnum<{
  CardDeclined: { readonly code: string }
  InsufficientFunds: { readonly balance: number }
}>()

const declined = PaymentError.CardDeclined({ code: 'card_declined' })

PaymentError.$is('CardDeclined', declined) // true
PaymentError.$match(declined, {
  CardDeclined: (error) => error.code,
  InsufficientFunds: (error) => String(error.balance),
})
```

Use `redact(value, label?)` for tagged error props that must not leak through messages or JSON.
Use `revealRedacted(value)` only at the exact boundary that is allowed to see the secret.

## Composing Results

Use `map` for infallible transforms:

```ts
const normalized = validateEmail('PERSON@EXAMPLE.COM').map((email) => email.toLowerCase())
```

Use `as` when success matters but the previous value does not:

```ts
const created = insertUser(user).as({ status: 'created' as const })
```

Use `andThen` when the next step can fail:

```ts
const user = validateEmail(email).andThen(ensureUserDoesNotExist).andThen(insertUser)
```

Use `asyncAndThen` when a sync result continues into async work:

```ts
const user = validateEmail(email).asyncAndThen(ensureUserDoesNotExistAsync).andThen(insertUserAsync)
```

Use `filterOrElse` when an `Ok` value must satisfy another predicate:

```ts
class InvalidDomainError extends createTaggedError({
  name: 'InvalidDomainError',
  message: 'Invalid email domain $domain',
}) {}

const validateCompanyEmail = (
  email: string,
): StrictResult<string, InvalidEmailError | InvalidDomainError> =>
  validateEmail(email).filterOrElse(
    (validEmail) => validEmail.endsWith('@company.com'),
    (validEmail) => new InvalidDomainError({ domain: validEmail.split('@')[1] ?? 'unknown' }),
  )
```

Use `catchTag` or `catchTags` for local recovery from tagged errors:

```ts
const draftUser = createUser('bad-email').catchTag('InvalidEmailError', (error) =>
  ok({
    email: error.email,
    id: 'draft_user',
  }),
)
```

## Reasoned Tagged Errors

Use `catchReason`, `catchReasons`, and `unwrapReason` when a stable parent error has a nested tagged
reason. This keeps the outer error useful for logs and boundaries while allowing local recovery by
the precise reason.

```ts
import { createTaggedError, err, ok, taggedEnum } from 'resultar'
import type { StrictResult, TaggedEnum } from 'resultar'

const AiReason = taggedEnum<{
  QuotaExceededError: { readonly limit: number }
  RateLimitError: { readonly retryAfterMs: number }
}>()

type AiReason = TaggedEnum<{
  QuotaExceededError: { readonly limit: number }
  RateLimitError: { readonly retryAfterMs: number }
}>

class AiError extends createTaggedError({
  name: 'AiError',
  message: 'AI request failed',
}) {
  public readonly reason: AiReason

  public constructor(props: { readonly cause?: unknown; readonly reason: AiReason }) {
    super({ cause: props.cause })
    this.reason = props.reason
  }
}

const askAi = (): StrictResult<string, AiError> =>
  err(new AiError({ reason: AiReason.RateLimitError({ retryAfterMs: 1_000 }) }))
```

```ts
const recovered = askAi().catchReason('AiError', 'RateLimitError', (reason) =>
  ok(`retry after ${reason.retryAfterMs}ms`),
)

const unwrapped = askAi().unwrapReason('AiError')
```

`catchReason` removes only the handled reason from the remaining error type. `unwrapReason` moves the
reason union into the error channel when the parent tag matches.

Use `match`, `matchTags`, or `matchTagsPartial` at boundaries where a result becomes a response,
log entry, queue acknowledgement, CLI exit code, or UI state.

```ts
const response = createUser(input.email).matchTagsPartial(
  (user) => ({ body: user, statusCode: 201 }),
  {
    InvalidEmailError: (error) => ({
      body: { code: error._tag, message: error.message },
      statusCode: 400,
    }),
  },
  (error) => ({
    body: { code: 'UnhandledError', message: error.message },
    statusCode: 500,
  }),
)
```

## Fallbacks

Use fallback APIs when an expected failure has a useful recovery path.

| Fallback idea | Resultar API |
| --- | --- |
| try another branch | `result.orElse(() => fallbackResult)` |
| replace the failure | `mapErr(...)` or `orElse(() => err(newError))` |
| replace the failure with success | `orElse(() => ok(defaultValue))` inside a pipeline |
| default at the edge | `unwrapOr(defaultValue)` |
| try ordered candidates | `Result.firstSuccessOf` or `ResultAsync.firstSuccessOf` |

Use `orElse` for pipeline recovery:

```ts
const user = readUserFromCache(id).orElse(() => readUserFromRemote(id))
```

Use `mapErr` when a low-level failure should become a domain failure:

```ts
const user = readUserFromRemote(id).mapErr(
  (cause) => new ReadUserError({ cause, id }),
)
```

Use `orElse(() => ok(defaultValue))` when fallback success should stay inside the pipeline:

```ts
const user = readUser(id).orElse(() =>
  ok({
    email: 'guest@example.com',
    id: 'guest',
  }),
)
```

Use `firstSuccessOf` when each fallback should run only if earlier candidates fail:

```ts
const user = ResultAsync.firstSuccessOf([
  () => readUserFromCache(id),
  () => readUserFromPrimary(id),
  () => readUserFromReplica(id),
])
```

Use `combine` with records when independent results should keep names:

```ts
const context = Result.combine({
  org: readOrg(orgId),
  user: readUser(userId),
})

const validated = Result.combineWithAllErrors({
  email: validateEmail(input.email),
  name: validateName(input.name),
})
```

For lazy async traversal, `ResultAsync.forEach` and mapped `ResultAsync.validateAll` run
sequentially by default. Pass `{ concurrency: n }` for bounded concurrency or
`{ concurrency: "unbounded" }` to start every mapped task immediately. See
[DOCUMENTATION.md](../../DOCUMENTATION.md#async-concurrency-mapping) for async concurrency details
and the runtime features Resultar intentionally keeps out of core.

For concurrent async races, use lazy signal-aware tasks. `race` and `raceAll` return the first
success. `raceFirst` returns the first completed result, success or failure. `timeout` is a
`raceFirst` convenience.

```ts
const user = ResultAsync.timeout(
  (signal) => fetchUser(id, { signal }),
  {
    timeoutMs: 2_000,
    onTimeout: () => new FetchUserTimeoutError({ id }),
  },
)
```

For transient async failures, use lazy retry tasks. The task receives a zero-based attempt number and
a `ResultAsyncAbortSignal`-compatible signal; `times` is the number of retries after the first
attempt.

```ts
const user = ResultAsync.retry(
  (attempt, signal) => fetchUser(id, { attempt, signal }),
  {
    times: 2,
    delayMs: ({ nextAttempt }) => nextAttempt * 100,
    jittered: 0.2,
    while: (error) => error._tag === 'RateLimitError',
  },
)

const withFallback = ResultAsync.retryOrElse(
  (attempt, signal) => fetchUser(id, { attempt, signal }),
  {
    times: 2,
    orElse: () => readCachedUser(id),
  },
)
```

Use `jittered` when many callers may retry at the same time. The value is a delay spread factor:
`jittered: 0.2` applies a random delay from `80%` to `120%` of the computed `delayMs`.

For resourceful async work, use `ResultAsync.withResource` when acquisition and cleanup must stay
paired. Cleanup is best-effort and always runs after successful acquisition, including when the use
step returns `Err` or rejects.

```ts
const lines = ResultAsync.withResource({
  acquire: (signal) => openFile(path, { signal }),
  use: (file, signal) => readLines(file, { signal }),
  release: (file) => file.close(),
})
```

For pull-based streams, keep the runtime native: expose an `AsyncIterable<Result<T, E>>` and close
resources in `finally`. See
[DOCUMENTATION.md](../../DOCUMENTATION.md#resourceful-async-iterables) for the full recipe.

Use `catchTag` / `catchTags` when recovery depends on a specific tagged error. Use
`matchTagsPartial` when only a boundary needs fallback mapping. Use `unwrapOr` only at final edges
where defaulting is intentional.

## Catching Errors

Resultar has different catch APIs for different error sources. Use the smallest API that matches
where the failure appears.

| Need | Use |
| --- | --- |
| Catch thrown sync code now | `tryResult(fn, toError?)` |
| Wrap a throwing sync function for later | `fromThrowable(fn, toError?)` |
| Catch an existing rejecting promise | `fromPromise(promise, toError)` |
| Catch a promise or async factory | `tryResultAsync(promiseOrFactory, toError?)` |
| Wrap an async function for later | `fromThrowableAsync(fn, toError?)` |
| Turn one error into another | `mapErr(fn)` |
| Recover with another result | `orElse(fn)` |
| Recover specific tagged errors | `catchTag(tag, fn)` or `catchTags(handlers)` |
| Recover nested tagged reasons | `catchReason(parentTag, reasonTag, fn)` or `catchReasons(parentTag, handlers)` |
| Convert a result at a boundary | `match`, `matchTags`, or `matchTagsPartial` |
| Handle an existing `Error` value | `matchError` or `matchErrorPartial` |
| Map thrown errors in linear code | `safeTry({ try, catch })` |
| Recover after retry exhaustion | `ResultAsync.retryOrElse(task, options)` |

Catch uncontrolled code at the edge:

```ts
const parsed: StrictResult<Config, ParseConfigError> = tryResult(
  () => JSON.parse(input) as Config,
  (cause) => new ParseConfigError({ cause }),
)

const response: StrictResultAsync<Response, FetchPayloadError> = tryResultAsync(
  () => fetch(url),
  (cause) => new FetchPayloadError({ cause, url }),
)
```

Thrown or rejected values are `unknown` at the boundary. The mapper decides the documented error
type: `ParseConfigError` for parsing and `FetchPayloadError` for fetching.

Recover inside the pipeline:

```ts
const user: StrictResultAsync<User, ReadUserError> = readUserFromCache(id)
  .orElse(() => readUserFromDatabase(id))
  .mapErr((cause) => new ReadUserError({ cause, id }))
```

The cache/database error union is normalized into one public `ReadUserError` while preserving the
original error as `cause`.

Handle tagged errors at the boundary:

```ts
const response: HttpResponse = createUser(input).matchTagsPartial(
  (user) => ({ body: user, statusCode: 201 }),
  {
    InvalidEmailError: (error) => ({ body: { code: error._tag }, statusCode: 400 }),
  },
  (error) => ({ body: { code: error._tag }, statusCode: 500 }),
)
```

For the full decision map, see
[Catching And Recovering Errors](../../DOCUMENTATION.md#catching-and-recovering-errors).

## Wrapping Throwing Code

Use `tryResult` and `tryResultAsync` at the edge of uncontrolled code:
JSON parsing, platform APIs, third-party libraries, I/O, and network calls.

```ts
import { tryResult } from 'resultar'

class ParseConfigError extends createTaggedError({
  name: 'ParseConfigError',
  message: 'Could not parse config',
}) {}

const parseConfig = (input: string): StrictResult<Config, ParseConfigError> =>
  tryResult(
    () => JSON.parse(input) as Config,
    (cause) => new ParseConfigError({ cause }),
  )
```

Use `fromPromise` when you already have a promise and need to map rejection into an expected error:

```ts
const user = fromPromise(loadUserFromRemote(id), (cause) => new FetchUserError({ cause, id }))
```

After that edge conversion, keep your own domain functions returning `Result` values instead of
throwing expected failures.

## Validation Errors

Keep validation failures as normal tagged errors. Map external validators into a small issue shape
at the adapter boundary.

```ts
type ValidationIssue = {
  readonly message: string
  readonly path: string
}

class ValidationError extends createTaggedError({
  name: 'ValidationError',
  message: 'Invalid input',
}) {
  public readonly issues: readonly ValidationIssue[]

  public constructor(props: {
    readonly cause?: unknown
    readonly issues: readonly ValidationIssue[]
  }) {
    super({ cause: props.cause })
    this.issues = props.issues
  }
}

const issueFromPath = (path: readonly (number | string)[], message: string): ValidationIssue => ({
  message,
  path: path.join('.'),
})
```

For Zod, Standard Schema, or any other validator, decode at the edge and map the library-specific
issue format into `ValidationIssue[]`. Resultar does not depend on any validator package.

## Unexpected Errors

Expected application failures belong in `Err`. Bugs, impossible states, and unrecoverable conditions
should remain normal JavaScript throws or rejected promises.

Use this boundary rule:

- Convert uncontrolled throws and rejections into expected errors with `tryResult`, `tryResultAsync`,
  `fromThrowable`, `fromThrowableAsync`, or `fromPromise`.
- Keep your own recoverable domain failures as `Err`.
- Use `unwrapOrThrow()` only at final edges where turning an `Err` into a thrown error is deliberate.

```ts
const user = await fetchUser('usr_123').unwrapOrThrow()
```

Inside `safeTry`, the object form can map thrown bugs from the generator body into an explicit error:

```ts
const config = safeTry({
  *try() {
    const raw = yield* readConfigFile()
    return ok(JSON.parse(raw) as Config)
  },
  catch: (cause) => new ParseConfigError({ cause }),
})
```

## Linear Result Code

Use `safeTry` when a pipeline reads better as linear code. `yield*` unwraps the `Ok` value and
short-circuits on the first `Err`.

```ts
import { safeTry } from 'resultar'

const createUser = (
  email: string,
): StrictResult<User, InvalidEmailError | UserAlreadyExistsError> =>
  safeTry(function* () {
    const validEmail = yield* validateEmail(email)
    const availableEmail = yield* ensureUserDoesNotExist(validEmail)

    return insertUser(availableEmail)
  })
```

The same `safeTry` helper supports async generators:

```ts
const createUserAsync = (
  email: string,
): StrictResultAsync<User, InvalidEmailError | UserAlreadyExistsError | DatabaseError> =>
  safeTry(async function* () {
    const validEmail = yield* validateEmail(email)
    const availableEmail = yield* ensureUserDoesNotExist(validEmail)

    return insertUserAsync(availableEmail)
  })
```

The object form can map unexpected thrown errors while leaving yielded `Err` values unchanged:

```ts
const config = safeTry({
  *try() {
    const raw = yield* readConfigFile()

    return ok(JSON.parse(raw) as Config)
  },
  catch: (cause) => new ParseConfigError({ cause }),
})
```

## No-Discard Validation

Resultar values should not be ignored. Use `resultar-check` to run TypeScript 7 and Resultar
diagnostics through one command.

```sh
pnpm add -D resultar-check typescript-7@npm:typescript@rc
```

Add a check script:

```json
{
  "scripts": {
    "check": "resultar-check -p tsconfig.json --noEmit"
  }
}
```

These fail in the default `must-use` mode:

```ts
saveUser(input)
const result = saveUser(input)
```

These are intentional:

```ts
return saveUser(input)
void saveUser(input)
saveUser(input).match(handleSaved, handleError)
```

The default mode is neverthrow-style `must-use`: it also reports assigned `Result` values that are
only passed around and never consumed with `match`, `unwrapOr`, `_unsafeUnwrap`, `isOk`, `isErr`,
returned, or explicitly discarded. Use `--mode direct` for the lower-noise expression-only check.

Configure Resultar rules in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "resultar-check", "noDiscard": "error" }]
  }
}
```

Oxlint is intentionally not part of the Resultar rules path; use it only for general linting if your
project wants it.

## API Decision Guide

| Need | Use |
| --- | --- |
| Create a sync success | `ok(value)` |
| Create a sync failure | `err(error)` or `ErrorClass.err(props)` |
| Create an async success | `okAsync(value)` |
| Create an async failure | `errAsync(error)` |
| Create an `Ok(undefined)` | `unit()` or `unitAsync()` |
| Convert throwing sync code | `tryResult` or `fromThrowable` |
| Convert rejecting async code | `tryResultAsync`, `fromPromise`, or `fromThrowableAsync` |
| Treat an `Err` as unrecoverable at an edge | `unwrapOrThrow()` |
| Transform success | `map` or `asyncMap` |
| Replace success with a known value | `as(value)` |
| Transform error | `mapErr` |
| Continue with fallible work | `andThen` or `asyncAndThen` |
| Recover from failure | `orElse`, `catchTag`, or `catchTags` |
| Recover from a nested tagged reason | `catchReason` or `catchReasons` |
| Move a parent error reason into the error channel | `unwrapReason` |
| Replace failure with another failure | `mapErr` or `orElse(() => err(newError))` |
| Replace failure with success | `orElse(() => ok(defaultValue))` |
| Handle a boundary | `match`, `matchTags`, or `matchTagsPartial` |
| Write linear result code | `safeTry` |
| Combine two independent results | `Result.zip` or `ResultAsync.zip` |
| Combine many independent results | `Result.combine` or `ResultAsync.combine` |
| Collect all validation failures | `validateAll` or `combineWithAllErrors` |
| Try fallback candidates | `firstSuccessOf` |
| Bound lazy async traversal | `ResultAsync.forEach` or mapped `ResultAsync.validateAll` with `{ concurrency }` |
| Race concurrent tasks | `ResultAsync.race`, `raceAll`, `raceFirst`, or `raceWith` |
| Apply a cooperative timeout | `ResultAsync.timeout` |
| Retry transient async work | `ResultAsync.retry` or `ResultAsync.retryOrElse` |
| Pair async acquisition with cleanup | `ResultAsync.withResource` |
| Process collections sequentially | `loop`, `iterate`, or `forEach` |
| Observe without changing outcome | `tap`, `tapError`, or `log` |
| Throw intentionally at a final edge | `unwrapOrThrow()` |
| Default intentionally at a final edge | `unwrapOr(defaultValue)` |

## What Stays Out Of Core

Resultar keeps the scope narrow: explicit error values, typed expected failures, and composable
recovery.

- No generator-based runtime DSL.
- No schedule engine in core.
- No config, cache, request resolver, resource, fiber, or service runtime.
- No raw `Error | T` conversion API.

## Version 3 Notes

`3.0.0` is a semver-major release:

- `no-discard` tooling moved out of the runtime package and into dedicated packages.
- TypeScript peer support is now `>=6.0.0`.
- Deprecated APIs are not part of the current API:

- `Result#finally`
- `ResultAsync#finally`
- `ResultAsync#safeUnwrap`
- `safeTryAsync`

Use `log`, `toDisposable`, `toAsyncDisposable`, and `safeTry(async function* () { ... })` instead.
`Result#safeUnwrap()` remains available for compatibility, but new code should prefer
`yield* result`.

`tryCatch` and `tryCatchAsync` remain exported as backward-compatible aliases. Prefer `tryResult`
and `tryResultAsync` in new code and docs.

## Documentation

This README is the runtime package entry point. For a full guide with larger examples and the
complete API map, see the repository documentation.

More focused material:

- [Full guide](https://github.com/inaiat/resultar/blob/main/DOCUMENTATION.md)
- [Type-safe error handling article, English](https://github.com/inaiat/resultar/blob/main/articles/en/type-safe.md)
- [Artigo sobre tratamento de erros type-safe, Portuguese](https://github.com/inaiat/resultar/blob/main/articles/pt/type-safe.md)
- [resultar-check package guide](https://github.com/inaiat/resultar/blob/main/packages/resultar-check/README.md)

## Repository

This repository is a pnpm workspace:

- `packages/resultar`: Resultar runtime package.
- `packages/resultar-check`: TypeScript 7 plus Resultar validation.
- `packages/resultar-lint`: deprecated compatibility wrapper.
- `packages/resultar-tsgo`: deprecated compatibility wrapper for older installs.
- `benchmarks`: benchmark package.
- `examples/resultar`: runnable core Resultar cookbook.
- `examples/lint`: TypeScript 7 `resultar-check` smoke example.

Common commands:

```sh
pnpm install
pnpm run fmt:check
pnpm run lint
pnpm test
pnpm run test:cov
pnpm run build
pnpm run check:full
pnpm run test:examples
pnpm run bench
```

## License

MIT
