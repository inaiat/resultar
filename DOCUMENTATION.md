# Resultar Full Guide

This is the long-form Resultar guide. Use [README.md](README.md) as the project entry point and this
file when you need the complete API map, larger examples, and repository workflow notes.

Resultar is a small TypeScript library for explicit error handling.

It gives you two primitives:

```ts
Result<T, E>
ResultAsync<T, E>
```

Use them when a function can fail and that failure should be visible in the type signature instead
of hidden behind `throw`, rejected promises, nullable returns, or ad hoc `T | Error` unions.

Resultar is intentionally not an application runtime. It focuses on one job: make expected failures
typed, composable, and hard to ignore.

## Install

Resultar is ESM-only and targets Node.js 24+.

```sh
pnpm add resultar
```

```sh
npm install resultar
```

```ts
import { createTaggedError, err, ok } from 'resultar'
import type { StrictResult } from 'resultar'
```

CommonJS `require('resultar')` is not exported.

## Why Resultar?

In TypeScript, this signature says nothing about expected failure:

```ts
const parsePort = (value: string): number => {
  const port = Number(value)

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid port ${value}`)
  }

  return port
}
```

Callers have to read the implementation or hope the function name tells the truth. Resultar moves
that failure into the type:

```ts
class InvalidPortError extends createTaggedError({
  name: 'InvalidPortError',
  message: 'Invalid port $value',
}) {}

const parsePort = (value: string): StrictResult<number, InvalidPortError> => {
  const port = Number(value)

  return Number.isInteger(port) && port > 0 ? ok(port) : InvalidPortError.err({ value })
}
```

Now the function signature tells callers three useful facts:

```ts
StrictResult<number, InvalidPortError>
//           ^ success value
//                   ^ expected failure
```

The result must be handled before the value can be used.

## How To Read This Guide

If you are new to Resultar, read these sections in order:

1. [The model](#the-model)
2. [Quick start](#quick-start)
3. [Tagged errors](#tagged-errors)
4. [Composing steps](#composing-steps)
5. [Handling results at boundaries](#handling-results-at-boundaries)

If you already know Result-style error handling, jump to:

- [Use case index](#use-case-index)
- [API decision guide](#api-decision-guide)
- [No-discard validation](#no-discard-validation)
- [Async concurrency mapping](#async-concurrency-mapping)
- [Coming from other styles](#coming-from-other-styles)
- [What Stays Out Of Core](#what-stays-out-of-core)
- [API map](#api-map)

## Use Case Index

| If you need to... | Start here | Main APIs |
| --- | --- | --- |
| Create success or failure values | [Creating Results](#creating-results) | `ok`, `err`, `unit`, `okAsync`, `errAsync`, `unitAsync` |
| Model expected domain failures | [Tagged Errors](#tagged-errors) | `createTaggedError`, `.err`, `StrictResult` |
| Model lightweight tagged unions | [Tagged Enums](#tagged-enums) | `TaggedEnum`, `taggedEnum` |
| Keep secrets out of error output | [Redacted Error Props](#redacted-error-props) | `redact`, `isRedacted`, `revealRedacted` |
| Keep failure channels Error-only | [Strict Results](#strict-results) | `StrictResult`, `StrictResultAsync` |
| Wrap code that throws | [Wrapping Throwing Or Rejecting Code](#wrapping-throwing-or-rejecting-code) | `tryResult`, `fromThrowable` |
| Wrap promises or async factories | [Wrapping Throwing Or Rejecting Code](#wrapping-throwing-or-rejecting-code) | `tryResultAsync`, `fromPromise`, `fromSafePromise`, `fromThrowableAsync` |
| Transform successful values | [Composing Steps](#composing-steps) | `map`, `asyncMap`, `filterOrElse` |
| Chain fallible steps | [Composing Steps](#composing-steps) | `andThen`, `asyncAndThen` |
| Recover from failures | [Recovering Tagged Errors Locally](#recovering-tagged-errors-locally) | `orElse`, `catchTag`, `catchTags` |
| Recover nested tagged reasons | [Reasoned Tagged Errors](#reasoned-tagged-errors) | `catchReason`, `catchReasons`, `unwrapReason` |
| Choose fallback behavior | [Fallbacks](#fallbacks) | `orElse`, `mapErr`, `unwrapOr`, `firstSuccessOf` |
| Choose the right error-catching API | [Catching And Recovering Errors](#catching-and-recovering-errors) | `tryResult`, `fromPromise`, `mapErr`, `orElse`, `catchTag`, `matchError` |
| Convert results into responses | [Handling Results At Boundaries](#handling-results-at-boundaries) | `match`, `matchTags`, `matchTagsPartial` |
| Match an error value directly | [Handling Results At Boundaries](#handling-results-at-boundaries) | `matchError`, `matchErrorPartial` |
| Write linear result code | [Safe Try](#safe-try) | `safeTry`, `yield* result`, object-form `safeTry` |
| Branch without throwing | [Conditional Helpers](#conditional-helpers) | `Result.if`, `Result.when`, `Result.unless`, `whenResult`, `unlessResult` |
| Combine many independent results | [Combining And Iterating](#combining-and-iterating) | `combine`, `combineWithAllErrors`, `firstSuccessOf` |
| Control async traversal concurrency | [Async Concurrency Mapping](#async-concurrency-mapping) | `ResultAsyncConcurrency`, `{ concurrency }` |
| Race concurrent async work | [Concurrent Racing And Timeouts](#concurrent-racing-and-timeouts) | `ResultAsync.race`, `raceAll`, `raceFirst`, `raceWith`, `timeout` |
| Retry transient async work | [Retrying Async Work](#retrying-async-work) | `ResultAsync.retry`, `ResultAsync.retryOrElse` |
| Pair async acquisition with cleanup | [Resourceful Async Iterables](#resourceful-async-iterables) | `ResultAsync.withResource` |
| Loop or process collections | [Combining And Iterating](#combining-and-iterating) | `loop`, `iterate`, `forEach` |
| Detect cancellation errors | [Concurrent Racing And Timeouts](#concurrent-racing-and-timeouts) | `AbortError`, `isAbortError` |
| Normalize validation issues | [Validation Error Recipes](#validation-error-recipes) | tagged validation errors with `issues` |
| Add logging or cleanup | [Observation And Cleanup](#observation-and-cleanup) | `tap`, `tapError`, `log`, `toDisposable`, `toAsyncDisposable` |
| Understand callback exceptions | [Callback Failure Semantics](#callback-failure-semantics) | transform callbacks vs observation callbacks |
| Unwrap at tests or final edges | [Unwrapping Results](#unwrapping-results) | `unwrapOr`, `unwrapOrThrow`, `_unsafeUnwrap`, `_unsafeUnwrapErr` |
| Prevent ignored results | [No-Discard Validation](#no-discard-validation) | `resultar-check` |
| Check package exports and aliases | [Public Entry Point](#public-entry-point) | `try`, `tryAsync`, `default`, runtime exports |

## The Model

`Result<T, E>` is a synchronous fallible value:

```ts
type Result<T, E> = Ok<T> | Err<E>
```

`ResultAsync<T, E>` is the promise-based version. Conceptually, it wraps this shape:

```ts
Promise<Result<T, E>>
```

The public type is a Resultar wrapper with methods like `map`, `andThen`, and `match`, but the
mental model is the same:

- `Ok<T>` means the operation succeeded.
- `Err<E>` means the operation failed in an expected way.
- `T` is the success type.
- `E` is the expected error type.

For local code, `Result<T, E>` can use strings, enums, or small domain objects as `E`.

For application, service, HTTP, job, queue, or integration boundaries, prefer:

```ts
StrictResult<T, E extends Error>
StrictResultAsync<T, E extends Error>
```

Those aliases are still Resultar results, but they document that failures are real `Error`
instances with `message`, `cause`, stack traces, and structured metadata.

## Creating Results

Use constructor helpers when you already know the outcome:

```ts
import { err, errAsync, ok, okAsync, unit, unitAsync } from 'resultar'

const syncValue = ok<number, Error>(1)
const syncError = err<number, Error>(new Error('failed'))
const syncUnit = unit<Error>()

const asyncValue = okAsync<number, Error>(1)
const asyncError = errAsync<number, Error>(new Error('failed'))
const asyncUnit = unitAsync<Error>()
```

`unit()` and `unitAsync()` are success values with `undefined`. They are useful when the success
state only means "completed".

The namespace classes expose the same constructors:

```ts
import { Result, ResultAsync } from 'resultar'

const sync = Result.ok<number, Error>(1)
const async = ResultAsync.okAsync<number, Error>(1)
```

`ResultAsync` is awaitable:

```ts
const result = await okAsync<number, Error>(1)

if (result.isOk()) {
  result.value
}
```

It can also be used with promise combinators, but prefer Resultar combinators when failure semantics
matter:

```ts
const results = await Promise.all([okAsync(1), okAsync(2)])
const combined = Result.combine(results)
```

## Strict Results

`StrictResult<T, E extends Error>` and `StrictResultAsync<T, E extends Error>` are type-only aliases
for Error-only failure channels.

```ts
import { createTaggedError, err, errAsync, ok, okAsync } from 'resultar'
import type { StrictResult, StrictResultAsync } from 'resultar'

class DomainError extends createTaggedError({
  name: 'DomainError',
  message: 'Domain failure $code',
}) {}

class InfrastructureError extends Error {}

const syncSuccess: StrictResult<number, DomainError> = ok(123)
const syncFailure: StrictResult<number, DomainError> = DomainError.err({ code: 'invalid' })
const infrastructureFailure: StrictResult<number, InfrastructureError> = err(
  new InfrastructureError('database unavailable'),
)

