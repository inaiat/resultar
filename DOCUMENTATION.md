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
- [Coming from other styles](#coming-from-other-styles)
- [API map](#api-map)

## Use Case Index

| If you need to... | Start here | Main APIs |
| --- | --- | --- |
| Create success or failure values | [Creating Results](#creating-results) | `ok`, `err`, `unit`, `okAsync`, `errAsync`, `unitAsync` |
| Model expected domain failures | [Tagged Errors](#tagged-errors) | `createTaggedError`, `.err`, `StrictResult` |
| Keep failure channels Error-only | [Strict Results](#strict-results) | `StrictResult`, `StrictResultAsync` |
| Wrap code that throws | [Wrapping Throwing Or Rejecting Code](#wrapping-throwing-or-rejecting-code) | `tryResult`, `fromThrowable` |
| Wrap promises or async factories | [Wrapping Throwing Or Rejecting Code](#wrapping-throwing-or-rejecting-code) | `tryResultAsync`, `fromPromise`, `fromSafePromise`, `fromThrowableAsync` |
| Transform successful values | [Composing Steps](#composing-steps) | `map`, `asyncMap`, `filterOrElse` |
| Chain fallible steps | [Composing Steps](#composing-steps) | `andThen`, `asyncAndThen` |
| Recover from failures | [Recovering Tagged Errors Locally](#recovering-tagged-errors-locally) | `orElse`, `catchTag`, `catchTags` |
| Choose fallback behavior | [Fallbacks](#fallbacks) | `orElse`, `mapErr`, `unwrapOr`, `firstSuccessOf` |
| Convert results into responses | [Handling Results At Boundaries](#handling-results-at-boundaries) | `match`, `matchTags`, `matchTagsPartial` |
| Match an error value directly | [Handling Results At Boundaries](#handling-results-at-boundaries) | `matchError`, `matchErrorPartial` |
| Write linear result code | [Safe Try](#safe-try) | `safeTry`, `yield* result`, object-form `safeTry` |
| Branch without throwing | [Conditional Helpers](#conditional-helpers) | `Result.if`, `Result.when`, `Result.unless`, `whenResult`, `unlessResult` |
| Combine many independent results | [Combining And Iterating](#combining-and-iterating) | `combine`, `combineWithAllErrors`, `firstSuccessOf` |
| Loop or process collections | [Combining And Iterating](#combining-and-iterating) | `loop`, `iterate`, `forEach` |
| Add logging or cleanup | [Side Effects And Cleanup](#side-effects-and-cleanup) | `tap`, `tapError`, `log`, `toDisposable`, `toAsyncDisposable` |
| Understand callback exceptions | [Callback Failure Semantics](#callback-failure-semantics) | transform callbacks vs observation callbacks |
| Unwrap at tests or final edges | [Unwrapping Results](#unwrapping-results) | `unwrapOr`, `unwrapOrThrow`, `_unsafeUnwrap`, `_unsafeUnwrapErr` |
| Prevent ignored results | [No-Discard Validation](#no-discard-validation) | `resultar-lint check`, `resultar-lint` |
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

`toJSON()` returns predictable error metadata for logs, responses, and snapshots:

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

Use `TaggedEnum<Members>` only for lightweight tagged unions that do not need to be real errors:

```ts
import type { TaggedEnum } from 'resultar'

type PaymentState = TaggedEnum<{
  Declined: { readonly code: string }
  Pending: { readonly retryAfterMs: number }
  Settled: { readonly receiptId: string }
}>
```

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

## Fallbacks

Fallbacks are useful when an `Err` has a meaningful recovery path. Resultar keeps fallback behavior
explicit through existing `Result` and `ResultAsync` operations.

| Effect fallback idea | Resultar equivalent | Use when |
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

## Side Effects And Cleanup

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

Resultar values should not be ignored. The workspace ships a type-aware check for discarded
`Result` and `ResultAsync` values.

Add a lint-like script:

```json
{
  "scripts": {
    "lint:resultar": "resultar-lint check --project tsconfig.json"
  }
}
```

This fails:

```ts
saveUser(input)
```

These are intentional:

```ts
const result = saveUser(input)
return saveUser(input)
void saveUser(input)
```

For editor diagnostics, install the language-service package:

```sh
pnpm add -D resultar-lint typescript
```

Enable it in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "resultar-lint", "noDiscard": "error" }]
  }
}
```

TypeScript language-service plugins are editor-only by default. To make `tsc` report no-discard
diagnostics during builds, patch the local TypeScript installation:

```sh
pnpm exec resultar-lint patch
```

Use `resultar-lint doctor` to verify patch status and `resultar-lint unpatch` to remove only Resultar
patch blocks.

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
| Collect all validation failures | `validateAll` or `combineWithAllErrors` |
| Try fallback candidates | `firstSuccessOf` |
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

`ResultAsync.validateAll(results)` and `ResultAsync.validateAll(items, fn)` provide the same shape
for async validations.

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

`Result.forEach(iterable, fn, options?)` processes items sequentially, passes `(value, index)`, and
collects success values by default.

```ts
const parsed = Result.forEach(['1', '2', '3'], (value, index) =>
  parseNumber(value).map((number) => ({ index, number })),
)
```

It stops on the first error and does not call later items. Use `{ discard: true }` when the callback
is only needed for effects:

```ts
const saved = ResultAsync.forEach(users, (user, index) => saveUser(user, index), {
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

The async variants run sequentially and short-circuit on the first `Err`.

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

## Public Entry Point

Import runtime helpers and type-only names from `resultar`:

```ts
import {
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
  isError,
  matchError,
  matchErrorPartial,
  ok,
  okAsync,
  safeTry,
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
  ResultOperations,
  StrictResult,
  StrictResultAsync,
  TaggedEnum,
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
- `Result.combineWithAllErrors(results)`
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
- `StrictResultAsync<T, E extends Error>`

### ResultAsync methods

- `map(fn)`
- `as(value)`
- `mapErr(fn)`
- `andThen(fn)`
- `orElse(fn)`
- `catchTag(tag, fn)`
- `catchTags(handlers)`
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
- `ResultAsync.combineWithAllErrors(results)`
- `ResultAsync.validateAll(results)`
- `ResultAsync.validateAll(iterable, fn)`
- `ResultAsync.firstSuccessOf(candidates)`
- `ResultAsync.if(condition, { onTrue, onFalse })`
- `ResultAsync.when(condition, body)`
- `ResultAsync.whenResult(conditionResult, body)`
- `ResultAsync.unless(condition, body)`
- `ResultAsync.unlessResult(conditionResult, body)`
- `ResultAsync.loop(initial, options)`
- `ResultAsync.iterate(initial, options)`
- `ResultAsync.forEach(iterable, fn, options?)`

### Tagged error helpers

- `createTaggedError(options)`
- `matchError(error, handlers)`
- `matchErrorPartial(error, handlers, fallback)`
- `isError(value)`
- `findCause(error, ErrorClass)`
- `TaggedEnum<Members>`
- `TaggedErrorClass`
- `TaggedErrorInstance`
- `TaggedErrorOptions`

## Reference Docs

Use this guide as the curated reference for API behavior, examples, and production style. The public
entry point and API map above list the exported runtime helpers and type-only names.

## Workspace

This repository is a pnpm workspace:

- `packages/resultar`: the Resultar runtime package.
- `packages/resultar-lint`: TypeScript language-service diagnostics and no-discard checks.
- `packages/resultar-tsgo`: a TypeScript 7 native-preview wrapper for `tsgo` plus Resultar
  no-discard validation.
- `benchmarks`: benchmark workspace package.
- `examples/resultar-lint`: smoke example for build-time no-discard diagnostics.
- `examples/tsgo`: TypeScript 7 native-preview smoke example.

Common commands:

```sh
pnpm install
pnpm run fmt:check
pnpm run lint
pnpm test
pnpm run test:cov
pnpm run build
pnpm run check:full
pnpm run test:language-service
pnpm run bench
```

## License

MIT
