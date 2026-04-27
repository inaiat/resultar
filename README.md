# Resultar

Typed `Result` primitives for TypeScript, with ergonomic tagged errors.

Resultar began as an initial fork of `neverthrow`. The v2 direction keeps the explicit `Result`
wrapper model while evolving toward Resultar-specific tagged errors, strict service-boundary types,
and TypeScript 6-ready ESM packaging.

Resultar models fallible work explicitly:

```ts
Result<T, E>
ResultAsync<T, E>
StrictResult<T, E extends Error>
StrictResultAsync<T, E extends Error>
```

Use `Result` when an operation can fail synchronously, `ResultAsync` when it returns a promise, and
tagged errors when you want strongly typed `Error` classes with stable tags and metadata.
Prefer `StrictResult` and `StrictResultAsync` at service boundaries so expected failures are real
`Error` instances with `message`, `cause`, stack traces, and structured metadata.

## Requirements

- ESM only
- Node.js 24+
- TypeScript 6-ready

```ts
import { ok, err, createTaggedError } from 'resultar'
```

CommonJS `require('resultar')` is not exported.

## Install

```sh
pnpm add resultar
```

```sh
npm install resultar
```

## Philosophy

Resultar is a small explicit-result library, not an application runtime or an Effect-style framework.
It focuses on three things:

- Make expected failures visible in function signatures.
- Compose sync and async fallible work without `try/catch` control-flow blocks.
- Keep expected application failures observable by modeling them as real typed `Error` values.

The core model stays intentionally simple:

```ts
Result<T, E>
ResultAsync<T, E>
```

Use generic `Result<T, E>` when local code benefits from lightweight strings, enums, or domain
objects. Use `StrictResult<T, E extends Error>` and `StrictResultAsync<T, E extends Error>` when a
failure can cross a module, service, HTTP, job, or integration boundary.

## Recommended Production Style

For backend and application code, prefer this stack:

1. Define expected domain/application failures with `createTaggedError`.
2. Return them through `StrictResult` or `StrictResultAsync`.
3. Compose with `map`, `andThen`, `asyncAndThen`, `orElse`, `catchTag`, and `catchTags`.
4. Map outcomes at boundaries with `matchTags` or `matchTagsPartial`.
5. Use `tap`, `tapError`, `log`, and `finally` only for best-effort side effects.

```ts
import type { StrictResult } from 'resultar'

import { createTaggedError, ok } from 'resultar'

class UserAlreadyExistsError extends createTaggedError({
  name: 'UserAlreadyExistsError',
  message: 'User $email already exists',
}) {}

const ensureUserDoesNotExist = (
  email: string,
): StrictResult<string, UserAlreadyExistsError> =>
  email === 'taken@example.com' ? UserAlreadyExistsError.err({ email }) : ok(email)
```

Avoid using strings or loose objects for production-facing expected failures:

```ts
// Local-only style. Avoid at service boundaries.
type ParseError = 'InvalidPort'
```

## API Decision Guide

Use `map` when the `Ok` value changes and the transform cannot fail.

Use `andThen` when the next step can fail and returns another `Result`. Use `asyncAndThen` when a
sync `Result` continues into `ResultAsync`.

Use `mapErr` when the error value changes. Use `orElse` when an error should recover into another
`Result`.

Use `catchTag` or `catchTags` for local recovery from tagged errors. `catchTags` is intentionally
partial: unhandled tags stay in the error channel.

Use `match` for simple boundaries. Use `matchTags` when every tagged error must be handled. Use
`matchTagsPartial` when only selected tagged errors need custom handling and the rest should go to a
fallback.

Use `fromPromise(promise, toError)` when you already have a promise. Use
`tryCatchAsync(() => promiseFactory(), toError)` when creating the promise can throw synchronously.

Use `tryCatch` / `tryCatchAsync` at the edge of uncontrolled code: JSON parsing, third-party
libraries, I/O, network calls, and other APIs that throw or reject. Keep your own domain functions
returning `Result` values instead of throwing expected failures.