const asyncSuccess: StrictResultAsync<number, DomainError> = okAsync(123)
const asyncFailure: StrictResultAsync<number, DomainError> = errAsync(
  new DomainError({ code: 'invalid' }),
)
```

Use plain `Result<T, E>` for narrow local flows that intentionally use strings, enums, or lightweight
objects as errors. Use `StrictResult` when a failure crosses an application, service, HTTP, job, or
integration boundary.

```ts
// Local-only style.
type ParseError = 'InvalidJson'

// Boundary style.
type SaveUserResult = StrictResult<User, DomainError | InfrastructureError>
```

## Quick Start

```ts
import { createTaggedError, ok } from 'resultar'
import type { StrictResult } from 'resultar'

class InvalidEmailError extends createTaggedError({
  name: 'InvalidEmailError',
  message: 'Invalid email $email',
}) {}

const validateEmail = (email: string): StrictResult<string, InvalidEmailError> =>
  email.includes('@') ? ok(email) : InvalidEmailError.err({ email })

const message = validateEmail('person@example.com').match(
  (email) => `Valid email: ${email}`,
  (error) => error.message,
)
```

`match` is usually the simplest way to leave Resultar code at an edge. Inside business logic, prefer
composition with `map`, `andThen`, `asyncAndThen`, `orElse`, `catchTag`, and `catchTags`.

## Result

Use `Result<T, E>` for synchronous work.

```ts
import { createTaggedError, ok } from 'resultar'
import type { StrictResult } from 'resultar'

type User = {
  readonly email: string
}

class InvalidEmailError extends createTaggedError({
  name: 'InvalidEmailError',
  message: 'Invalid email $email',
}) {}

const validateEmail = (email: string): StrictResult<string, InvalidEmailError> =>
  email.includes('@') ? ok(email) : InvalidEmailError.err({ email })

const createUser = (email: string): StrictResult<User, InvalidEmailError> =>
  validateEmail(email).map((validEmail) => ({ email: validEmail }))
```

When you need explicit narrowing, use `isOk()` and `isErr()`:

```ts
const result = createUser('person@example.com')

if (result.isOk()) {
  result.value.email
}

if (result.isErr()) {
  result.error.message
}
```

## ResultAsync

Use `ResultAsync<T, E>` for promise-based work.

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

Use `fromPromise(promise, toError)` when the promise already exists.

Use `tryResultAsync(() => promiseFactory(), toError)` when creating the promise can throw
synchronously.

## Wrapping Throwing Or Rejecting Code

Use Resultar wrappers at the edge of uncontrolled code: JSON parsing, platform APIs, third-party
libraries, I/O, and network calls. Convert the thrown or rejected value once, then keep your own
domain code returning `Result` values.

### `tryResult`

`tryResult` runs a synchronous function immediately and returns `Result<T, E>`.

```ts
import { tryResult } from 'resultar'

class ParseJsonError extends Error {
  public constructor(public readonly cause: unknown) {
    super('Could not parse JSON')
  }
}

const parsed = tryResult(
  () => JSON.parse('{"value":1}') as { value: number },
  (cause) => new ParseJsonError(cause),
)
```

The object form is useful when named `try` / `catch` keys are clearer:

```ts
const parsed = tryResult({
  try: () => JSON.parse('{"value":2}') as { value: number },
  catch: (cause) => new ParseJsonError(cause),
})
```

If `catch` is omitted, the original thrown value becomes the error channel.

`try`, the default export, and the backward-compatible `tryCatch` alias are the same helper.
Prefer `tryResult` in new code:

```ts
import tryDefault, { try as tryAlias, tryCatch, tryResult } from 'resultar'

tryDefault === tryResult
tryAlias === tryResult
tryCatch === tryResult
```

### `tryResultAsync`

`tryResultAsync` accepts a promise, an async factory, or the object form:

```ts
import { tryResultAsync } from 'resultar'

const fromExistingPromise = tryResultAsync(fetch('/users'))

const fromFactory = tryResultAsync(
  () => fetch('/users'),
  (cause) => new Error('Request failed', { cause }),
)

const fromObject = tryResultAsync({
  try: () => fetch('/users'),
  catch: (cause) => new Error('Request failed', { cause }),
})
```

Use the factory form when creating the promise can throw synchronously. If `catch` is omitted, the
original rejection or thrown value becomes the error channel.

`tryAsync` and the backward-compatible `tryCatchAsync` alias are the same helper. Prefer
`tryResultAsync` in new code:

```ts
import { tryAsync, tryCatchAsync, tryResultAsync } from 'resultar'

tryAsync === tryResultAsync
tryCatchAsync === tryResultAsync
```

### `fromThrowable` and `fromThrowableAsync`

Use `fromThrowable` when you want to create a reusable safe wrapper around a throwing function:

```ts
import { fromThrowable } from 'resultar'

const parseJson = fromThrowable(
  (input: string) => JSON.parse(input) as unknown,
  (cause) => new ParseJsonError(cause),
)

const result = parseJson('{')
```

Use `fromThrowableAsync` for reusable async wrappers. It catches synchronous throws from the wrapper
body and promise rejections.

```ts
import { fromThrowableAsync } from 'resultar'

const readUserResponse = fromThrowableAsync(
  (id: string) => fetch(`/users/${id}`),
  (cause) => new Error('Could not request user', { cause }),
)
```

### `fromPromise` and `fromSafePromise`

Use `fromPromise(promise, toError)` when the promise already exists and may reject:

```ts
import { err, fromPromise, ok, tryResultAsync } from 'resultar'

const loaded = fromPromise(fetch('/users'), (cause) => new Error('Request failed', { cause }))
  .andThen((response) =>
    response.ok
      ? ok(response)
      : err(new Error(`Request failed with status ${response.status}`)),
  )
  .andThen((response) =>
    tryResultAsync<unknown, Error>(
      () => response.json(),
      (cause) => new Error('Invalid JSON', { cause }),
    ),
  )
```

Use `fromSafePromise(promise)` only when rejection would be unexpected or already impossible by
construction:

```ts
import { fromSafePromise } from 'resultar'

const loaded = fromSafePromise(Promise.resolve({ id: 'usr_123' }))
```

## Tagged Errors

`createTaggedError` creates real `Error` subclasses with a stable `_tag` and typed metadata.

```ts
class UserNotFoundError extends createTaggedError({
  name: 'UserNotFoundError',
  message: 'User $id was not found in $source',
}) {}

const error = new UserNotFoundError({
  id: 'usr_123',
  source: 'database',
})

error instanceof Error
error instanceof UserNotFoundError
error._tag
error.message
error.id
error.source
```

Template variables in the message become required constructor props:

```ts
new UserNotFoundError({ id: 'usr_123', source: 'database' })

// @ts-expect-error source is required
new UserNotFoundError({ id: 'usr_123' })
```

Use `.err(props)` when returning an error result:

```ts
const findUser = (id: string) =>
  id === 'usr_123' ? ok({ id }) : UserNotFoundError.err({ id, source: 'database' })
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
  name: 'DynamicMessageError',
}) {}

const error = new DynamicMessageError({ message: 'Dynamic failure' })
```

Tagged errors can extend a custom `Error` base:

```ts
class AppError extends Error {
  public statusCode = 500
}

class ForbiddenError extends createTaggedError({
  extends: AppError,
  name: 'ForbiddenError',
  message: 'Missing permission $permission',
}) {
  public override statusCode = 403
}

const error = new ForbiddenError({ permission: 'admin:write' })

error instanceof AppError
error.statusCode
```

Use `cause`, `.findCause`, or the standalone `findCause` helper for nested error lookup:

```ts
import { findCause } from 'resultar'

class DatabaseError extends createTaggedError({
  name: 'DatabaseError',
  message: 'Database operation $operation failed',
}) {}

const root = new Error('connection refused')
const error = new DatabaseError({ cause: root, operation: 'insert-user' })

error.cause
error.findCause(Error)
findCause(error, Error)
```

Cause lookup is cycle-safe. It stops if the chain repeats and returns `undefined` when no matching
cause exists.

Use static `.is(value)` for nominal guards. It checks the actual generated class, not just `_tag`:

```ts
const error = new UserNotFoundError({ id: 'usr_123', source: 'database' })
const spoofed = Object.assign(new Error('spoofed'), { _tag: 'UserNotFoundError' })

UserNotFoundError.is(error) // true
UserNotFoundError.is(spoofed) // false
```

`toJSON()` returns predictable error metadata for logs, responses, and snapshots. It serializes
nested `cause` chains recursively and stops safely if a cause cycle repeats:

```ts
error.toJSON()
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
import { taggedEnum } from 'resultar'
import type { TaggedEnum } from 'resultar'

type PaymentState = TaggedEnum<{
  Declined: { readonly code: string }
  Pending: { readonly retryAfterMs: number }
  Settled: { readonly receiptId: string }
}>

const PaymentState = taggedEnum<{
  Declined: { readonly code: string }
  Pending: { readonly retryAfterMs: number }
  Settled: { readonly receiptId: string }
}>()

const state = PaymentState.Pending({ retryAfterMs: 1_000 })

state
// { _tag: 'Pending', retryAfterMs: 1000 }
```

The runtime helper creates frozen plain objects. It does not create classes and it does not depend on
an external runtime.

Use `$is(tag, value)` when a value is unknown:

```ts
const input: unknown = state

if (PaymentState.$is('Pending', input)) {
  input.retryAfterMs
}
```

Use `$match(value, handlers)` for exhaustive local branching:

```ts
const label = PaymentState.$match(state, {
  Declined: (declined) => `declined:${declined.code}`,
  Pending: (pending) => `retry:${pending.retryAfterMs}`,
  Settled: (settled) => `receipt:${settled.receiptId}`,
})
```

Prefer `createTaggedError` for failures that cross service boundaries, need stack traces, need
`cause`, or should be handled by `matchError`. Prefer `taggedEnum` for nested reasons, state
machines, and small domain variants.

### Redacted Error Props

Use `redact(value, label?)` when a tagged error prop must not leak through messages or JSON.

```ts
import { createTaggedError, redact, revealRedacted } from 'resultar'

