# Resultar

Typed, composable error handling for TypeScript.

Resultar makes expected failures visible in function signatures instead of hiding them behind
`throw`, rejected promises, nullable values, or undocumented conventions.

```ts
Result<T, E>
ResultAsync<T, E>
ResultTask<T, E, R>
```

- `T` is the success value.
- `E` is the expected failure.
- `R` is the typed service environment still required by a `ResultTask`.
- Callers must handle the result before they can use the value.

Resultar stays focused on explicit values. It does not require a framework, dependency injection
container, scheduler, or application runtime.

## Highlights

| You need | Resultar gives you |
| --- | --- |
| Expected failures in the type system | `Result<T, E>` and `ResultAsync<T, E>` |
| Reusable lazy workflows | `ResultTask<T, E, R>` with explicit execution boundaries and typed services |
| Production errors with useful metadata | Real `Error` subclasses from `createTaggedError` |
| Composable sync and async workflows | `map`, `mapErr`, `andThen`, `asyncAndThen`, and `orElse` |
| Linear code without scattered `try/catch` | `safeTry` with `yield*` short-circuiting |
| Explicit production async policy | Typed timeout, retry, race, concurrency, and cleanup helpers |
| Exhaustive application boundaries | `matchTags` for tagged error unions |
| Guardrails for ignored results | The optional native `resultar-check` CLI |

Resultar began as a fork of `neverthrow`. The current API keeps the familiar explicit Result model
and adds Resultar-specific tagged errors, production async helpers, exhaustive tagged boundaries,
and optional TypeScript-backed diagnostics.

## Contents