## Quick Start

```ts
import type { StrictResult } from 'resultar'

import { createTaggedError, ok } from 'resultar'

class InvalidPortError extends createTaggedError({
  name: 'InvalidPortError',
  message: 'Invalid port $value',
}) {}

const parsePort = (value: string): StrictResult<number, InvalidPortError> => {
  const port = Number(value)

  return Number.isInteger(port) && port > 0
    ? ok(port)
    : InvalidPortError.err({ value })
}

const message = parsePort('3000').match(
  (port) => `Listening on ${port}`,
  (error) => error.message,
)
```

## Strict Results

`StrictResult<T, E extends Error>` and `StrictResultAsync<T, E extends Error>` are type-only aliases
for code that should return only `Error`-based failures.

```ts
import type { StrictResult } from 'resultar'

import { createTaggedError, ok } from 'resultar'

class InvalidEmailError extends createTaggedError({
  name: 'InvalidEmailError',
  message: 'Invalid email $email',
}) {}

const validateEmail = (email: string): StrictResult<string, InvalidEmailError> =>
  email.includes('@') ? ok(email) : InvalidEmailError.err({ email })
```

Use generic `Result<T, E>` for small local flows where strings, enums, or lightweight domain objects
are useful. Prefer `StrictResult` for application and backend service boundaries where logging,
`cause`, stack traces, and tagged-error matching matter.

## Expected Failure Style

For expected application and domain failures, prefer `createTaggedError` classes and return them
through `StrictResult` or `StrictResultAsync`.

```ts
class UserAlreadyExistsError extends createTaggedError({
  name: 'UserAlreadyExistsError',
  message: 'User $email already exists',
}) {}
```

Plain `Error` subclasses from libraries and runtimes are still valid in strict results when their
identity is already useful, such as validation, database, abort, or platform errors. Keep
`Err<string>`, `Err<object>`, and `TaggedEnum` for narrow local flows where stack traces, `cause`,
structured logging, and boundary matching do not matter.

## Result

`Result<T, E>` is either `Ok<T>` or `Err<E>`.

```ts
import type { StrictResult } from 'resultar'

import { createTaggedError, ok } from 'resultar'

class UserNotFoundError extends createTaggedError({
  name: 'UserNotFoundError',
  message: 'User $id not found',
}) {}

const findUser = (id: string): StrictResult<{ id: string }, UserNotFoundError> =>
  id === 'usr_123' ? ok({ id }) : UserNotFoundError.err({ id })

const result = findUser('usr_123')

if (result.isOk()) {
  result.value.id
}

if (result.isErr()) {
  result.error.message
}
```

### Chaining

Use `map` for infallible transforms and `andThen` for fallible transforms.

```ts
import type { StrictResult } from 'resultar'

import { createTaggedError, ok } from 'resultar'

type User = {
  readonly email: string
}

class InvalidEmailError extends createTaggedError({
  name: 'InvalidEmailError',
  message: 'Invalid email $email',
}) {}

class InvalidDomainError extends createTaggedError({
  name: 'InvalidDomainError',
  message: 'Invalid email domain $domain',
}) {}

const validateEmail = (email: string): StrictResult<string, InvalidEmailError> =>
  email.includes('@') ? ok(email) : InvalidEmailError.err({ email })

const createUser = (email: string): StrictResult<User, InvalidEmailError> =>
  validateEmail(email).map((validEmail) => ({ email: validEmail }))
```

Use `filterOrElse` when a successful value must satisfy an extra predicate:

```ts
const validateCompanyEmail = (
  email: string,
): StrictResult<string, InvalidEmailError | InvalidDomainError> =>
  validateEmail(email).filterOrElse(
    (validEmail) => validEmail.endsWith('@company.com'),
    (validEmail) => new InvalidDomainError({ domain: validEmail.split('@')[1] ?? 'unknown' }),
  )
```