class TokenRejectedError extends createTaggedError({
  name: 'TokenRejectedError',
  message: 'Token $token was rejected',
}) {}

const token = redact('secret-token-value', 'api-token')
const error = new TokenRejectedError({ token })

error.message
// 'Token <redacted:api-token> was rejected'

error.toJSON()
// { ..., token: '<redacted:api-token>' }

revealRedacted(error.token)
// 'secret-token-value'
```

Use `revealRedacted` only in the exact code path that is allowed to see the original value. Normal
message interpolation, JSON serialization, and string conversion keep the redacted representation.

## Composing Steps

Use `map` when the success value changes and the transform cannot fail:

```ts
const normalizeEmail = (email: string): StrictResult<string, InvalidEmailError> =>
  validateEmail(email).map((value) => value.trim().toLowerCase())
```

Use `as` when success matters but the previous value does not:

```ts
const markCreated = (email: string): StrictResult<{ readonly status: 'created' }, InvalidEmailError> =>
  createUser(email).as({ status: 'created' })
```

Use `asyncMap` when a sync `Result` needs an asynchronous infallible value transform:

```ts
const loadProfileLabel = (email: string) =>
  validateEmail(email).asyncMap(async (validEmail) => {
    const profile = await loadProfile(validEmail)
    return profile.label
  })
```

Use `mapErr` when only the error value changes:

```ts
const result = validateEmail(email).mapErr(
  (cause) => new Error('Could not validate email', { cause }),
)
```

Use `filterOrElse` when a successful value must satisfy another predicate:

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

Use `andThen` when the next step can fail:

```ts
class UserAlreadyExistsError extends createTaggedError({
  name: 'UserAlreadyExistsError',
  message: 'User $email already exists',
}) {}

class DatabaseError extends createTaggedError({
  name: 'DatabaseError',
  message: 'Database operation $operation failed',
}) {}

type CreateUserError = InvalidEmailError | UserAlreadyExistsError | DatabaseError

const createUser = (email: string): StrictResult<User, CreateUserError> =>
  validateEmail(email).andThen(ensureUserDoesNotExist).andThen(insertUser)
```

Use `asyncAndThen` when a synchronous result continues into async work:

```ts
const createUser = (email: string): StrictResultAsync<User, CreateUserError> =>
  validateEmail(email).asyncAndThen(ensureUserDoesNotExistAsync).andThen(insertUserAsync)
```

Once already inside `ResultAsync`, `andThen` accepts callbacks that return either `Result` or
`ResultAsync`:

```ts
const created = validateEmail(email)
  .asyncAndThen(ensureUserDoesNotExistAsync)
  .andThen(insertUser)
  .andThen(sendWelcomeEmailAsync)
```

Use `orElse` when an error should recover into another result:

```ts
const user = findUser(id).orElse((error) =>
  error._tag === 'UserNotFoundError' ? createGuestUser(id) : err(error),
)
```

Use `pipe` for reusable combinators:

```ts
const audit =
  <T, E>(result: Result<T, E>): Result<T, E> =>
    result.tap((value) => logger.info({ value }, 'result ok'))

const userEmail = createUser(email).pipe(audit, (result) => result.map((user) => user.email))
```

## Handling Results At Boundaries

Boundary code is where Resultar values become HTTP responses, queue acknowledgements, CLI exit
codes, logs, metrics, or UI state.

Use `match` for simple success/error branches:

```ts
const response = createUser('person@example.com').match(
  (user) => ({ body: user, statusCode: 201 }),
  (error) => ({ body: { code: 'CreateUserFailed', message: error.message }, statusCode: 400 }),
)
```

The labeled object form is equivalent and often reads better at boundaries:

```ts
const response = createUser('person@example.com').match({
  ok: (user) => ({ body: user, statusCode: 201 }),
  error: (error) => ({
    body: { code: 'CreateUserFailed', message: error.message },
    statusCode: 400,
  }),
})
```

`ResultAsync#match` supports both forms and resolves to the selected handler output:

```ts
const response = await fetchUser('usr_123').match({
  ok: (user) => ({ body: user, statusCode: 200 }),
  error: (error) => ({ body: { message: error.message }, statusCode: 502 }),
})
```

Use `matchTags` when every tagged error should be handled explicitly:

```ts
const response = createUser('taken@example.com').matchTags(
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
)
```

If a handler is missing, TypeScript reports it.

Use `matchTagsPartial` when only some errors need custom handling and the rest should share a
fallback:

```ts
const response = createUser('taken@example.com').matchTagsPartial(
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

Use standalone `matchError` when you have an error value instead of a `Result`:

```ts
import { matchError } from 'resultar'

declare const error: InvalidEmailError | UserAlreadyExistsError | DatabaseError

const statusCode = matchError(error, {
  DatabaseError: () => 500,
  InvalidEmailError: () => 400,
  UserAlreadyExistsError: () => 409,
})
```

When plain or untagged `Error` is part of the union, include an `Error` handler.

```ts
declare const error: InvalidEmailError | DatabaseError | Error

const message = matchError(error, {
  DatabaseError: (err) => err.message,
  Error: (err) => err.message,
  InvalidEmailError: (err) => err.message,
})
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
)
```

## Recovering Tagged Errors Locally

Use `catchTag` when one tagged error can be recovered before the boundary:

```ts
const result = createUser('bad-email').catchTag('InvalidEmailError', (error) =>
  ok({ email: error.email, id: 'draft_user' }),
)
```

Use `catchTags` when a small group of tagged errors share local recovery:

```ts
const result = createUser('taken@example.com').catchTags({
  InvalidEmailError: (error) => ok({ email: error.email, id: 'draft_user' }),
  UserAlreadyExistsError: (error) => ok({ email: error.email, id: 'existing_user' }),
})
```

`catchTags` is intentionally partial: unhandled tags stay in the error channel.

Use `catchTags` for pipeline recovery. Use `matchTagsPartial` for boundary mapping with a fallback.

## Reasoned Tagged Errors

Some failures have one stable outer error and a smaller nested reason union. This is common for
provider errors, policy decisions, AI/service refusals, validation families, and quota/rate-limit
branches.

Use a parent tagged error when logs and boundaries should keep one stable error tag:

```ts
import { createTaggedError, err, ok, taggedEnum } from 'resultar'
import type { StrictResult, TaggedEnum } from 'resultar'

const AiReason = taggedEnum<{
  QuotaExceededError: { readonly limit: number }
  RateLimitError: { readonly retryAfterMs: number }
  SafetyBlockedError: { readonly policy: string }
}>()

type AiReason = TaggedEnum<{
  QuotaExceededError: { readonly limit: number }
  RateLimitError: { readonly retryAfterMs: number }
  SafetyBlockedError: { readonly policy: string }
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

const completePrompt = (): StrictResult<string, AiError> =>
  err(new AiError({ reason: AiReason.RateLimitError({ retryAfterMs: 1_000 }) }))
```

Use `catchReason(parentTag, reasonTag, handler)` for one local recovery path:

```ts
const completed = completePrompt().catchReason('AiError', 'RateLimitError', (reason) =>
  ok(`retry after ${reason.retryAfterMs}ms`),
)
```

Use `catchReasons(parentTag, handlers)` when several reasons can recover locally:

```ts
const completed = completePrompt().catchReasons('AiError', {
  QuotaExceededError: (reason) => ok(`quota:${reason.limit}`),
  RateLimitError: (reason) => ok(`retry:${reason.retryAfterMs}`),
})
```

Unhandled reasons stay in the error channel as the original parent error with a narrowed `reason`.
That means local recovery stays precise, while boundary code can still handle `AiError`.

Use `unwrapReason(parentTag)` when a downstream step only cares about the nested reason union:

```ts
const reasonResult = completePrompt().unwrapReason('AiError')

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
)
```

`ResultAsync` provides the same three methods. Async reason handlers may return either `Result` or
`ResultAsync`.

## Fallbacks

Fallbacks are useful when an `Err` has a meaningful recovery path. Resultar keeps fallback behavior
explicit through existing `Result` and `ResultAsync` operations.

| Fallback idea | Resultar API | Use when |
| --- | --- | --- |
| `orElse` | `result.orElse(() => fallbackResult)` | another operation can recover the failure |
| `orElseFail` | `mapErr(...)` or `orElse(() => err(newError))` | the failure should be normalized or replaced |
| `orElseSucceed` | `orElse(() => ok(defaultValue))` | a fallback success should stay in the pipeline |
| default at the edge | `unwrapOr(defaultValue)` | defaulting is intentional and no more result composition is needed |
| ordered candidates | `Result.firstSuccessOf` / `ResultAsync.firstSuccessOf` | each candidate should run only if earlier candidates fail |

Use `orElse` for pipeline recovery:

```ts
const user = readUserFromCache(id).orElse(() => readUserFromRemote(id))
```

If recovery depends on the specific error, inspect the error or prefer tagged recovery helpers:

```ts
const user = readUserFromCache(id).orElse((error) =>
  CacheMissError.is(error) ? readUserFromRemote(id) : err(error),
)
```

Use `mapErr` when a low-level error should become a stable domain error:

```ts
class ReadUserError extends createTaggedError({
  name: 'ReadUserError',
  message: 'Could not read user $id',
}) {}

