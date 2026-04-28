---
name: resultar
description: Use this skill whenever the user is writing, reviewing, migrating, or documenting TypeScript code that uses Resultar, Result<T, E>, ResultAsync<T, E>, createTaggedError, matchError, safeTry, or typed error handling. Trigger for questions about replacing thrown exceptions, modeling domain errors, composing sync/async fallible operations, using tagged errors with Result, improving Resultar API docs, or adding tests for Resultar-style flows, even if the user only says "result", "typed errors", "safe try", or "err/ok".
---

# Resultar

Resultar is an ESM-only TypeScript library for explicit error handling:

```ts
Result<T, E>
ResultAsync<T, E>
StrictResult<T, E extends Error>
StrictResultAsync<T, E extends Error>
```

Resultar began as an initial fork of `neverthrow`, but v2 should be treated as its own API direction:
explicit wrappers, tagged errors, strict service-boundary aliases, and ESM-only packaging.

Use this skill to produce Resultar-native code, examples, reviews, tests, and documentation. Favor the library's public API over ad hoc unions, thrown exceptions, or nullable returns.

## First Steps

1. Check the user's installed or local Resultar version when the repository is available.
2. Prefer local source and README over memory:
   - `src/index.ts` for exported API
   - `src/result.ts` for `Result`
   - `src/result-async.ts` for `ResultAsync`
   - `src/tagged-error.ts` for tagged errors
   - `README.md` for current examples
3. If the task is about a different project consuming Resultar, inspect its package version and import style before writing code.

## Core Model

- Use `Result<T, E>` for synchronous fallible work.
- Use `ResultAsync<T, E>` for promise-based fallible work.
- Prefer `StrictResult<T, E extends Error>` and `StrictResultAsync<T, E extends Error>` at
  application and backend service boundaries.
- Use `ok(value)` and `err(error)` to construct plain results.
- Use tagged errors when `E` should be a real typed `Error` subclass with stable metadata.
- Prefer `createTaggedError` for expected domain/application failures. Keep strings, enums, and
  lightweight objects for narrow local flows only.
- Match plain results at boundaries with `result.match(okHandler, errHandler)`.
- Match tagged-error results at boundaries with `result.matchTags(okHandler, handlers)`.
- Do not throw for expected domain failures; return `Err`.
- Do not return `T | Error` as the main model unless the user explicitly wants that style.

## Result Guidelines

For sync workflows:

```ts
import type { StrictResult } from 'resultar'

import { createTaggedError, ok } from 'resultar'

class InvalidPortError extends createTaggedError({
  name: 'InvalidPortError',
  message: 'Invalid port $value',
}) {}

const parsePort = (value: string): StrictResult<number, InvalidPortError> => {
  const port = Number(value)

  return Number.isInteger(port) && port > 0 ? ok(port) : InvalidPortError.err({ value })
}
```

Use:

- `map(fn)` for infallible value transforms.
- `mapErr(fn)` for error transforms.
- `filterOrElse(predicate, onFalse)` for validating an `Ok` value without writing `andThen` boilerplate.
- `andThen(fn)` for fallible sync composition.
- `asyncAndThen(fn)` when a sync result needs to continue into `ResultAsync`.
- `orElse(fn)` for recovery.
- `catchTag(tag, fn)` for recovering one tagged error variant.
- `catchTags(handlers)` for partial recovery of multiple tagged error variants; unhandled tags stay
  in the `Err` side.
- `match(okFn, errFn)` at external boundaries.
- `isOk()` / `isErr()` for type narrowing.
- `pipe(fn, ...)` for reusable Result combinators.

## ResultAsync Guidelines

Wrap promises with:

```ts
fromPromise(promise, toError)
fromSafePromise(promise)
tryCatchAsync(promiseOrFactory, toError?)
fromThrowableAsync(fn, toError?)
```

Use `ResultAsync` methods for composition instead of `await` plus manual branching unless the code is clearer at a boundary.

```ts
const user = fetchUser(id)
  .andThen(validateUser)
  .map((user) => user.email)
  .mapErr((cause) => new Error('Could not load user email', { cause }))
```

`tryCatchAsync(() => promise)` catches both promise rejections and synchronous throws from the factory.

## Tagged Error Guidelines

Use `createTaggedError` when errors need a stable tag, typed metadata, JSON serialization, cause-chain lookup, or exhaustive matching.

```ts
import { createTaggedError } from 'resultar'

class InvalidEmailError extends createTaggedError({
  name: 'InvalidEmailError',
  message: 'Invalid email $email',
}) {}
```

Template variables like `$email` become required constructor props. A static `.err(props)` helper returns `Result<never, ErrorClass>`.

```ts
const validateEmail = (email: string) =>
  email.includes('@') ? ok(email) : InvalidEmailError.err({ email })
```

Reserved template variables are rejected: `_tag`, `name`, `message`, `messageTemplate`,
`fingerprint`, `stack`, and `cause`. Static `.is(value)` is nominal and requires an actual instance
of the generated error class.

At `Result` boundaries, use `result.matchTags(okHandler, handlers)` for exhaustive handling of
tagged-error unions. Add an `Error` handler when plain or untagged `Error` is part of the union. Use
standalone `matchError` when you only have an error value, and `matchErrorPartial` only when a
fallback is intentional.

Do not propose `partialCatchTags`: `catchTags` is already partial recovery. If the user needs partial
boundary mapping, use `matchTagsPartial(okHandler, handlers, fallback)`.

Use `TaggedEnum<Members>` for lightweight tagged domain unions that do not need to extend `Error`.
Prefer `createTaggedError` when the value should be throwable, carry `cause`, serialize like an
error, or compose through `matchError`.

## safeTry Guidelines

Use `safeTry` for linear workflows where nested `andThen` chains would be harder to read.

```ts
const createUser = (email: string) =>
  safeTry(function* () {
    const validEmail = yield* validateEmail(email)
    const user = yield* insertUser(validEmail)

    return ok(user)
  })
```

For async generators, `yield*` works with both `Result` and `ResultAsync`.

```ts
const saveUser = (email: string) =>
  safeTry(async function* () {
    const validEmail = yield* validateEmail(email)
    const user = yield* insertUserAsync(validEmail)

    return ok(user)
  })
```

Prefer `yield* result` and `yield* resultAsync`. `Result.safeUnwrap()` exists for compatibility but is not usually needed.

## Side Effects

Use side-effect methods only for observation and cleanup:

- `tap(fn)` runs only for `Ok` and preserves the result.
- `tapError(fn)` runs only for `Err` and preserves the result.
- `log(fn)` runs for both states as `(value, error)` and preserves the result.
- `toDisposable(fn)` and `toAsyncDisposable(fn)` create Node.js 24 disposable wrappers for `using`
  and `await using`.

Callback errors are intentionally ignored, including disposable cleanup callbacks. If callback failure
should affect control flow, use `andThen`, `orElse`, or `tryCatch`.

## Testing Guidance

Use `vite-plus/test` in this repository.

- Use runtime assertions for `Ok`/`Err` behavior.
- Use `expectTypeOf` for type narrowing and inferred tagged-error props.
- Use `// @ts-expect-error` for intentional compile-time failures.
- Prefer checking public behavior over private internals.

## References

Read these only when needed:

- `references/api.md` for API details and method semantics.
- `references/patterns.md` for copyable recipes.
- `references/review-checklist.md` for code review and migration checks.