Generic `Result<T, E>` still supports strings, enums, and lightweight objects for narrow local flows.
For application and backend service boundaries, prefer `StrictResult<T, E extends Error>` with
`createTaggedError`.

Use `pipe` when you want to apply reusable Result combinators:

```ts
const audit =
  <T, E>(result: Result<T, E>): Result<T, E> =>
    result.tap((value) => console.log('created', value))

const result = createUser('person@example.com').pipe(
  audit,
  (userResult) => userResult.map((user) => user.email),
)
```

### Matching

Use `match` at boundaries.

```ts
const response = createUser('person@example.com').match(
  (user) => ({ body: user, statusCode: 201 }),
  (error) => ({ body: { error }, statusCode: 400 }),
)
```

## ResultAsync

`ResultAsync<T, E>` wraps `Promise<Result<T, E>>` and keeps the same composition style.

```ts
import type { StrictResultAsync } from 'resultar'

import { createTaggedError, fromPromise } from 'resultar'

type User = {
  readonly id: string
}

class FetchUserError extends createTaggedError({
  name: 'FetchUserError',
  message: 'Failed to fetch user $id',
}) {}

const fetchUser = (id: string): StrictResultAsync<User, FetchUserError> =>
  fromPromise(
    fetch(`https://example.com/users/${id}`).then((response) => response.json() as Promise<User>),
    (cause) => new FetchUserError({ cause, id }),
  )

const label = await fetchUser('usr_123').match(
  (user) => `User ${user.id}`,
  (error) => error.message,
)
```

## Tagged Errors

Tagged errors are real `Error` subclasses with:

- `_tag`
- inferred constructor props from `$variables` in the message template
- `messageTemplate`
- `fingerprint`
- `cause`
- `.toJSON()`
- `.findCause(ErrorClass)`
- static `.is(value)` using `instanceof` for nominal class checks
- static `.err(props)`

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

Missing template props are TypeScript errors:

```ts
new UserNotFoundError({ id: 'usr_123', source: 'database' })

// @ts-expect-error source is required
new UserNotFoundError({ id: 'usr_123' })
```

Reserved template variables are rejected because they would conflict with `Error` or tagged-error
metadata:

```ts
// @ts-expect-error name is reserved
createTaggedError({ name: 'BadError', message: 'Bad $name' })
```

Reserved variables are `_tag`, `name`, `message`, `messageTemplate`, `fingerprint`, `stack`, and
`cause`.

For lightweight tagged domain unions that do not need to extend `Error`, use `TaggedEnum`:

```ts
import type { TaggedEnum } from 'resultar'

type PaymentError = TaggedEnum<{
  CardDeclined: { readonly code: string }
  InsufficientFunds: { readonly balance: number }
}>

const error: PaymentError = { _tag: 'CardDeclined', code: 'card_declined' }
```

## Tagged Errors With Result

Tagged errors are most useful as the `E` side of `StrictResult<T, E>` and
`StrictResultAsync<T, E>`.

```ts
import type { StrictResult } from 'resultar'

import { createTaggedError, ok } from 'resultar'

class InvalidEmailError extends createTaggedError({
  name: 'InvalidEmailError',
  message: 'Invalid email $email',
}) {}

class UserAlreadyExistsError extends createTaggedError({
  name: 'UserAlreadyExistsError',
  message: 'User $email already exists',
}) {}

class DatabaseError extends createTaggedError({
  name: 'DatabaseError',
  message: 'Database operation $operation failed',
}) {}

type User = {
  readonly email: string
  readonly id: string
}

type CreateUserError = InvalidEmailError | UserAlreadyExistsError | DatabaseError

const validateEmail = (email: string): StrictResult<string, InvalidEmailError> =>
  email.includes('@') ? ok(email) : InvalidEmailError.err({ email })