const user = readUserFromRemote(id).mapErr((cause) => new ReadUserError({ cause, id }))
```

Use `orElse(() => err(newError))` when replacing the failure requires another `Result` branch:

```ts
const user = readUserFromRemote(id).orElse((cause) =>
  ReadUserError.err({
    cause,
    id,
  }),
)
```

Use `orElse(() => ok(defaultValue))` when fallback success is part of the pipeline:

```ts
const user = readUser(id).orElse(() =>
  ok({
    email: 'guest@example.com',
    id: 'guest',
  }),
)
```

Use `unwrapOr(defaultValue)` only at final edges where returning a plain value is the goal:

```ts
const port = parsePort(process.env.PORT ?? '').unwrapOr(3000)
const asyncPort = await loadPort().unwrapOr(3000)
```

Use `firstSuccessOf` when fallbacks should be lazy and ordered:

```ts
const user = ResultAsync.firstSuccessOf([
  () => readUserFromCache(id),
  () => readUserFromPrimary(id),
  () => readUserFromReplica(id),
])
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

| Error source or goal | API | What it catches or handles |
| --- | --- | --- |
| Synchronous code may throw now | `tryResult(fn, toError?)` | Runs `fn` immediately and catches thrown values into `Err`. |
| Synchronous code should be wrapped for later calls | `fromThrowable(fn, toError?)` | Returns a reusable function that catches thrown values. |
| Existing promise may reject | `fromPromise(promise, toError)` | Converts rejection into a typed `Err`. |
| Existing promise or async factory may reject | `tryResultAsync(promiseOrFactory, toError?)` | Catches rejections and synchronous throws from the factory form. |
| Async function should be wrapped for later calls | `fromThrowableAsync(fn, toError?)` | Returns a reusable function that catches synchronous throws and promise rejections. |
| Promise is already known not to reject | `fromSafePromise(promise)` | Does not catch rejections; use only when rejection is impossible or intentionally fatal. |
| Error should become another error | `mapErr(fn)` | Transforms the `Err` channel and leaves `Ok` untouched. |
| Error can recover into another result | `orElse(fn)` | Replaces an `Err` with another `Result` / `ResultAsync`. |
| One tagged error can recover locally | `catchTag(tag, fn)` | Handles only that `_tag` and narrows the remaining error union. |
| Several tagged errors can recover locally | `catchTags(handlers)` | Handles listed tags and leaves unlisted tags in the error channel. |
| One nested tagged reason can recover locally | `catchReason(parentTag, reasonTag, fn)` | Handles one nested reason inside a parent tagged error. |
| Several nested tagged reasons can recover locally | `catchReasons(parentTag, handlers)` | Handles listed nested reasons and leaves the rest. |
| Boundary needs to convert a whole result | `match`, `matchTags`, `matchTagsPartial` | Converts `Ok` / `Err` into responses, logs, exit codes, or UI state. |
| You already have an `Error` value | `matchError`, `matchErrorPartial` | Matches a tagged or plain error without wrapping it in `Result`. |
| Linear generator code may throw unexpectedly | `safeTry({ try, catch })` | Maps thrown values from the generator body; yielded `Err` values are preserved. |
| Retry policy exhausted | `ResultAsync.retryOrElse(task, options)` | Runs fallback only after retry stops with an `Err`. |
| Timeout should be expected, not thrown | `ResultAsync.timeout(task, options)` | Returns a typed timeout `Err` and aborts the task signal. |
| You need to detect abort-shaped errors | `isAbortError(value)` | Detects Resultar, DOM-style, and Node abort-shaped errors. |

The high-level rule is simple:

- Use `tryResult`, `tryResultAsync`, `fromThrowable`, `fromThrowableAsync`, and `fromPromise` at
  the edge of uncontrolled code.
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
)
```

Use object form when named `try` and `catch` keys make the boundary clearer:

```ts
const parsed: StrictResult<Config, ParseConfigError> = tryResult({
  try: () => JSON.parse(input) as Config,
  catch: (cause) => new ParseConfigError({ cause }),
})
```

For reusable adapters, wrap the throwing function once:

```ts
const parseConfig: (input: string) => StrictResult<Config, ParseConfigError> = fromThrowable(
  (input: string) => JSON.parse(input) as Config,
  (cause) => new ParseConfigError({ cause }),
)
```

### Catch Rejected Async Work

Async catch helpers follow the same rule: the mapper return type becomes the async `Err` type.

Use `fromPromise` when the promise already exists:

```ts
const response: StrictResultAsync<Response, FetchPayloadError> = fromPromise(
  fetch(url),
  (cause) => new FetchPayloadError({ cause, url }),
)
```

Use `tryResultAsync` factory form when creating the promise may throw synchronously:

```ts
const response: StrictResultAsync<Response, FetchPayloadError> = tryResultAsync(
  () => fetch(url),
  (cause) => new FetchPayloadError({ cause, url }),
)
```

Use `fromThrowableAsync` for reusable async adapters:

```ts
const fetchJson: (url: string) => StrictResultAsync<unknown, FetchPayloadError> =
  fromThrowableAsync(
    async (url: string) => {
      const response = await fetch(url)
      return response.json() as Promise<unknown>
    },
    (cause) => new FetchPayloadError({ cause, url: 'unknown' }),
  )
```

### Recover Inside A Pipeline

Use `mapErr` when the recovery is just error normalization:

```ts
const user: StrictResultAsync<User, ReadUserError> = readUserFromDatabase(id).mapErr(
  (cause: DatabaseError) => new ReadUserError({ cause, id }),
)
```

The original `DatabaseError` no longer appears in the public error channel. It is preserved as
`cause` inside `ReadUserError`.

Use `orElse` when recovery is another fallible operation:

```ts
const user: StrictResultAsync<User, CacheUnavailableError | DatabaseError> =
  readUserFromCache(id).orElse((error) =>
    CacheMissError.is(error) ? readUserFromDatabase(id) : err(error),
)
```

Here `CacheMissError` is handled and removed. `CacheUnavailableError` remains because it is returned
unchanged, and `DatabaseError` is added by the fallback branch.

Use tagged catch helpers when only specific domain failures are recoverable:

```ts
type CreateUserError = InvalidEmailError | UserAlreadyExistsError | DatabaseError

const user: StrictResultAsync<User, DatabaseError> = createUser(input).catchTags({
  InvalidEmailError: (error) => ok({ email: error.email, id: 'draft_user' }),
  UserAlreadyExistsError: (error) => readExistingUser(error.email),
})
```

`InvalidEmailError` and `UserAlreadyExistsError` are handled, so only unhandled `DatabaseError`
remains in the error channel. If a handler returns its own `Err`, that handler error is added to the
remaining union.

Use reason catch helpers when one parent error carries a nested reason union:

```ts
type AiErrorReason = RateLimitError | SafetyBlockedError | QuotaExceededError
type RemainingAiReason = SafetyBlockedError | QuotaExceededError
type RemainingAiError = AiError & { readonly reason: RemainingAiReason }

const answer: StrictResult<string, RemainingAiError> = askAi(prompt).catchReason(
  'AiError',
  'RateLimitError',
  (reason) => ok(`retry after ${reason.retryAfterMs}ms`),
)
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
)
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
)
```

The fallback receives the unhandled error union. Use this at boundaries where one default error
response is acceptable.

Use `matchError` when a framework already handed you an `Error` value:

```ts
const statusCode: number = matchError(error, {
  DatabaseError: () => 500,
  InvalidEmailError: () => 400,
  UserAlreadyExistsError: () => 409,
})
```

If plain `Error` can appear, include an `Error` handler or use `matchErrorPartial` with a fallback.

### Callback Failure Semantics

Transform callbacks are part of the pipeline. If they throw, reject, or return a rejected
`ResultAsync`, the resulting promise rejects:

```ts
const result = ok(1).map(() => {
  throw new Error('mapping failed')
})
```

Observation callbacks are best-effort. `tap`, `tapError`, and `log` ignore thrown or rejected
callback failures and preserve the original result. Use `andThen`, `orElse`, `tryResult`, or
`tryResultAsync` when callback failure should affect control flow.

## Concurrent Racing And Timeouts

`ResultAsync` has lazy, signal-aware racing helpers for concurrent async work. The task shape is:

```ts
type ResultAsyncRaceTask<T, E> = (signal: ResultAsyncAbortSignal) => ResultAsync<T, E>
```

Tasks are functions, not already-created `ResultAsync` values. This matters because cancellation is
cooperative: Resultar can abort the signal, but the task must pass that signal to the underlying
operation. The public signal type is structural, so platform `AbortSignal` values are compatible
without forcing every consumer to include DOM or Node ambient types.

### `race`

`ResultAsync.race(left, right)` starts both tasks immediately and returns the first `Ok`. If one task
returns `Err`, `race` keeps waiting for the other task. If both fail, it returns the last completed
`Err`.

```ts
const user = ResultAsync.race(
  (signal) => readUserFromPrimary(id, { signal }),
  (signal) => readUserFromReplica(id, { signal }),
)
```

When a success wins, still-pending losers are aborted. Tasks that already completed are not aborted
later.

### `raceAll`

`ResultAsync.raceAll(tasks)` is the collection form of `race`. It starts every task immediately,
returns the first `Ok`, and returns the last completed `Err` if every task fails.

```ts
const user = ResultAsync.raceAll([
  (signal) => readUserFromReplicaA(id, { signal }),
  (signal) => readUserFromReplicaB(id, { signal }),
  (signal) => readUserFromReplicaC(id, { signal }),
] as const)
```

Use a non-empty tuple when you want precise union inference for all values and errors.

Use `raceAll` when several equivalent providers can satisfy the same read and an early failure
should not hide a later success:

```ts
const user = ResultAsync.raceAll([
  (signal) => readUserFromEdgeCache(id, { signal }),
  (signal) => readUserFromPrimaryRegion(id, { signal }),
  (signal) => readUserFromReplicaRegion(id, { signal }),
] as const)
```

If one provider returns `Err` quickly, `raceAll` keeps waiting. If a later provider returns `Ok`,
that success wins and pending providers receive an abort signal. If every provider fails, the last
completed error is returned.

### `raceFirst`

`ResultAsync.raceFirst(left, right)` returns the first completed `Result`, whether it is `Ok` or
`Err`.

```ts
const firstDone = ResultAsync.raceFirst(
  (signal) => doWork(id, { signal }),
  (signal) => pollCancellation(id, { signal }),
)
```

Use `raceFirst` when an early failure should win. Use `race` when an early failure should not stop
waiting for a possible success.

### `timeout`

`ResultAsync.timeout(task, options)` is a `raceFirst` convenience. If the task settles first, its
original `Ok` or `Err` is returned. If the timer wins, `onTimeout()` creates the typed timeout error
and the task signal is aborted with that error.

```ts
class FetchUserTimeoutError extends createTaggedError({
  name: 'FetchUserTimeoutError',
  message: 'Fetch user $id timed out after $timeoutMs milliseconds',
}) {}

