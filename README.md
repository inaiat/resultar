# Resultar

Production-facing error handling for TypeScript, without a runtime.

Resultar gives you typed `Result` primitives, real `Error`-based tagged failures, sync/async
composition, and optional no-discard diagnostics. It is small enough to adopt in one module and
strict enough to use at service, HTTP, job, queue, CLI, and integration boundaries.

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
- Sync and async fallible work compose without `try/catch` blocks scattered through application
  code.
- Ignored `Result` values can be reported by a type-aware no-discard check.

Resultar began as an initial fork of `neverthrow`. The v3 alpha line keeps the explicit wrapper
model, then leans into Resultar-specific tagged errors, strict service-boundary types, TypeScript 6
support, and ESM-only packaging.

## Install

```sh
pnpm add resultar
```

```sh
npm install resultar
```

## Requirements

- Node.js 24+
- TypeScript 6+
- ESM only

```ts
import { createTaggedError, ok } from 'resultar'
import type { StrictResult } from 'resultar'
```

CommonJS `require('resultar')` is not exported.

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
| Boundary handlers miss cases | `matchTags` for exhaustive tagged-error handling |
| Results are easy to ignore | `resultar-no-discard` and the `resultar-ls` TypeScript plugin |
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
import type { TaggedEnum } from 'resultar'

type PaymentError = TaggedEnum<{
  CardDeclined: { readonly code: string }
  InsufficientFunds: { readonly balance: number }
}>
```

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

| Effect fallback idea | Resultar equivalent |
| --- | --- |
| try another effect | `result.orElse(() => fallbackResult)` |
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

Use `catchTag` / `catchTags` when recovery depends on a specific tagged error. Use
`matchTagsPartial` when only a boundary needs fallback mapping. Use `unwrapOr` only at final edges
where defaulting is intentional.

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

Resultar values should not be ignored. Install `resultar-ls` to report discarded `Result` and
`ResultAsync` values.

```sh
pnpm add -D resultar-ls typescript
```

Add a lint-like script:

```json
{
  "scripts": {
    "lint:resultar": "resultar-no-discard --project tsconfig.json"
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

For editor diagnostics, enable the TypeScript language-service plugin:

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "resultar-ls", "noDiscard": "error" }]
  }
}
```

TypeScript language-service plugins are editor-only by default. To make `tsc` report Resultar
diagnostics during builds, patch the local TypeScript installation:

```sh
pnpm exec resultar-ls patch
pnpm exec resultar-ls check
pnpm exec resultar-ls unpatch
```

For Oxlint or Vite+ projects, load the `resultar-ls/oxlint` JS plugin and enable
`resultar/no-discard`:

```ts
import { defineConfig } from 'vite-plus'

export default defineConfig({
  lint: {
    jsPlugins: [{ name: 'resultar', specifier: 'resultar-ls/oxlint' }],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      'resultar/no-discard': 'error',
    },
  },
})
```

For TypeScript 7 native-preview projects, `resultar-tsgo` exposes a `tsgo` wrapper that runs native
TypeScript and then Resultar no-discard validation.

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
| Replace failure with another failure | `mapErr` or `orElse(() => err(newError))` |
| Replace failure with success | `orElse(() => ok(defaultValue))` |
| Handle a boundary | `match`, `matchTags`, or `matchTagsPartial` |
| Write linear result code | `safeTry` |
| Combine two independent results | `Result.zip` or `ResultAsync.zip` |
| Combine many independent results | `Result.combine` or `ResultAsync.combine` |
| Collect all validation failures | `validateAll` or `combineWithAllErrors` |
| Try fallback candidates | `firstSuccessOf` |
| Process collections sequentially | `loop`, `iterate`, or `forEach` |
| Observe without changing outcome | `tap`, `tapError`, or `log` |
| Throw intentionally at a final edge | `unwrapOrThrow()` |
| Default intentionally at a final edge | `unwrapOr(defaultValue)` |

## Version 3 Alpha Notes

`3.0.0-alpha.1` is a semver-major prerelease:

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

This README is the project entry point. For a full guide with larger examples and the complete API
map, see [DOCUMENTATION.md](DOCUMENTATION.md).

More focused material:

- [Type-safe error handling article, English](articles/en/type-safe.md)
- [Artigo sobre tratamento de erros type-safe, Portuguese](articles/pt/type-safe.md)
- [resultar-ls package guide](packages/resultar-ls/README.md)
- [resultar-tsgo package guide](packages/resultar-tsgo/README.md)

## Workspace

This repository is a pnpm workspace:

- `packages/resultar`: Resultar runtime package.
- `packages/resultar-ls`: TypeScript language-service diagnostics and no-discard CLI.
- `packages/resultar-tsgo`: TypeScript 7 native-preview `tsgo` wrapper plus Resultar no-discard
  validation.
- `benchmarks`: benchmark package.
- `examples/language-service`: TypeScript 6 no-discard smoke example.
- `examples/vite-plus`: Vite+ `vp check` smoke example through Oxlint `jsPlugins`.
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