const ensureUserDoesNotExist = (
  email: string,
): StrictResult<string, UserAlreadyExistsError | DatabaseError> => {
  if (email === 'taken@example.com') {
    return UserAlreadyExistsError.err({ email })
  }

  return ok(email)
}

const insertUser = (email: string): StrictResult<User, DatabaseError> =>
  ok({ email, id: 'usr_123' })

const createUser = (email: string): StrictResult<User, CreateUserError> =>
  validateEmail(email)
    .andThen(ensureUserDoesNotExist)
    .andThen(insertUser)
```

`InvalidEmailError.err({ email })` returns `Result<never, InvalidEmailError>`. Because `never` is assignable to every success type, it works naturally in functions returning `Result<string, InvalidEmailError>`.

Use `catchTag` when one tagged error can be recovered locally:

```ts
const result = createUser('bad-email').catchTag('InvalidEmailError', (error) =>
  ok({
    email: error.email,
    id: 'draft_user',
  }),
)
```

Use `catchTags` when a small set of tagged errors share local recovery:

```ts
const result = createUser('taken@example.com').catchTags({
  InvalidEmailError: (error) => ok({ email: error.email, id: 'draft_user' }),
  UserAlreadyExistsError: (error) => ok({ email: error.email, id: 'existing_user' }),
})
```

`catchTags` is intentionally partial: any unhandled error tag stays in the `Err` side. A separate
`partialCatchTags` API would duplicate this behavior.

At the boundary, use `matchTags` for direct success and tagged-error response mapping:

```ts
const result = createUser('taken@example.com')

const response = result.matchTags(
  (user) => ({
    body: user,
    statusCode: 201,
  }),
  {
    InvalidEmailError: (err) => ({
      body: { code: err._tag, message: err.message },
      statusCode: 400,
    }),
    UserAlreadyExistsError: (err) => ({
      body: { code: err._tag, message: err.message },
      statusCode: 409,
    }),
    DatabaseError: (err) => ({
      body: { code: err._tag, message: err.message },
      statusCode: 500,
    }),
  },
)
```

If a handler is missing, TypeScript reports it. For partial boundary matching, use
`matchTagsPartial(okHandler, handlers, fallback)`:

```ts
const response = result.matchTagsPartial(
  (user) => ({
    body: user,
    statusCode: 201,
  }),
  {
    InvalidEmailError: (err) => ({
      body: { code: err._tag, message: err.message },
      statusCode: 400,
    }),
  },
  (err) => ({
    body: { code: 'UnhandledError', message: err.message },
    statusCode: 500,
  }),
)
```

Use `catchTags` for pipeline recovery and `matchTagsPartial` for boundary mapping.

When the error union includes plain or untagged `Error`, add an `Error` fallback. Use standalone `matchError` when you only have an error value rather than a `Result`.

```ts
declare const error: InvalidEmailError | DatabaseError | Error

const message = matchError(error, {
  DatabaseError: (err) => err.message,
  Error: (err) => err.message,
  InvalidEmailError: (err) => err.message,
})
```

## Partial Matching

Use `matchErrorPartial` when only some tagged errors need special handling.

```ts
import { matchErrorPartial } from 'resultar'

declare const error: InvalidEmailError | UserAlreadyExistsError | DatabaseError

const message = matchErrorPartial(
  error,
  {
    InvalidEmailError: (err) => `Invalid input: ${err.email}`,
  },
  (err) => err.message,
)
```

## Causes

Tagged errors support native `cause` and cause-chain lookup.

```ts
import { findCause } from 'resultar'

const cause = new Error('connection refused')
const error = new DatabaseError({
  cause,
  operation: 'insert-user',
})

error.cause // cause
findCause(error, Error) // cause
error.findCause(Error) // cause
```

Cause lookup is cycle-safe: circular cause chains stop and return `undefined` when no matching cause
exists.

## Safe Try

`safeTry` lets you unwrap successful results inside a generator and return early on the first error.

The shortest form is `yield* result`. `yield* result.safeUnwrap()` is still supported, but usually not necessary.

```ts
import type { Result, ResultAsync } from 'resultar'