const user = ResultAsync.timeout(
  (signal) => fetchUser(id, { signal }),
  {
    timeoutMs: 2_000,
    onTimeout: () => new FetchUserTimeoutError({ id, timeoutMs: 2_000 }),
  },
)
```

Timeouts stay in the expected error channel, so response mapping can stay exhaustive:

```ts
const response = await user.matchTags(
  (loadedUser) => ({ body: loadedUser, statusCode: 200 }),
  {
    FetchUserError: (error) => ({ body: { code: error._tag }, statusCode: 502 }),
    FetchUserTimeoutError: (error) => ({
      body: { code: error._tag, message: error.message },
      statusCode: 504,
    }),
  },
)
```

`timeout` does not use a rejected timeout promise. Timeout is just another typed `Err`.

### `raceWith`

`ResultAsync.raceWith(left, right, handlers)` is the low-level primitive. The first completed side
calls its finisher with the completed `Result` and a handle for the loser.

```ts
const result = ResultAsync.raceWith(primary, fallback, {
  onLeftDone: (leftResult, fallbackHandle) => {
    if (leftResult.isOk()) {
      fallbackHandle.abort()
      return leftResult
    }

    return fallbackHandle.wait()
  },
  onRightDone: (rightResult, primaryHandle) => {
    primaryHandle.abort()
    return rightResult
  },
})
```

The loser handle exposes:

- `signal`
- `abort(reason?)`
- `wait()`

Use `raceWith` when neither `race` nor `raceFirst` expresses the desired policy.

### Abort Errors

`AbortError` is Resultar's own abort error class. `isAbortError(value)` detects Resultar
`AbortError`, DOM-style `{ name: 'AbortError' }`, and Node abort-shaped `{ code: 'ABORT_ERR' }`
values.

```ts
import { AbortError, isAbortError } from 'resultar'

const aborted = new AbortError('cancelled')

isAbortError(aborted) // true
isAbortError({ name: 'AbortError' }) // true
isAbortError({ code: 'ABORT_ERR' }) // true
```

Resultar racing uses cooperative abort. If a task ignores the signal, Resultar stops observing the
loser and returns the winner, but it cannot force the underlying work to stop.

## Retrying Async Work

`ResultAsync.retry(task, options)` re-runs a lazy async task when it returns `Err`. The task receives
the zero-based attempt number and a `ResultAsyncAbortSignal`-compatible signal.

```ts
const user = ResultAsync.retry(
  (attempt, signal) => fetchUser(id, { attempt, signal }),
  {
    times: 2,
    delayMs: ({ nextAttempt }) => nextAttempt * 100,
    while: (error) => error._tag === 'RateLimitError',
  },
)
```

`times` is the number of retries after the first attempt. `times: 0` runs once. If the task returns
`Ok`, retrying stops immediately. If it keeps returning `Err`, the last error is returned after the
retry budget is exhausted.

The retry context passed to `delayMs`, `while`, `onRetry`, and `orElse` has this shape:

```ts
interface ResultAsyncRetryContext {
  readonly attempt: number
  readonly nextAttempt: number
  readonly retriesRemaining: number
}
```

Use `while` when only some errors are retryable. Use `delayMs` for fixed or context-derived delays.
Use `onRetry` for diagnostics; callback failures are ignored and do not alter the result.

```ts
const saved = ResultAsync.retry(
  (attempt, signal) => saveInvoice(invoice, { attempt, signal }),
  {
    times: 3,
    delayMs: 50,
    while: (error) => error._tag === 'DatabaseBusyError',
    onRetry: (error, context) => {
      logger.warn({ attempt: context.attempt, error }, 'retrying invoice save')
    },
  },
)
```

`ResultAsync.retryOrElse(task, options)` runs the same retry policy, then calls `orElse` only when
the policy stops with an error. The fallback can return either `Result` or `ResultAsync`.

```ts
const user = ResultAsync.retryOrElse(
  (attempt, signal) => fetchUser(id, { attempt, signal }),
  {
    times: 2,
    orElse: () => readCachedUser(id),
  },
)
```

Use `retryOrElse` when the fallback is part of the domain policy, not an exception handler:

```ts
const profile = ResultAsync.retryOrElse(
  (attempt, signal) => loadProfileFromApi(userId, { attempt, signal }),
  {
    times: 3,
    delayMs: ({ nextAttempt }) => nextAttempt * 250,
    while: (error) => error._tag === 'RateLimitError' || error._tag === 'GatewayTimeoutError',
    orElse: (error) =>
      error._tag === 'RateLimitError'
        ? loadProfileSnapshot(userId)
        : err(new ProfileUnavailableError({ cause: error, userId })),
  },
)
```

Platform abort signals are accepted structurally:

```ts
const controller = new AbortController()

const imported = ResultAsync.retry(
  (attempt, signal) => importPage(page, { attempt, signal }),
  {
    signal: controller.signal,
    times: 5,
    delayMs: 100,
  },
)

