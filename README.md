# Resultar

Typed `Result` primitives for TypeScript, with ergonomic tagged errors.

Resultar models fallible work explicitly:

```ts
Result<T, E>
ResultAsync<T, E>
```

Use `Result` when an operation can fail synchronously, `ResultAsync` when it returns a promise, and tagged errors when you want strongly typed `Error` classes with stable tags and metadata.

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

## Quick Start

```ts
import type { Result } from 'resultar'

import { err, ok } from 'resultar'

type ParseError = {
  readonly reason: string
}

const parsePort = (value: string): Result<number, ParseError> => {
  const port = Number(value)

  return Number.isInteger(port) && port > 0
    ? ok(port)
    : err({ reason: `Invalid port: ${value}` })
}

const message = parsePort('3000').match(
  (port) => `Listening on ${port}`,
  (error) => error.reason,
)
```

## Result

`Result<T, E>` is either `Ok<T>` or `Err<E>`.

```ts
import type { Result } from 'resultar'

import { err, ok } from 'resultar'

const findUser = (id: string): Result<{ id: string }, 'NotFound'> =>
  id === 'usr_123' ? ok({ id }) : err('NotFound')

const result = findUser('usr_123')

if (result.isOk()) {
  // narrowed to Result<{ id: string }, never>
  result.value.id
}

if (result.isErr()) {
  // narrowed to Result<never, 'NotFound'>
  result.error
}
```

### Chaining

Use `map` for infallible transforms and `andThen` for fallible transforms.

```ts
import type { Result } from 'resultar'

import { err, ok } from 'resultar'

type User = {
  readonly email: string
}

const validateEmail = (email: string): Result<string, 'InvalidEmail'> =>
  email.includes('@') ? ok(email) : err('InvalidEmail')

const createUser = (email: string): Result<User, 'InvalidEmail'> =>
  validateEmail(email).map((validEmail) => ({ email: validEmail }))
```

Use `filterOrElse` when a successful value must satisfy an extra predicate:

```ts
const validateCompanyEmail = (email: string): Result<string, 'InvalidEmail' | 'InvalidDomain'> =>
  validateEmail(email).filterOrElse(
    (validEmail) => validEmail.endsWith('@company.com'),
    () => 'InvalidDomain',
  )
```

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
import type { ResultAsync } from 'resultar'

import { fromPromise } from 'resultar'

type User = {
  readonly id: string
}

const fetchUser = (id: string): ResultAsync<User, Error> =>
  fromPromise(
    fetch(`https://example.com/users/${id}`).then((response) => response.json() as Promise<User>),
    (cause) => new Error('Failed to fetch user', { cause }),
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

Tagged errors are most useful as the `E` side of `Result<T, E>`.

```ts
import type { Result } from 'resultar'

import { createTaggedError, matchError, ok } from 'resultar'

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

const validateEmail = (email: string): Result<string, InvalidEmailError> =>
  email.includes('@') ? ok(email) : InvalidEmailError.err({ email })

const ensureUserDoesNotExist = (
  email: string,
): Result<string, UserAlreadyExistsError | DatabaseError> => {
  if (email === 'taken@example.com') {
    return UserAlreadyExistsError.err({ email })
  }

  return ok(email)
}

const insertUser = (email: string): Result<User, DatabaseError> =>
  ok({ email, id: 'usr_123' })

const createUser = (email: string): Result<User, CreateUserError> =>
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

If a handler is missing, TypeScript reports it. For partial boundary matching, prefer a future
`matchTagsPartial(okHandler, handlers, fallback)` style API over `partialCatchTags`, because
catching is pipeline recovery and matching is boundary mapping.

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

Use `tap`, `tapError`, `log`, and `finally` for observation and cleanup. They are not transform methods:
use `map`, `mapErr`, `andThen`, or `orElse` when the value or error should change.

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
still preserved.

```ts
const result = fetchUser('usr_123')
  .tap((user) => metrics.increment('user.found', { id: user.id }))
  .tapError((error) => metrics.increment('user.failed', { message: error.message }))
  .log((user, error) => audit.write({ error, user }))
```

`finally(fn)` runs a cleanup callback with both `(value, error)`. On `Result`, the callback runs before
the method returns. On `ResultAsync`, it runs when the inner promise settles to a `Result`.

```ts
const result = findUser('usr_123').finally((_user, _error) => {
  span.end()
})
```

Callback errors thrown by `tap`, `tapError`, `log`, and `finally` are intentionally ignored so
observability code does not replace the original result. Put fallible work in `andThen`, `orElse`, or
`tryCatch` when those failures should become part of the result type.

## API

### Result Helpers

- `ok(value)`
- `err(error)`
- `unit()`
- `tryCatch(fn, errorFn?)`
- `fromThrowable(fn, errorFn?)`
- `safeTry(generator)`

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
- `finally(fn)` run cleanup with `(value, error)`; callback errors are ignored
- `match(okFn, errFn)`
- `matchTags(okFn, handlers)`
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

### ResultAsync Methods

- `map(fn)`
- `mapErr(fn)`
- `andThen(fn)`
- `orElse(fn)`
- `tap(fn)` run a sync or async side effect only when `Ok`; preserves the original result
- `tapError(fn)` run a sync or async side effect only when `Err`; preserves the original result
- `log(fn)` run a sync or async side effect for both states as `(value, error)`
- `finally(fn)` run cleanup with `(value, error)` after the inner promise settles to a `Result`
- `match(okFn, errFn)`
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

- `dist/index.mjs`
- `dist/index.mjs.map`
- `dist/index.d.mts`

## License

MIT