import { ok, safeTry } from 'resultar'

declare const readConfig: () => Result<{ port: string }, Error>
declare const parsePort: (value: string) => Result<number, Error>
declare const persistPort: (port: number) => ResultAsync<void, Error>

const loadPort = (): Result<number, Error> =>
  safeTry(function* () {
    const config = yield* readConfig()
    const port = yield* parsePort(config.port)

    return ok(port)
  })

const savePort = (): ResultAsync<number, Error> =>
  safeTry(async function* () {
    const config = yield* readConfig()
    const port = yield* parsePort(config.port)

    yield* persistPort(port)

    return ok(port)
  })
```

## Side Effects

Use `tap`, `tapError`, `log`, and `finally` for best-effort observation and cleanup. They are not
transform methods: use `map`, `mapErr`, `andThen`, or `orElse` when the value or error should change.

`tap(fn)` runs only for `Ok` and returns the original result unchanged.

```ts
import { ok } from 'resultar'

const result = ok({ id: 'usr_123' }).tap((user) => {
  console.info('user loaded', user.id)
})

// still Result<{ id: string }, never>
result
```

`tapError(fn)` runs only for `Err` and returns the original result unchanged.

```ts
import { err } from 'resultar'

const result = err(new Error('database unavailable')).tapError((error) => {
  console.error('load failed', error)
})

// still Result<never, Error>
result
```

`log(fn)` runs for both states. For `Ok`, the callback receives `(value, undefined)`. For `Err`, it
receives `(undefined, error)`.

```ts
const result = findUser('usr_123').log((user, error) => {
  if (error) {
    console.error('find user failed', error)
    return
  }

  console.info('find user succeeded', user)
})
```

For `ResultAsync`, these callbacks may be synchronous or asynchronous. The original async result is
still preserved, even if the callback throws or rejects.

```ts
const result = fetchUser('usr_123')
  .tap((user) => metrics.increment('user.found', { id: user.id }))
  .tapError((error) => metrics.increment('user.failed', { message: error.message }))
  .log((user, error) => audit.write({ error, user }))
```

`finally(fn)` runs a best-effort cleanup callback with both `(value, error)`. On `Result`, the
callback runs before the method returns. On `ResultAsync`, it runs when the inner promise settles to a
`Result`, and async cleanup is awaited before the original result is returned.

```ts
const result = findUser('usr_123').finally((_user, _error) => {
  span.end()
})
```

Callback errors thrown by `tap`, `tapError`, `log`, and `finally` are intentionally ignored so
observability or cleanup code does not replace the original result. For `ResultAsync`, rejected
callback promises are ignored too. Put fallible work in `andThen`, `orElse`, `tryCatch`, or
`tryCatchAsync` when those failures should become part of the result type.

## Coming From Other Styles

### From try/catch

Use `tryCatch` and `tryCatchAsync` only where uncontrolled code can throw. Convert that failure into
a typed error once, then return `Result` values from your own code.

```ts
const parseConfig = (input: string): StrictResult<Config, ParseConfigError> =>
  tryCatch(
    () => JSON.parse(input) as Config,
    (cause) => new ParseConfigError({ cause }),
  )