controller.abort(new Error('request closed'))
```

Invalid `times` values and invalid retry delays reject with an `IllegalArgumentException`-named
`Error`. An external `ResultAsyncAbortSignal`-compatible signal aborts before a new attempt or
during retry delay and returns a typed `AbortError`.

## Async Concurrency Mapping

Resultar provides concurrency controls for plain `ResultAsync` values without adding a runtime
scheduler.

| Async concurrency idea | Resultar API | Notes |
| --- | --- | --- |
| Sequential execution | `ResultAsync.forEach(items, fn)` / `ResultAsync.validateAll(items, fn)` | Default `concurrency` is `1`. |
| Numbered concurrency | `{ concurrency: n }` | `n` must be a positive integer. Invalid runtime values reject with an `IllegalArgumentException`-named `Error`. |
| Unbounded concurrency | `{ concurrency: "unbounded" }` | Starts every mapped `ResultAsync` task immediately. |
| Already-created async values | `ResultAsync.combine(results)` | The values are already running or already created; `combine` only aggregates them. |
| Racing | `race`, `raceAll`, `raceFirst`, `raceWith`, `timeout` | Uses lazy signal-aware tasks. |
| Retrying | `retry`, `retryOrElse` | Re-runs lazy tasks by policy. |
| Interruption | race/retry task signal | Cooperative only. Tasks must pass the signal to underlying work. |

```ts
const saved = await ResultAsync.forEach(
  users,
  (user) => saveUser(user),
  { concurrency: 4, discard: true },
)
```

```ts
const validation = await ResultAsync.validateAll(
  fields,
  (field) => validateField(field),
  { concurrency: 'unbounded' },
)
```

Use bounded `forEach` for side-effecting batch work where the first expected failure should stop
new scheduling:

```ts
const result = await ResultAsync.forEach(
  invoices,
  (invoice) =>
    chargeInvoice(invoice).andThen((receipt) =>
      markInvoicePaid(invoice.id, receipt),
    ),
  { concurrency: 6, discard: true },
)
```

Use mapped `validateAll` when every independent item should run and every validation failure should
be returned:

```ts
const validation = await ResultAsync.validateAll(
  rows,
  (row, index) => validateImportRow(row).mapErr((error) => ({ index, error })),
  { concurrency: 12 },
)
```

`ResultAsync.forEach` stops scheduling new work after the first `Err`, waits for already-started
tasks to settle, and returns the first error by input order among started tasks.

`ResultAsync.validateAll` keeps scheduling until every item has run and returns all validation
errors in input order.

Resultar does not include inherited concurrency, fibers, standalone interruption hooks, detached
background interruption, or runtime cause trees.

## Resourceful Async Iterables

Use `ResultAsync.withResource` when a resource must be acquired before async work and released
afterward. The helper keeps acquisition lazy, passes a `ResultAsyncAbortSignal`-compatible signal to
both acquire and use steps, and always runs `release` after a successful acquisition.

```ts
const fileResult = ResultAsync.withResource({
  acquire: (signal) => openFile(path, { signal }),
  use: (file, signal) => readFileContents(file, { signal }),
  release: (file) => file.close(),
})
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
})
```

For transactions, put commit in the `use` step and reserve `release` for best-effort rollback or
close behavior:

```ts
const created = ResultAsync.withResource({
  acquire: (signal) => db.beginTransaction({ signal }),
  use: (tx, signal) =>
    ResultAsync.forEach(
      users,
      (user) => insertUser(tx, user, { signal }),
      { concurrency: 4, discard: true },
    ).andThen(() => tx.commit({ signal })),
  release: (tx, context) => {
    if (context.result?.isErr()) {
      return tx.rollback()
    }

    return tx.close()
  },
})
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
  const opened = await openFile(path)

  if (opened.isErr()) {
    yield err(opened.error)
    return
  }

  const file = opened.value

  try {
    for await (const line of file.lines()) {
      yield ok(line)
    }
  } catch (cause) {
    yield err(new FileReadError({ cause }))
  } finally {
    await file.close().catch(() => undefined)
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
transducers, sinks, channels, scoped runtimes, or a scheduler to Resultar core.

## Safe Try

`safeTry` gives you linear control flow when a chain of `andThen` calls becomes harder to read.

```ts
import { err, ok, safeTry } from 'resultar'
import type { StrictResult } from 'resultar'

const createUser = (email: string): StrictResult<User, CreateUserError> =>
  safeTry(function* () {
    const validEmail = yield* validateEmail(email)
    const user = yield* insertUser(validEmail)

    return ok(user)
  })
```

Async generators can yield both `Result` and `ResultAsync`:

```ts
const saveUser = (email: string): StrictResultAsync<User, CreateUserError> =>
  safeTry(async function* () {
    const validEmail = yield* validateEmail(email)
    const user = yield* insertUserAsync(validEmail)

    return ok(user)
  })
```

The object form lets you map unexpected throws from inside the generator:

```ts
class ParseConfigError extends Error {
  public constructor(public readonly cause: unknown) {
    super('parse config failed')
  }
}

const loadConfig = (raw: string) =>
  safeTry({
    *try() {
      const input = yield* ok<string, string>(raw)

      return ok(JSON.parse(input) as Config)
    },
    catch: (cause) => new ParseConfigError(cause),
  })
```

The object-form `catch` handles thrown exceptions from the generator body. It does not rewrite
yielded `Err` values:

```ts
const result = safeTry({
  *try() {
    const raw = yield* err<string, string>('missing config')

    return ok(JSON.parse(raw) as Config)
  },
  catch: (cause) => new ParseConfigError(cause),
})

// Err('missing config'), not ParseConfigError
result
```

Prefer `yield* result`. `result.safeUnwrap()` remains for compatibility, but new code usually does
not need it.

`ResultAsync#safeUnwrap()` and `safeTryAsync()` are not part of the current API. Use `yield*
resultAsync` inside `safeTry(async function* () { ... })`.

## Conditional Helpers

Use conditional helpers when branching itself is part of a result pipeline.

`Result.if(condition, { onTrue, onFalse })` runs one branch and preserves the skipped branch:

```ts
const result = Result.if(input.enabled, {
  onTrue: () => validateEnabledInput(input),
  onFalse: () => ok({ status: 'skipped' } as const),
})
```

The condition can be a boolean, a thunk, or a `Result<boolean, E>`. When the condition result is
`Err`, neither branch runs and the condition error is returned.

```ts
const result = Result.if(readFeatureFlag(), {
  onTrue: () => runEnabledFlow(),
  onFalse: () => runDisabledFlow(),
})
```

Use `when` and `unless` for optional work. A skipped branch returns `Ok(undefined)`:

```ts
const maybeSaved = Result.when(input.shouldSave, () => saveInput(input))
const maybeSkipped = Result.unless(input.disabled, () => saveInput(input))
```

Use `whenResult` and `unlessResult` when the condition is itself a result:

```ts
const maybeSaved = Result.whenResult(validateCanSave(input), () => saveInput(input))
```

`ResultAsync` provides the same helpers and accepts sync `Result` or async `ResultAsync` branches:

```ts
const result = ResultAsync.if(loadRemoteFlag(), {
  onTrue: () => saveInputAsync(input),
  onFalse: () => ok({ status: 'skipped' } as const),
})
```

## Unwrapping Results

Prefer `match`, `matchTags`, `andThen`, or `safeTry` in application code. Use unwrapping only at
tests, scripts, and final edges where throwing or defaulting is intentional.

`unwrapOr(defaultValue)` returns the success value or the provided default:

```ts
const port = parsePort(process.env.PORT ?? '').unwrapOr(3000)
const asyncPort = await loadPort().unwrapOr(3000)
```

`unwrapOrThrow()` returns the success value or throws the error:

```ts
const user = await fetchUser('usr_123').unwrapOrThrow()
```

`_unsafeUnwrap()` and `_unsafeUnwrapErr()` are test helpers:

```ts
expect(ok(42)._unsafeUnwrap()).toBe(42)
expect(err('failed')._unsafeUnwrapErr()).toBe('failed')
```

## Validation Error Recipes

Keep validation errors as normal tagged errors. Convert validator-specific issue formats at the edge
of your adapter, then keep the rest of the application using one stable domain shape.

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
```

Use a tiny path normalizer at the adapter boundary:

```ts
const issueFromPath = (path: readonly (number | string)[], message: string): ValidationIssue => ({
  message,
  path: path.join('.'),
})
```

For Zod:

```ts
const fromZodIssue = (issue: {
  readonly message: string
  readonly path: readonly (number | string)[]
}): ValidationIssue => issueFromPath(issue.path, issue.message)
```

For Standard Schema-style issues:

```ts
const fromStandardIssue = (issue: {
  readonly message: string
  readonly path?: readonly (number | string)[]
}): ValidationIssue => issueFromPath(issue.path ?? [], issue.message)
```

For schema libraries with formatted issue output, map that output into `ValidationIssue[]` in your
adapter. Resultar should not import validator packages directly.

```ts
const decodeInput = (input: unknown): StrictResult<DecodedInput, ValidationError> => {
  const decoded = decodeWithValidator(input)

  return decoded.isOk()
    ? ok(decoded.value)
    : err(new ValidationError({ cause: decoded.error, issues: decoded.error.issues }))
}
```

Use `combineWithAllErrors` or `validateAll` when several independent fields should all report
failures:

```ts
const validation = Result.combineWithAllErrors({
  email: validateEmail(input.email),
  name: validateName(input.name),
  password: validatePassword(input.password),
})
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
)

const loaded = tryResultAsync(() => fetch(url), (cause) => new FetchPayloadError({ cause, url }))
  .andThen((response) =>
    response.ok ? ok(response) : FetchPayloadStatusError.err({ status: response.status, url }),
  )
  .andThen((response) =>
    tryResultAsync<Payload, ParsePayloadError>(
      () => response.json(),
      (cause) => new ParsePayloadError({ cause, url }),
    ),
  )
```

For unrecoverable failures, throw normally:

```ts
const divide = (a: number, b: number): number => {
  if (b === 0) {
    throw new Error('Cannot divide by zero')
  }

  return a / b
}
```

To deliberately convert an `Err` back into a thrown value at a final edge, use `unwrapOrThrow()`:

```ts
const user = await fetchUser('usr_123').unwrapOrThrow()
```

For a custom conversion, match and throw:

```ts
const user = fetchUser('usr_123').match(
  (value) => value,
  (error) => {
    throw new Error('Could not fetch user', { cause: error })
  },
)
```

The object form of `safeTry` can map unexpected throws from inside a linear generator:

```ts
const config = safeTry({
  *try() {
    const raw = yield* readConfigFile()
    return ok(JSON.parse(raw) as Config)
  },
  catch: (cause) => new ParseConfigError({ cause }),
})
```

In JavaScript applications, handle uncaught throws and rejected promises at the runtime edge: HTTP
server error handlers, worker/job supervisors, CLI top-level `try/catch`, test assertions, or
`Promise.catch`.

## Observation And Cleanup

Use side-effect helpers for best-effort observation:

- `tap(fn)` runs only for `Ok`.
- `tapError(fn)` runs only for `Err`.
- `log(fn)` runs for both states as `(value, error)`.

They preserve the original result:

```ts
const result = fetchUser('usr_123')
  .tap((user) => metrics.increment('user.loaded', { id: user.id }))
  .tapError((error) => metrics.increment('user.failed', { tag: error.name }))
  .log((user, error) => logger.info({ error, user }, 'fetch user result'))
```

Callback errors are intentionally ignored. If callback failure should affect control flow, use
`andThen`, `orElse`, `tryResult`, or `tryResultAsync`.

For Node.js 24 explicit resource management, use disposable wrappers:

```ts
using result = findUser('usr_123').toDisposable((_user, _error) => {
  span.end()
})

await using asyncResult = fetchUser('usr_123').toAsyncDisposable(async (_user, _error) => {
  await span.end()
})
```

`Result#finally` and `ResultAsync#finally` are not part of the current API. Use `log` for immediate
side effects, `toDisposable` for `using`, and `toAsyncDisposable` for `await using`.
Use `ResultAsync.withResource` when acquisition and cleanup must be paired inside one lazy async
operation.

## Callback Failure Semantics

Resultar makes a sharp distinction between transformation callbacks and observation callbacks.

Transformation callbacks are part of control flow:

- `map`
- `mapErr`
- `andThen`
- `asyncAndThen`
- `orElse`
- `match`
- `catchTag`
- `catchTags`

For `ResultAsync`, if one of those callbacks throws, rejects, or returns a rejected `ResultAsync`,
the outer async operation rejects. Resultar does not silently turn callback bugs into `Err` values.

```ts
await okAsync(1).map(() => {
  throw new Error('callback failed')
})
```

Observation callbacks are best-effort:

- `tap`
- `tapError`
- `log`
- `toDisposable`
- `toAsyncDisposable`

If those callbacks throw or reject, Resultar preserves the original result:

```ts
const result = await okAsync<number, Error>(1).tap(() => {
  throw new Error('metrics failed')
})

result.isOk()
```

## No-Discard Validation

Resultar values should not be ignored. Use `resultar-check` to run TypeScript >=7 and Resultar
diagnostics through one command.

