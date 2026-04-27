# Resultar Patterns

Copy these patterns when implementing Resultar-based flows.

## Validate Then Transform

```ts
import type { Result } from 'resultar'

import { createTaggedError, ok } from 'resultar'

class InvalidEmailError extends createTaggedError({
  name: 'InvalidEmailError',
  message: 'Invalid email $email',
}) {}

const validateEmail = (email: string): Result<string, InvalidEmailError> =>
  email.includes('@') ? ok(email) : InvalidEmailError.err({ email })

const normalizeEmail = (email: string): Result<string, InvalidEmailError> =>
  validateEmail(email).map((value) => value.trim().toLowerCase())
```

## Compose Domain Steps

```ts
type CreateUserError = InvalidEmailError | UserAlreadyExistsError | DatabaseError

const createUser = (email: string): Result<User, CreateUserError> =>
  validateEmail(email).andThen(ensureUserDoesNotExist).andThen(insertUser)
```

Keep each step's error type specific. Let composition widen the final error union.

## Compose Async Steps

```ts
const createUser = (email: string): ResultAsync<User, CreateUserError> =>
  validateEmail(email).asyncAndThen(ensureUserDoesNotExistAsync).andThen(insertUserAsync)
```

Use `asyncAndThen` when starting from `Result`, and `andThen` once already inside `ResultAsync`.

## Use safeTry For Linear Control Flow

```ts
const createUser = (email: string): Result<User, CreateUserError> =>
  safeTry(function* () {
    const validEmail = yield* validateEmail(email)
    const user = yield* insertUser(validEmail)

    return ok(user)
  })
```

For async flows:

```ts
const createUser = (email: string): ResultAsync<User, CreateUserError> =>
  safeTry(async function* () {
    const validEmail = yield* validateEmail(email)
    const user = yield* insertUserAsync(validEmail)

    return ok(user)
  })
```

Prefer `yield* result` over `yield* result.safeUnwrap()`.

## Handle Errors At Boundaries

```ts
const toHttpResponse = (result: Result<User, CreateUserError>) =>
  result.matchTags((user) => ({ body: user, statusCode: 201 }), {
    InvalidEmailError: (error) => ({
      body: { code: error._tag, message: error.message },
      statusCode: 400,
    }),
    UserAlreadyExistsError: (error) => ({
      body: { code: error._tag, message: error.message },
      statusCode: 409,
    }),
    DatabaseError: (error) => ({
      body: { code: error._tag, message: error.message },
      statusCode: 500,
    }),
  })
```

This keeps domain code free from transport concerns.

## Recover Tagged Errors Locally

Use `catchTag` when one tagged error can be recovered before a boundary.

```ts
const result = createUser(email).catchTag('InvalidEmailError', (error) =>
  ok({ email: error.email, id: 'draft_user' }),
)
```

Use `catchTags` when a small set of tagged errors share a local recovery path.

```ts
const result = createUser(email).catchTags({
  InvalidEmailError: (error) => ok({ email: error.email, id: 'draft_user' }),
  UserAlreadyExistsError: (error) => ok({ email: error.email, id: 'existing_user' }),
})
```

`catchTags` is already partial: unhandled tags remain in the `Err` side. Do not introduce or
recommend `partialCatchTags`; reserve partial naming for boundary matching with a fallback.

## Pipe Reusable Combinators

Use `pipe` for Result helpers that are clearer as reusable functions than as nested method chains.

```ts
const audit = <T, E>(result: Result<T, E>): Result<T, E> =>
  result.tap((value) => logger.info(value))

const result = createUser(email).pipe(audit, (userResult) => userResult.map((user) => user.id))
```

Do not make `Result` directly iterable for tuple destructuring; `Result` iteration is reserved for `safeTry`.

## Model Lightweight Tagged Domain Variants

Use `TaggedEnum` when a tagged union should be structured but not an `Error`.

```ts
type PaymentState = TaggedEnum<{
  Declined: { readonly code: string }
  Pending: { readonly retryAfterMs: number }
  Settled: { readonly receiptId: string }
}>
```

Use `createTaggedError` instead when the value needs `message`, `cause`, `toJSON`, `.err()`, or
`matchError`.

## Wrap External Promises

```ts
class UpstreamError extends createTaggedError({
  name: 'UpstreamError',
  message: 'Upstream $service failed',
}) {}

const loadProfile = (id: string): ResultAsync<Profile, UpstreamError> =>
  fromPromise(
    client.getProfile(id),
    (cause) => new UpstreamError({ cause, service: 'profile-api' }),
  )
```

Use `tryCatchAsync(() => promiseFactory())` when the factory itself can throw synchronously.

## Add Observability Without Changing Results

```ts
const result = loadProfile(id)
  .tap((profile) => metrics.increment('profile.loaded', { id: profile.id }))
  .tapError((error) => metrics.increment('profile.failed', { tag: error.name }))
  .log((profile, error) => logger.info({ error, profile }, 'profile result'))
  .finally(() => span.end())
```

Use these helpers only for side effects. They intentionally ignore callback failures.

## Test Runtime And Type Behavior

```ts
import { equal, ok as isTrue } from 'node:assert'
import { describe, expectTypeOf, it } from 'vite-plus/test'

describe('validateEmail', () => {
  it('returns typed tagged errors', () => {
    const result = validateEmail('bad')

    isTrue(result.isErr())
    expectTypeOf(result.error).toEqualTypeOf<InvalidEmailError>()
    equal(result.error._tag, 'InvalidEmailError')
  })
})
```

Use `// @ts-expect-error` inside unreachable blocks for negative type tests.