- [Install](#install)
- [Why Resultar](#why-resultar)
- [Quick Start](#quick-start)
- [Compose Results](#compose-results)
- [Tagged Errors](#tagged-errors)
- [Async Work](#async-work)
- [Lazy Workflows With ResultTask](#lazy-workflows-with-resulttask)
- [Production Async Policies](#production-async-policies)
- [Linear Workflows With Result.gen](#linear-workflows-with-resultgen)
- [Recover Inside A Workflow](#recover-inside-a-workflow)
- [Handle Results At Boundaries](#handle-results-at-boundaries)
- [Strict Results At Production Boundaries](#strict-results-at-production-boundaries)
- [Prevent Ignored Results](#prevent-ignored-results)
- [HTTP Request Packages](#http-request-packages)
- [API Decision Guide](#api-decision-guide)
- [More Documentation](#more-documentation)

## Install

```sh
pnpm add resultar
```

```sh
npm install resultar
```

Requirements:

- Node.js 24+
- ESM only
- TypeScript 7+ for the canonical `resultar-check` diagnostics workflow

```ts
import { createTaggedError, ok } from 'resultar'
import type { Result } from 'resultar'
```

CommonJS `require('resultar')` is not exported.

## Why Resultar

This signature does not tell callers that parsing can fail:

```ts
const parsePort = (input: string): number => {
  const port = Number(input)

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid port ${input}`)
  }

  return port
}
```

Resultar moves the expected failure into the contract:

```ts
import { createTaggedError, ok } from 'resultar'
import type { Result } from 'resultar'

class InvalidPortError extends createTaggedError({
  name: 'InvalidPortError',
  message: 'Invalid port $input',
}) {}

const parsePort = (input: string): Result<number, InvalidPortError> => {
  const port = Number(input)

  return Number.isInteger(port) && port > 0 ? ok(port) : InvalidPortError.err({ input })
}
```

The caller can now see both outcomes without reading the implementation:

```ts
const port = parsePort(process.env.PORT ?? '3000')

const message = port.match(
  (value) => `Listening on ${value}`,
  (error) => error.message,
)
```

Use `Err` for failures the caller can reasonably handle: invalid input, conflicts, missing records,
rate limits, timeouts, and unavailable dependencies. Keep programming bugs and impossible states as
normal JavaScript throws.

## Quick Start

The examples below build one account-creation workflow.

Start with real tagged errors. Variables in the message template become required constructor props:

```ts
import { createTaggedError, ok } from 'resultar'
import type { Result } from 'resultar'

class InvalidEmailError extends createTaggedError({
  name: 'InvalidEmailError',
  message: 'Invalid email $email',
}) {}

class AccountAlreadyExistsError extends createTaggedError({
  name: 'AccountAlreadyExistsError',
  message: 'Account $email already exists',
}) {}

type Account = {
  readonly email: string
  readonly id: string
}
```

Return `Ok` for success and `Err` for an expected failure:

```ts
const normalizeEmail = (input: string): Result<string, InvalidEmailError> => {
  const email = input.trim().toLowerCase()

  return email.includes('@') ? ok(email) : InvalidEmailError.err({ email })
}

const ensureAccountIsAvailable = (
  email: string,
): Result<string, AccountAlreadyExistsError> =>
  email === 'taken@example.com' ? AccountAlreadyExistsError.err({ email }) : ok(email)

const buildAccount = (email: string): Result<Account, never> =>
  ok({ email, id: 'acct_123' })
```

Compose the steps with `andThen`. The resulting error type is inferred as a union:

```ts
type CreateAccountError = InvalidEmailError | AccountAlreadyExistsError

const createAccount = (input: string): Result<Account, CreateAccountError> =>
  normalizeEmail(input).andThen(ensureAccountIsAvailable).andThen(buildAccount)
```

Inspect a result directly when local branching is clearer:

```ts
const account = createAccount('person@example.com')

if (account.isOk()) {
  account.value.email
}

if (account.isErr()) {
  account.error.message
}
```

Or consume both outcomes with `match`:

```ts
const label = createAccount('person@example.com').match(
  (created) => `Created ${created.id}`,
  (error) => `Could not create account: ${error.message}`,
)
```

## Compose Results

Resultar composition keeps success and failure channels separate.

### Transform success with `map`

```ts
const accountId = createAccount('person@example.com').map((account) => account.id)
```

### Add a fallible condition with `filterOrElse`

```ts
class UnsupportedEmailDomainError extends createTaggedError({
  name: 'UnsupportedEmailDomainError',
  message: 'Email domain $domain is not supported',
}) {}

const requireCompanyEmail = (
  email: string,
): Result<string, InvalidEmailError | UnsupportedEmailDomainError> =>
  normalizeEmail(email).filterOrElse(
    (normalized) => normalized.endsWith('@company.com'),
    (normalized) =>
      new UnsupportedEmailDomainError({ domain: normalized.split('@')[1] ?? 'unknown' }),
  )
```

### Continue with fallible work using `andThen`

```ts
const createCompanyAccount = (input: string) =>
  requireCompanyEmail(input).andThen(ensureAccountIsAvailable).andThen(buildAccount)
```

### Transform a failure with `mapErr`

```ts
class AccountServiceError extends createTaggedError({
  name: 'AccountServiceError',
  message: 'Account service failed for $email',
}) {}

const account = createAccount(input).mapErr(
  (cause) => new AccountServiceError({ cause, email: input }),
)
```

### Recover with `orElse`

```ts
const account = findAccountByEmail(email).orElse(() => createAccount(email))
```

Use `pipe` when a result transform should be named and reused:

```ts
import type { Result } from 'resultar'

const auditAccount = <E>(result: Result<Account, E>): Result<Account, E> =>
  result.tap((account) => logger.info({ accountId: account.id }, 'account ready'))

const accountEmail = createAccount(input)
  .pipe(auditAccount)
  .map((account) => account.email)
```

Callbacks passed to transform methods are normal application code. Resultar does not silently catch
exceptions thrown by `map`, `andThen`, or `pipe` callbacks. Wrap uncontrolled code at the edge
instead.

## Tagged Errors

`createTaggedError` produces real `Error` subclasses with stable tags and structured metadata:

```ts
const error = new AccountAlreadyExistsError({ email: 'person@example.com' })

error instanceof Error // true
error instanceof AccountAlreadyExistsError // true
error._tag // 'AccountAlreadyExistsError'
error.message // 'Account person@example.com already exists'
error.email // string | number
error.fingerprint // stable error fingerprint
error.toJSON() // serializable metadata
```

Tagged errors support:

- `_tag` for exhaustive handling;
- typed message-template props;
- `cause` and stack traces;
- `fingerprint` and `messageTemplate`;
- cycle-safe `.toJSON()` output;
- `.findCause(ErrorClass)` for nested causes;
- static `.is(value)` for nominal checks;
- static `.err(props)` for returning an `Err` directly.

Preserve the original failure as `cause` when translating infrastructure errors:

```ts
class DatabaseError extends createTaggedError({
  name: 'DatabaseError',
  message: 'Database $operation failed',
}) {}

const databaseError = new DatabaseError({
  cause: new Error('connection refused'),
  operation: 'insert-account',
})

databaseError.findCause(Error)
```

Use `redact` when metadata must remain available to authorized code without leaking through error
messages or JSON:

```ts
import { createTaggedError, isRedacted, redact, revealRedacted } from 'resultar'

class TokenRejectedError extends createTaggedError({
  name: 'TokenRejectedError',
  message: 'Token $token was rejected',
}) {}

const error = new TokenRejectedError({
  token: redact('secret-token', 'api-token'),
})

error.message // 'Token <redacted:api-token> was rejected'

if (isRedacted(error.token)) {
  revealRedacted(error.token) // 'secret-token'
}
```

Use `taggedEnum` for lightweight tagged states or nested reasons that do not need to be real
`Error` instances. See the
[tagged enum guide](https://github.com/inaiat/resultar/blob/main/DOCUMENTATION.md#tagged-enums)
for the complete API.

## Async Work

`ResultAsync<T, E>` is the async counterpart to `Result<T, E>`. It is awaitable and exposes the same
composition style.

Map rejections from external code into a documented error type:

```ts
import { tryResultAsync } from 'resultar'
import type { ResultAsync } from 'resultar'

class DatabaseError extends createTaggedError({
  name: 'DatabaseError',
  message: 'Database $operation failed',
}) {}

const persistAccount = (email: string): ResultAsync<Account, DatabaseError> =>
  tryResultAsync(
    () => accountRepository.insert({ email }),
    (cause) => new DatabaseError({ cause, operation: 'insert-account' }),
  )
```

Continue from synchronous validation into async work with `asyncAndThen`:

```ts
type CreateAccountAsyncError =
  | InvalidEmailError
  | AccountAlreadyExistsError
  | DatabaseError

const createAccountAsync = (
  input: string,
): ResultAsync<Account, CreateAccountAsyncError> =>
  normalizeEmail(input).andThen(ensureAccountIsAvailable).asyncAndThen(persistAccount)
```

Once a workflow is already asynchronous, `andThen` accepts callbacks that return either `Result` or
`ResultAsync`:

```ts
const provisioned = createAccountAsync(input)
  .andThen(assignDefaultPlan)
  .andThen(sendWelcomeEmail)
  .map((account) => ({ account, status: 'ready' as const }))
```

Choose the wrapper that matches the external boundary:

| External work | Use |
| --- | --- |
| Run throwing synchronous code now | `tryResult(fn, toError)` |
| Wrap a throwing synchronous function | `fromThrowable(fn, toError)` |
| Adapt an existing promise | `fromPromise(promise, toError)` |
| Run a promise or async factory | `tryResultAsync(factory, toError)` |
| Wrap an async function | `fromThrowableAsync(fn, toError)` |
| Adapt a callback or subscription | `ResultAsync.fromCallback(options)` |

Prefer a factory with `tryResultAsync` when creating the promise can also throw synchronously.

## Lazy Workflows With ResultTask

`ResultTask<T, E, R>` is the lazy workflow primitive in Resultar. Creating one does not start the
work; `runResult`, `runExit`, or `runPromise` executes it explicitly. `R` records the service tags
still required by the workflow, so the execution boundary can require an explicit environment.

Unlike `ResultAsync`, a `ResultTask` is a reusable description of work rather than an already-started
operation. Mapping, chaining, recovery, service provision, and generator composition all remain lazy.

| Need | API |
| --- | --- |
| Create an immediate success or failure | `succeed`, `fail`, `fromResult` |
| Defer synchronous work | `sync`, `try` |
| Defer promise-producing work | `tryPromise` |
| Transform or chain | `map`, `flatMap`, `andThen` |
| Recover typed failures | `catchAll` |
| Write a linear lazy workflow | `gen` with `yield*` |
| Declare and provide dependencies | `service`, `provideService`, `provideServices` |
| Execute at the application boundary | `runExit`, `runResult`, `runPromise` |

```ts
import { ResultTask } from 'resultar'

const loadUser = (id: string) =>
  ResultTask.tryPromise({
    try: (signal) => fetch(`/users/${id}`, { signal }).then((response) => response.json()),
    catch: (cause) => new Error(`Could not load user: ${String(cause)}`),
  })

const task = loadUser('user_123')
const result = await ResultTask.runResult(task)
```

`sync` treats a thrown value as an unexpected defect. Use `try` or `tryPromise` when the boundary is
expected to throw or reject and should map that cause into `E`. `tryPromise` receives the execution
`AbortSignal`, so callers can cancel cooperative work without starting it early.

Choose the execution boundary based on how much information the application needs:

| Boundary | Result |
| --- | --- |
| `runExit(task)` | `Exit<T, E>` preserving `Success`, typed `Fail`, and unexpected `Die` causes |
| `runResult(task)` | `Result<T, E>`; a `Die` rejects instead of entering the typed error channel |
| `runPromise(task)` | `T`; typed failures and defects reject for integration with Promise-only APIs |

```ts
const controller = new AbortController()
const exit = await ResultTask.runExit(loadUser('user_123'), {
  signal: controller.signal,
})

if (exit._tag === 'Failure' && exit.cause._tag === 'Die') {
  console.error('Unexpected defect', exit.cause.defect)
}
```

Instance methods and their static functional forms preserve laziness and infer combined error and
environment types:

```ts
const userName = loadUser('user_123')
  .map((user) => String(user.name))
  .andThen((name) => ResultTask.succeed(name.trim()))
  .catchAll((error) => ResultTask.succeed(`unavailable: ${error.message}`))
```

`catchAll` recovers only typed failures. Runtime defects remain defects and are visible through
`runExit`. The equivalent functional forms are `ResultTask.map`, `ResultTask.flatMap`, and
`ResultTask.catchAll`.

Workflows can request typed services with `yield*` and receive them at the boundary. Pass the service
type and its literal identifier so the named environment remains checked:

```ts
const Database = ResultTask.service<
  { findUser: (id: string) => Promise<string> },
  'Database'
>('Database')

const taskWithDatabase = ResultTask.gen(function* () {
  const database = yield* Database
  return yield* ResultTask.tryPromise({
    try: () => database.findUser('user_123'),
    catch: () => 'database-error' as const,
  })
})

const resultWithDatabase = await ResultTask.runResult(taskWithDatabase, {
  services: { Database: { findUser: async () => 'Ada' } },
})
```

The environment requirement is part of the task type. A missing or misspelled `Database` property is
a compile-time error at `runResult`, `runExit`, or `runPromise`. Dependencies can also be bound before
the final boundary:

```ts
const database = { findUser: async () => 'Ada' }

const readyWithOne = ResultTask.provideService(taskWithDatabase, Database, database)
const readyWithAll = ResultTask.provideServices(taskWithDatabase, { Database: database })

await ResultTask.runResult(readyWithOne)
await ResultTask.runResult(readyWithAll)
```

`ResultTask.gen` composes tasks and services linearly. On short-circuit, generator `finally` blocks
are closed and any yielded cleanup tasks or services are interpreted before execution completes:

```ts
const program = ResultTask.gen(function* () {
  try {
    return yield* loadUser('user_123')
  } finally {
    yield* ResultTask.sync(() => logger.info('load-user finished'))
  }
})
```

If cleanup itself fails or defects, that cleanup exit becomes the final exit. ResultTask 3.6 keeps
execution deliberately small: it provides laziness, typed services, cooperative cancellation, and
explicit exits, but does not yet include a scheduler, scopes, or `Fiber` runtime.

## Production Async Policies

Resultar models common resilience policy in the expected error channel. These helpers use lazy tasks
so retries can start fresh work and racing helpers can pass a cooperative abort signal.

### Timeout stays typed

```ts
class AccountTimeoutError extends createTaggedError({
  name: 'AccountTimeoutError',
  message: 'Account $accountId timed out after $timeoutMs milliseconds',
}) {}

const account = ResultAsync.timeout(
  (signal) => loadAccount(accountId, { signal }),
  {
    timeoutMs: 1_500,
    onTimeout: () => new AccountTimeoutError({ accountId, timeoutMs: 1_500 }),
  },
)
```

If the timer wins, the timeout is returned as `Err<AccountTimeoutError>` and the task receives an
abort signal. No rejected timeout promise is introduced.

### Retry transient failures

```ts
const account = ResultAsync.retry(
  (attempt, signal) => loadAccount(accountId, { attempt, signal }),
  {
    times: 2,
    delayMs: ({ nextAttempt }) => nextAttempt * 100,
    jittered: 0.2,
    while: (error) => error._tag === 'DatabaseBusyError',
  },
)
```

`times` is the number of retries after the first attempt. Use `retryOrElse` when retry exhaustion
should continue into an explicit fallback:

```ts
const account = ResultAsync.retryOrElse(
  (attempt, signal) => loadAccount(accountId, { attempt, signal }),
  {
    times: 2,
    orElse: () => loadCachedAccount(accountId),
  },
)
```

### Race equivalent providers

```ts
const account = ResultAsync.race(
  (signal) => loadAccountFromPrimary(accountId, { signal }),
  (signal) => loadAccountFromReplica(accountId, { signal }),
)
```

`race` returns the first success and keeps waiting after an early failure. Use `raceFirst` when the
first completed success or failure should win, or `raceAll` for several equivalent providers.

### Bound concurrent work

```ts
const imported = ResultAsync.forEach(
  accountInputs,
  (input) => createAccountAsync(input.email),
  { concurrency: 8, discard: true },
)
```

`forEach` is sequential by default and stops scheduling new work after the first `Err`. Pass a
positive concurrency number for bounded work or `"unbounded"` to start every mapped task.

Use mapped `validateAll` when every independent item should run and all failures should be returned:

```ts
const validated = ResultAsync.validateAll(
  accountInputs,
  (input) => normalizeEmail(input.email).asyncMap(async (email) => email),
  { concurrency: 8 },
)
```

### Pair acquisition with cleanup

```ts
const account = ResultAsync.withResource({
  acquire: (signal) => databasePool.connect({ signal }),
  use: (connection, signal) => connection.insertAccount(input, { signal }),
  release: (connection) => connection.close(),
})
```

After successful acquisition, `release` runs when `use` succeeds, returns `Err`, or rejects. For
stream-shaped work, use native `AsyncIterable<Result<T, E>>`; Resultar intentionally does not add a
stream runtime or scheduler.

See the full guides for
[racing and timeout](https://github.com/inaiat/resultar/blob/main/DOCUMENTATION.md#concurrent-racing-and-timeouts),
[retry](https://github.com/inaiat/resultar/blob/main/DOCUMENTATION.md#retrying-async-work),
[concurrency](https://github.com/inaiat/resultar/blob/main/DOCUMENTATION.md#async-concurrency-mapping),
and [resource cleanup](https://github.com/inaiat/resultar/blob/main/DOCUMENTATION.md#resourceful-async-iterables).

## Linear Workflows With `Result.gen`

Use `Result.gen` when a longer chain reads better as linear code. `yield*` extracts the `Ok` value and
short-circuits on the first `Err`. `safeTry` remains an exact compatibility alias.

```ts
import { Result } from 'resultar'
import type { ResultAsync } from 'resultar'

const createAccountLinear = (
  input: string,
): ResultAsync<Account, CreateAccountAsyncError> =>
  Result.gen(async function* () {
    const email = yield* normalizeEmail(input)
    yield* ensureAccountIsAvailable(email)

    return persistAccount(email)
  })
```

The object form can map unexpected throws from inside the generator while leaving yielded `Err`
values unchanged:

```ts
const account = Result.gen({
  async *try() {
    const email = yield* normalizeEmail(input)
    return persistAccount(email)
  },
  catch: (cause) => new AccountServiceError({ cause, email: input }),
})
```

Prefer `yield* result`. Compatibility helpers such as `safeUnwrap` are not needed in new workflows.

## Recover Inside A Workflow

Use recovery methods when a failure has a useful local alternative.

Recover from one tagged error with `catchTag`:

```ts
const account = createAccountAsync(input).catchTag(
  'AccountAlreadyExistsError',
  (error) => findAccountByEmail(String(error.email)),
)
```

Recover several tagged errors with `catchTags`:

```ts
const account = createAccountAsync(input).catchTags({
  AccountAlreadyExistsError: (error) => findAccountByEmail(String(error.email)),
  InvalidEmailError: (error) =>
    ok({ email: String(error.email), id: 'draft_account' }),
})
```

Unhandled tags remain in the error channel. Use `mapErr` when the failure should be translated and
`orElse` when recovery should run another Result-producing branch.

```ts
const account = loadCachedAccount(accountId)
  .orElse(() => loadAccount(accountId))
  .mapErr((cause) => new AccountServiceError({ cause, email: input }))
```

Use recovery inside a workflow. At an application boundary, consume the final result with `match`,
`matchTags`, or `matchTagsPartial`.

## Handle Results At Boundaries

Boundary code turns a Result into an HTTP response, queue acknowledgement, CLI exit code, log entry,
or UI state.

Use `matchTags` when tagged errors should be handled exhaustively:

```ts
const response = await createAccountAsync(input).matchTags(
  (account) => ({
    body: account,
    statusCode: 201,
  }),
  {
    AccountAlreadyExistsError: (error) => ({
      body: { code: error._tag, message: error.message },
      statusCode: 409,
    }),
    DatabaseError: (error) => ({
      body: { code: error._tag, message: error.message },
      statusCode: 503,
    }),
    InvalidEmailError: (error) => ({
      body: { code: error._tag, message: error.message },
      statusCode: 400,
    }),
  },
)
```

If a handler is missing, TypeScript reports it. If only selected errors need special handling, use
`matchTagsPartial` with a fallback. Use plain `match` when the distinction between individual error
tags does not matter.

Avoid unwrapping in normal application flows. `unwrapOr`, `unwrapOrThrow`, `_unsafeUnwrap`, and
`_unsafeUnwrapErr` are best reserved for deliberate final boundaries or tests.

## Strict Results At Production Boundaries

`Result<T, E>` intentionally allows any failure type. Strings, enums, and small objects can be useful
inside narrow local workflows.

For service, HTTP, job, queue, CLI, and integration boundaries, prefer the Error-only aliases:

```ts
import type { StrictResult, StrictResultAsync } from 'resultar'

const validateAccount = (
  input: string,
): StrictResult<string, InvalidEmailError> => normalizeEmail(input)

const provisionAccount = (
  input: string,
): StrictResultAsync<Account, CreateAccountAsyncError> => createAccountAsync(input)
```

`StrictResult<T, E extends Error>` and `StrictResultAsync<T, E extends Error>` are type-only aliases.
They keep the same Resultar API while documenting that failures carry standard `Error` behavior:
messages, causes, stack traces, and structured metadata.

## Prevent Ignored Results

Result values are useful only when callers handle them. Install the native `resultar-check` CLI:

```sh
pnpm add -D resultar-check
```

Use the CLI as the authoritative local and CI check:

```json
{
  "scripts": {
    "check": "resultar-check"
  }
}
```

The CLI uses TypeScript-Go to run compiler and Resultar diagnostics over the same `tsconfig.json`.
Configure its rules in the project file:

```json
{
  "$schema": "./node_modules/resultar-check/schema.json",
  "compilerOptions": {
    "plugins": [
      {
        "name": "resultar-check",
        "noDiscard": "error"
      }
    ]
  }
}
```

The `plugins` entry is configuration consumed by the native CLI and stdio LSP server; it does not
install an editor extension. Run `resultar-check lsp` from an editor language-server configuration.
A separate TypeScript installation is not required.

See the
[`resultar-check` guide](https://github.com/inaiat/resultar/blob/main/packages/check/README.md)
for all diagnostics, severities, modes, and ignore patterns.

## HTTP Request Packages

Resultar's Fetch-first request packages return `ResultAsync` values for request creation, network,
HTTP status, JSON parsing, validation, and retry failures.

| Package | Use it when | Guide |
| --- | --- | --- |
| [`resultar-request`](https://www.npmjs.com/package/resultar-request) | You use a custom validator or decoder | [README](https://github.com/inaiat/resultar/blob/main/packages/request/README.md) |
| [`resultar-request-typebox`](https://www.npmjs.com/package/resultar-request-typebox) | Your response contract is a TypeBox schema | [README](https://github.com/inaiat/resultar/blob/main/packages/request-typebox/README.md) |
| [`resultar-request-zod`](https://www.npmjs.com/package/resultar-request-zod) | Your response contract is a Zod schema or transform | [README](https://github.com/inaiat/resultar/blob/main/packages/request-zod/README.md) |

The adapters delegate transport, JSON parsing, retries, and error mapping to `resultar-request` and
re-export its public request types. Install only the core request package and schema adapter your
service needs.

## API Decision Guide

| Need | Use |
| --- | --- |
| Create success or failure | `ok`, `err`, `okAsync`, `errAsync` |
| Create an `Ok(undefined)` | `unit`, `unitAsync` |
| Transform success | `map`, `asyncMap`, `as` |
| Add a fallible condition | `filterOrElse` |
| Transform failure | `mapErr` |
| Continue fallible work | `andThen`, `asyncAndThen` |
| Recover from failure | `orElse`, `catchTag`, `catchTags` |
| Wrap throwing or rejecting code | `tryResult`, `tryResultAsync`, `fromPromise` |
| Write linear Result code | `Result.gen` (`safeTry` compatibility alias) |
| Describe reusable lazy work | `ResultTask.succeed`, `sync`, `try`, `tryPromise` |
| Compose or recover lazy work | `ResultTask.map`, `flatMap`, `andThen`, `catchAll`, `gen` |
| Require or bind typed services | `ResultTask.service`, `provideService`, `provideServices` |
| Execute lazy work explicitly | `ResultTask.runExit`, `runResult`, `runPromise` |
| Handle a final boundary | `match`, `matchTags`, `matchTagsPartial` |
| Combine independent results | `zip`, `combine`, `combineWithAllErrors` |
| Try ordered fallback candidates | `firstSuccessOf` |
| Process async collections | `ResultAsync.forEach`, `ResultAsync.validateAll` |
| Race concurrent tasks | `ResultAsync.race`, `raceAll`, `raceFirst` |
| Apply a timeout | `ResultAsync.timeout` |
| Retry transient work | `ResultAsync.retry`, `retryOrElse` |
| Pair acquisition and cleanup | `ResultAsync.withResource` |
| Observe without changing the result | `tap`, `tapError`, `log` |
| Default deliberately at an edge | `unwrapOr` |
| Throw deliberately at an edge | `unwrapOrThrow` |

The
[complete API map](https://github.com/inaiat/resultar/blob/main/DOCUMENTATION.md#api-map)
covers overloads, aliases, callback semantics, collection helpers, conditional helpers, tagged
reasons, disposable results, and compatibility APIs.

## More Documentation

- [Full Resultar guide](https://github.com/inaiat/resultar/blob/main/DOCUMENTATION.md)
- [ResultTask core RFC](https://github.com/inaiat/resultar/blob/main/packages/resultar/RESULT-TASK-CORE-RFC.md)
- [Runnable core cookbook](https://github.com/inaiat/resultar/tree/main/examples/resultar)
- [Catching and recovering errors](https://github.com/inaiat/resultar/blob/main/DOCUMENTATION.md#catching-and-recovering-errors)
- [Safe Try](https://github.com/inaiat/resultar/blob/main/DOCUMENTATION.md#safe-try)
- [Validation error recipes](https://github.com/inaiat/resultar/blob/main/DOCUMENTATION.md#validation-error-recipes)
- [Coming from other error-handling styles](https://github.com/inaiat/resultar/blob/main/DOCUMENTATION.md#coming-from-other-styles)
- [Public exports and compatibility aliases](https://github.com/inaiat/resultar/blob/main/DOCUMENTATION.md#public-entry-point)
- [Type-safe error handling article](https://github.com/inaiat/resultar/blob/main/articles/en/type-safe.md)
- [Artigo sobre tratamento de erros type-safe](https://github.com/inaiat/resultar/blob/main/articles/pt/type-safe.md)

Resultar is also published on [JSR as `@inaiat/resultar`](https://jsr.io/@inaiat/resultar).

## License

MIT