```sh
pnpm add -D resultar-check "typescript@>=7"
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

For AST-only Oxlint, ESLint, and Deno Lint feedback, use the `resultar-check/eslint` and
`resultar-check/deno` package exports. Keep the `resultar-check` CLI for full TypeScript-backed
Resultar diagnostics. When comparing CLI output with AST-only adapters, run the CLI with a dedicated
project file that enables the same AST-only rule subset; `examples/lint` contains that parity smoke.

For editor diagnostics, use the same `compilerOptions.plugins` entry and configure your editor to use
the workspace TypeScript version. The `resultar-check` package guide includes copy-paste setup for VS
Code, Zed `vtsls`, and Zed `typescript-language-server`.

## Testing Resultar Code

Use runtime assertions for behavior and type assertions for inference.

```ts
import { equal, ok as assertOk } from 'node:assert'
import { describe, expectTypeOf, it } from 'vite-plus/test'
import { createTaggedError, ok } from 'resultar'
import type { StrictResult } from 'resultar'

class InvalidEmailError extends createTaggedError({
  name: 'InvalidEmailError',
  message: 'Invalid email $email',
}) {}

const validateEmail = (email: string): StrictResult<string, InvalidEmailError> =>
  email.includes('@') ? ok(email) : InvalidEmailError.err({ email })

describe('validateEmail', () => {
  it('returns tagged errors', () => {
    const result = validateEmail('bad')

    assertOk(result.isErr())
    expectTypeOf(result.error).toEqualTypeOf<InvalidEmailError>()
    equal(result.error._tag, 'InvalidEmailError')
  })
})
```

Use `// @ts-expect-error` for intentional negative type tests:

```ts
import { err } from 'resultar'

if (false) {
  // @ts-expect-error StrictResult error types must extend Error.
  const invalid: StrictResult<number, string> = err('invalid')

  JSON.stringify(invalid)
}
```

Use `_unsafeUnwrap()` and `_unsafeUnwrapErr()` in tests when direct values make the assertion
clearer. Avoid them in application code.

## API Decision Guide

Use this as the first stop when choosing an operation:

| Need | Use |
| --- | --- |
| Create a sync success | `ok(value)` |
| Create a sync failure | `err(error)` or `ErrorClass.err(props)` |
| Create an async success | `okAsync(value)` |
| Create an async failure | `errAsync(error)` |
| Create an `Ok(undefined)` | `unit()` or `unitAsync()` |
| Convert a throwing sync function now | `tryResult(fn, toError?)` |
| Convert a throwing sync function with named handlers | `tryResult({ try, catch })` |
| Convert a throwing function for later use | `fromThrowable(fn, toError?)` |
| Convert an existing promise now | `tryResultAsync(promise, toError?)` |
| Convert an existing promise into `ResultAsync` | `fromPromise(promise, toError)` |
| Convert a promise expected not to reject | `fromSafePromise(promise)` |
| Convert a promise factory that may throw | `tryResultAsync(() => promise, toError?)` |
| Convert a reusable async function | `fromThrowableAsync(fn, toError?)` |
| Treat an `Err` as unrecoverable at an edge | `unwrapOrThrow()` |
| Transform an `Ok` value | `map(fn)` |
| Replace an `Ok` value | `as(value)` |
| Transform an `Err` value | `mapErr(fn)` |
| Validate an `Ok` value | `filterOrElse(predicate, onFalse)` |
| Continue with sync fallible work | `andThen(fn)` |
| Continue from sync to async fallible work | `asyncAndThen(fn)` |
| Recover from an error | `orElse(fn)` |
| Replace an error with another error | `mapErr(fn)` or `orElse(() => err(newError))` |
| Replace an error with success | `orElse(() => ok(defaultValue))` |
| Recover one tagged error locally | `catchTag(tag, fn)` |
| Recover several tagged errors locally | `catchTags(handlers)` |
| Recover one nested tagged reason | `catchReason(parentTag, reasonTag, fn)` |
| Recover several nested tagged reasons | `catchReasons(parentTag, handlers)` |
| Move nested reasons into the error channel | `unwrapReason(parentTag)` |
| Handle a simple boundary | `match(okFn, errFn)` |
| Handle a simple boundary with named handlers | `match({ ok, error })` |
| Handle every tagged boundary error | `matchTags(okFn, handlers)` |
| Handle selected boundary errors | `matchTagsPartial(okFn, handlers, fallback)` |
| Write linear result code | `safeTry(generator)` |
| Map unexpected throws inside linear code | `safeTry({ try, catch })` |
| Run one of two result branches | `Result.if` or `ResultAsync.if` |
| Run optional work | `when`, `unless`, `whenResult`, `unlessResult` |
| Combine two independent results | `zip` |
| Combine many independent results | `combine`, `combineWithAllErrors` |
| Combine named independent results | `combine({ key: result })` |
| Collect all validation failures | `validateAll` or `combineWithAllErrors` |
| Try fallback candidates | `firstSuccessOf` |
| Bound lazy async traversal | `ResultAsync.forEach(items, fn, { concurrency })` |
| Bound lazy async validation | `ResultAsync.validateAll(items, fn, { concurrency })` |
| Race two async tasks for first success | `ResultAsync.race(left, right)` |
| Race many async tasks for first success | `ResultAsync.raceAll(tasks)` |
| Race two async tasks for first completion | `ResultAsync.raceFirst(left, right)` |
| Customize async race policy | `ResultAsync.raceWith(left, right, handlers)` |
| Add a cooperative timeout | `ResultAsync.timeout(task, options)` |
| Retry transient async work | `ResultAsync.retry(task, options)` |
| Recover after retry exhaustion | `ResultAsync.retryOrElse(task, options)` |
| Pair async acquisition with cleanup | `ResultAsync.withResource(options)` |
| Detect abort-shaped failures | `isAbortError(value)` |
| Create lightweight tagged unions | `taggedEnum<Members>()` |
| Redact secrets from error output | `redact(value, label?)` |
| Loop without throwing | `loop`, `iterate`, `forEach` |
| Throw intentionally at an edge | `unwrapOrThrow()` |
| Default intentionally at an edge | `unwrapOr(defaultValue)` |
| Add observation without changing the result | `tap`, `tapError`, `log` |

## Combining And Iterating

Use collection helpers when the shape of the workflow matters more than the individual steps.

### `zip`

`Result.zip(left, right)` combines exactly two independent results. It returns an `Ok` tuple when
both succeed, or the first error when either fails.

```ts
const paired = Result.zip(validateEmail(email), validateName(name))
```

`ResultAsync.zip(left, right)` does the same for async results:

```ts
const paired = await ResultAsync.zip(loadUser(id), loadPermissions(id))
```

### `combine`

`Result.combine(results)` turns many results into one result. It returns `Ok` with a tuple/list of
success values when every result succeeds, or the first error when any result fails.

```ts
const combined = Result.combine([validateEmail(email), validateName(name)])

const payload = combined.match(
  ([email, name]) => ({ email, name }),
  (error) => ({ error }),
)
```

It preserves array values as values; it does not flatten nested arrays:

```ts
const combined = Result.combine([ok(['a', 'b']), ok([1, 2])])

// Ok<[string[], number[]]>
combined
```

`ResultAsync.combine(results)` does the same for async results:

```ts
const combined = await ResultAsync.combine([loadUser(id), loadPermissions(id)])
```

`combine` also accepts records. Use this when the result names matter more than tuple positions:

```ts
const context = Result.combine({
  org: loadOrg(orgId),
  user: loadUser(userId),
})

const response = context.match(
  ({ org, user }) => ({ orgId: org.id, userId: user.id }),
  (error) => ({ error: error.message }),
)
```

The async version preserves the same record shape:

```ts
const context = await ResultAsync.combine({
  org: loadOrgAsync(orgId),
  user: loadUserAsync(userId),
})
```

For non-array iterables, `combine` returns a readonly array of success values:

```ts
const values = Result.combine(new Set([parseNumber('1'), parseNumber('2')]))
// Result<readonly number[], ParseNumberError>
```

### `combineWithAllErrors`

`Result.combineWithAllErrors(results)` collects all errors.

```ts
const validation = Result.combineWithAllErrors([
  validateEmail(input.email),
  validateName(input.name),
  validatePassword(input.password),
])

const response = validation.match(
  ([email, name, password]) => ({ email, name, password }),
  (errors) => ({ errors: errors.map((error) => error.message) }),
)
```

Use `combine` when the first failure is enough. Use `combineWithAllErrors` when the caller needs a
complete validation report.

Record inputs are useful for form and command validation because the output keeps field names:

```ts
const validation = Result.combineWithAllErrors({
  email: validateEmail(input.email),
  name: validateName(input.name),
  password: validatePassword(input.password),
})

const response = validation.match(
  (valid) => createUser(valid),
  (errors) => ({ errors: errors.map((error) => error.message) }),
)
```

### `validateAll`

`Result.validateAll(results)` is the validation-focused name for `combineWithAllErrors`.

```ts
const validation = Result.validateAll([
  validateEmail(input.email),
  validateName(input.name),
  validatePassword(input.password),
])
```

Use `Result.validateAll(items, fn)` when the inputs are a collection:

```ts
const validation = Result.validateAll(input.items, (item) => validateLineItem(item))
```

`ResultAsync.validateAll(results)` provides the same shape for already-created async validations.
Use `ResultAsync.validateAll(items, fn, options?)` when validation should be lazy and optionally
bounded:

```ts
const validation = ResultAsync.validateAll(
  input.items,
  (item) => validateLineItemAsync(item),
  { concurrency: 4 },
)
```

The async mapped form defaults to sequential execution. With `{ concurrency: n }`, it starts at most
`n` validations at a time. With `{ concurrency: "unbounded" }`, it starts every mapped validation
immediately. Success values and collected errors preserve input order.