```

### From neverthrow-style wrappers

Resultar keeps the wrapper model, but recommends tagged `Error` values for production error
channels. Use `.value` only after `isOk()` and `.error` only after `isErr()`, or prefer `match` /
`matchTags` at boundaries.

### From raw `T | Error`

Raw unions are concise, but they rely on a convention that successful values are never `Error`
instances. Resultar keeps success and failure structurally separate, so `Ok<Error>` is still a valid
success value when a domain needs it.

### From Effect

Resultar does not provide dependency injection, fibers, scopes, schedules, streams, or a runtime. It
borrows the useful discipline of typed expected errors and composable recovery while staying a small
library around `Result` and `ResultAsync`.

## API

### Result Helpers

- `ok(value)`
- `err(error)`
- `unit()`
- `tryCatch(fn, errorFn?)`
- `fromThrowable(fn, errorFn?)`
- `safeTry(generator)`
- `StrictResult<T, E extends Error>` type alias for Error-only failure channels

### Result Methods

- `isOk()`
- `isErr()`
- `map(fn)`
- `mapErr(fn)`
- `filterOrElse(predicate, onFalse)`
- `andThen(fn)`
- `asyncAndThen(fn)`
- `orElse(fn)`
- `catchTag(tag, fn)`
- `catchTags(handlers)`
- `tap(fn)` run a side effect only when `Ok`; preserves the original result
- `tapError(fn)` run a side effect only when `Err`; preserves the original result
- `log(fn)` run a side effect for both states as `(value, error)`; preserves the original result
- `finally(fn)` run best-effort cleanup with `(value, error)`; callback errors are ignored
- `match(okFn, errFn)`
- `matchTags(okFn, handlers)`
- `matchTagsPartial(okFn, handlers, fallback)`
- `pipe(fn, ...)`
- `asyncMap(fn)`
- `unwrapOr(defaultValue)`
- `unwrapOrThrow()`
- `_unsafeUnwrap()`
- `_unsafeUnwrapErr()`
- `safeUnwrap()`

### Result Static Methods

- `Result.ok(value)`
- `Result.err(error)`
- `Result.unit()`
- `Result.tryCatch(fn, errorFn?)`
- `Result.fromThrowable(fn, errorFn?)`
- `Result.combine(results)`
- `Result.combineWithAllErrors(results)`

### ResultAsync Helpers

- `okAsync(value)`
- `errAsync(error)`
- `unitAsync()`
- `fromPromise(promise, errorFn)`
- `fromSafePromise(promise)`
- `fromThrowableAsync(fn, errorFn?)`
- `tryCatchAsync(promiseOrFn, errorFn?)` catches rejections and synchronous throws from factories
- `safeTryAsync(generator)` deprecated; use `safeTry`
- `StrictResultAsync<T, E extends Error>` type alias for Error-only async failure channels

### ResultAsync Methods

- `map(fn)`
- `mapErr(fn)`
- `andThen(fn)`
- `orElse(fn)`
- `tap(fn)` run a sync or async side effect only when `Ok`; preserves the original result
- `tapError(fn)` run a sync or async side effect only when `Err`; preserves the original result
- `log(fn)` run a sync or async side effect for both states as `(value, error)`
- `finally(fn)` run best-effort cleanup with `(value, error)` after the inner promise settles to a
  `Result`; callback errors and rejections are ignored
- `match(okFn, errFn)`
- `matchTags(okFn, handlers)`
- `matchTagsPartial(okFn, handlers, fallback)`
- `unwrapOr(defaultValue)`
- `unwrapOrThrow()`
- `safeUnwrap()`

### Tagged Error Helpers

- `createTaggedError(options)`
- `matchError(error, handlers)`
- `matchErrorPartial(error, handlers, fallback)`
- `isError(value)`
- `findCause(error, ErrorClass)`
- `TaggedEnum<Members>` type helper

## Testing

`_unsafeUnwrap()` and `_unsafeUnwrapErr()` are intended for tests.

```ts
import { ok } from 'resultar'

expect(ok(42)._unsafeUnwrap()).toBe(42)
```

By default, thrown unwrap errors omit stack traces for cleaner test output. Pass `withStackTrace` if needed:

```ts
result._unsafeUnwrapErr({ withStackTrace: true })
```

## Development

This repository uses Vite+.

```sh
pnpm install
pnpm run fmt:check
pnpm run lint
pnpm test
pnpm run test:cov
pnpm run build
pnpm run check:full
```

Package output:

- `dist/index.js`
- `dist/index.js.map`
- `dist/index.d.ts`

## License

MIT