### `firstSuccessOf`

`Result.firstSuccessOf(candidates)` tries candidates sequentially until one succeeds. It does not
call later candidates after the first success.

```ts
const config = Result.firstSuccessOf([
  () => readConfigFromEnv(),
  () => readConfigFromFile(),
  () => readDefaultConfig(),
])
```

If every candidate fails, it returns the last error. If the candidate collection is empty, the sync
version throws and the async version rejects with an `IllegalArgumentException`.

```ts
const user = await ResultAsync.firstSuccessOf([
  () => readUserFromCache(id),
  () => readUserFromDatabase(id),
  () => readUserFromReplica(id),
])
```

### `loop`

`Result.loop(initial, options)` is a result-aware `while` loop. It collects body values by default,
stops on the first `Err`, and skips the body when the initial condition is false.

```ts
const doubled = Result.loop(1, {
  while: (state) => state <= 3,
  step: (state) => state + 1,
  body: (state) => ok<number, string>(state * 2),
})

// Ok([2, 4, 6])
doubled
```

Use `discard: true` for side-effect loops where the collected values are not needed:

```ts
const visited = Result.loop(1, {
  while: (state) => state <= 3,
  step: (state) => state + 1,
  body: (state) => writeAuditEvent(state),
  discard: true,
})

// Ok(undefined)
visited
```

### `iterate`

`Result.iterate(initial, options)` repeatedly transforms state and returns the final state:

```ts
const finalCursor = Result.iterate(0, {
  while: (cursor) => cursor < 10,
  body: (cursor) => ok<number, string>(cursor + 1),
})
```

Use it when each step returns the next state. Use `loop` when each step returns a value that should
be collected separately from the loop state.

### `forEach`

`Result.forEach(iterable, fn, options?)` processes sync items sequentially, passes `(value, index)`,
and collects success values by default.

```ts
const parsed = Result.forEach(['1', '2', '3'], (value, index) =>
  parseNumber(value).map((number) => ({ index, number })),
)
```

It stops on the first error and does not call later items. `ResultAsync.forEach` defaults to the
same sequential behavior, but also accepts `{ concurrency: n }` or `{ concurrency: "unbounded" }` for
lazy async traversal.

Use `{ discard: true }` when the callback is only needed for effects:

```ts
const saved = ResultAsync.forEach(users, (user, index) => saveUser(user, index), {
  concurrency: 4,
  discard: true,
})
```

For loops and collections, use:

- `Result.loop(initial, options)`
- `Result.iterate(initial, options)`
- `Result.forEach(iterable, fn, options?)`
- `ResultAsync.loop(initial, options)`
- `ResultAsync.iterate(initial, options)`
- `ResultAsync.forEach(iterable, fn, options?)`

`ResultAsync.loop` and `ResultAsync.iterate` run sequentially. `ResultAsync.forEach` runs
sequentially by default, can be bounded with `{ concurrency: n }`, and short-circuits scheduling on
the first `Err` while waiting for already-started work to settle.

## Coming From Other Styles

### From try/catch

Use `tryResult` and `tryResultAsync` only at the edge of uncontrolled code: JSON parsing, platform
APIs, third-party libraries, I/O, and network calls.

```ts
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

Resultar keeps the scope narrow: explicit error values, typed expected failures, and composable
recovery. It avoids APIs that would turn the package into an application framework.

- No generator-based runtime DSL.
- No schedule engine in core.
- No config, cache, request resolver, resource, fiber, or service runtime.
- No inherited concurrency, standalone interruption hooks, detached background interruption, or
  runtime cause trees.
- No raw `Error | T` conversion API.

Use Resultar for typed expected failures, local recovery, result aggregation, and cooperative async
racing. Keep richer runtime concerns in application code or in dedicated libraries.

## Public Entry Point

Import runtime helpers and type-only names from `resultar`:

```ts
import {
  AbortError,
  Result,
  ResultAsync,
  createTaggedError,
  err,
  errAsync,
  findCause,
  fromPromise,
  fromSafePromise,
  fromThrowable,
  fromThrowableAsync,
  isAbortError,
  isError,
  isRedacted,
  matchError,
  matchErrorPartial,
  ok,
  okAsync,
  redact,
  revealRedacted,
  safeTry,
  taggedEnum,
  tryResult,
  tryResultAsync,
  unit,
  unitAsync,
} from 'resultar'

import type {
  DisposableResult,
  DisposableResultAsync,
  ErrResult,
  OkResult,
  Redacted,
  ResultOperations,
  ResultAsyncAbortSignal,
  ResultAsyncConcurrency,
  ResultAsyncRaceHandle,
  ResultAsyncRaceTask,
  ResultAsyncTimeoutOptions,
  StrictResult,
  StrictResultAsync,
  TaggedEnum,
  TaggedEnumFactory,
  TaggedErrorClass,
  TaggedErrorInstance,
  TaggedErrorOptions,
} from 'resultar'
```

The intended runtime aliases are:

- `tryResult`, `try`, and the default export are the same sync helper.
- `tryResultAsync` and `tryAsync` are the same async helper.
- `tryCatch` and `tryCatchAsync` remain exported as backward-compatible aliases. Prefer
  `tryResult` and `tryResultAsync` in new code.

Not part of the current API:

- `Result#finally`
- `ResultAsync#finally`
- `ResultAsync#safeUnwrap`
- `safeTryAsync`

Use `log`, `toDisposable`, `toAsyncDisposable`, and `safeTry(async function* () { ... })` instead.

## API Map

### Result helpers

- `ok(value)`
- `err(error)`
- `unit()`
- `tryResult(fn, toError?)`
- `tryResult({ try, catch? })`
- `try(fn, toError?)`
- `tryCatch(fn, toError?)` as a backward-compatible alias
- `fromThrowable(fn, toError?)`
- `safeTry(generator)`
- `safeTry({ try, catch? })`
- `redact(value, label?)`
- `isRedacted(value)`
- `revealRedacted(value)`
- `StrictResult<T, E extends Error>`

### Result methods

- `isOk()`
- `isErr()`
- `map(fn)`
- `as(value)`
- `mapErr(fn)`
- `filterOrElse(predicate, onFalse)`
- `andThen(fn)`
- `asyncAndThen(fn)`
- `asyncMap(fn)`
- `orElse(fn)`
- `catchTag(tag, fn)`
- `catchTags(handlers)`
- `catchReason(parentTag, reasonTag, fn)`
- `catchReasons(parentTag, handlers)`
- `unwrapReason(parentTag)`
- `match(okFn, errFn)`
- `matchTags(okFn, handlers)`
- `matchTagsPartial(okFn, handlers, fallback)`
- `pipe(fn, ...)`
- `tap(fn)`
- `tapError(fn)`
- `log(fn)`
- `toDisposable(fn)`
- `unwrapOr(defaultValue)`
- `unwrapOrThrow()`
- `_unsafeUnwrap()`
- `_unsafeUnwrapErr()`
- `safeUnwrap()`

### Result static methods

- `Result.ok(value)`
- `Result.err(error)`
- `Result.unit()`
- `Result.tryCatch(fn, toError?)` as a backward-compatible alias
- `Result.fromThrowable(fn, toError?)`
- `Result.zip(left, right)`
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
- `Result.when(condition, body)`
- `Result.whenResult(conditionResult, body)`
- `Result.unless(condition, body)`
- `Result.unlessResult(conditionResult, body)`
- `Result.loop(initial, options)`
- `Result.iterate(initial, options)`
- `Result.forEach(iterable, fn, options?)`

### ResultAsync helpers

- `okAsync(value)`
- `errAsync(error)`
- `unitAsync()`
- `fromPromise(promise, toError)`
- `fromSafePromise(promise)`
- `fromThrowableAsync(fn, toError?)`
- `tryResultAsync(promiseOrFactory, toError?)`
- `tryResultAsync({ try, catch? })`
- `tryAsync(promiseOrFactory, toError?)`
- `tryCatchAsync(promiseOrFactory, toError?)` as a backward-compatible alias
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

### ResultAsync methods

- `map(fn)`
- `as(value)`
- `mapErr(fn)`
- `andThen(fn)`
- `orElse(fn)`
- `catchTag(tag, fn)`
- `catchTags(handlers)`
- `catchReason(parentTag, reasonTag, fn)`
- `catchReasons(parentTag, handlers)`
- `unwrapReason(parentTag)`
- `match(okFn, errFn)`
- `matchTags(okFn, handlers)`
- `matchTagsPartial(okFn, handlers, fallback)`
- `pipe(fn, ...)`
- `tap(fn)`
- `tapError(fn)`
- `log(fn)`
- `toAsyncDisposable(fn)`
- `unwrapOr(defaultValue)`
- `unwrapOrThrow()`

### ResultAsync static methods

- `ResultAsync.okAsync(value)`
- `ResultAsync.errAsync(error)`
- `ResultAsync.unitAsync()`
- `ResultAsync.tryCatch(promiseOrFactory, toError?)` as a backward-compatible alias
- `ResultAsync.fromSafePromise(promise)`
- `ResultAsync.fromPromise(promise, toError)`
- `ResultAsync.fromThrowable(fn, toError?)`
- `ResultAsync.zip(left, right)`
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
- `ResultAsync.when(condition, body)`
- `ResultAsync.whenResult(conditionResult, body)`
- `ResultAsync.unless(condition, body)`
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
- `packages/resultar-check`: TypeScript >=7 plus Resultar validation and AST-only lint adapters.
- `benchmarks`: benchmark workspace package.
- `examples/resultar`: runnable core Resultar cookbook.
- `examples/lint`: adapter parity smoke for AST-only Resultar rules across Oxlint, ESLint, and `resultar-check` CLI.

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
