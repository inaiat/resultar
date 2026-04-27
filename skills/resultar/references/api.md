# Resultar API Reference For AI Agents

Use this reference when writing or reviewing code that consumes Resultar.

## Package Shape

Resultar is ESM-only and targets Node.js 24+.

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
  tryCatch,
  tryCatchAsync,
  unit,
  unitAsync,
} from 'resultar'
```

Use type-only imports for exported types:

```ts
import type {
  TaggedEnum,
  TaggedErrorClass,
  TaggedErrorInstance,
  TaggedErrorOptions,
} from 'resultar'
```

## Result<T, E>

`Result<T, E>` is the sync fallible value type.

Constructors:

- `ok(value)` -> `Result<T, never>`
- `err(error)` -> `Result<never, E>`
- `unit()` -> `Result<undefined, never>`
- `tryCatch(fn, errorFn?)` -> catches synchronous throws
- `fromThrowable(fn, errorFn?)` -> wraps a throwing function

Methods:

- `isOk()` narrows to `Result<T, never>`.
- `isErr()` narrows to `Result<never, E>`.
- `map(fn)` transforms only the `Ok` value.
- `mapErr(fn)` transforms only the `Err` value.
- `filterOrElse(predicate, onFalse)` keeps `Ok` values that pass and converts failures to `Err`.
- `andThen(fn)` chains a function returning `Result`.
- `asyncAndThen(fn)` chains a function returning `ResultAsync`.
- `orElse(fn)` recovers from an error with another `Result`.
- `catchTag(tag, fn)` recovers from one tagged error variant.
- `catchTags(handlers)` partially recovers from multiple tagged error variants; unhandled tags stay
  in the `Err` side.
- `match(okFn, errFn)` returns the output of the matching handler.
- `matchTags(okFn, handlers)` matches `Ok` and tagged `Error` variants without nesting `matchError`.
- `pipe(fn, ...)` applies reusable combinators to the current `Result`.
- `unwrapOr(defaultValue)` returns the value or default.
- `unwrapOrThrow()` returns the value or throws the error.
- `_unsafeUnwrap()` and `_unsafeUnwrapErr()` are for tests.
- `safeUnwrap()` is legacy support for `safeTry`; prefer `yield* result`.

Static methods:

- `Result.ok(value)`
- `Result.err(error)`
- `Result.unit()`
- `Result.tryCatch(fn, errorFn?)`
- `Result.fromThrowable(fn, errorFn?)`
- `Result.combine(results)` short-circuits at the first error.
- `Result.combineWithAllErrors(results)` collects all errors.

## ResultAsync<T, E>

`ResultAsync<T, E>` wraps `Promise<Result<T, E>>` and is thenable.

Constructors:

- `okAsync(value)` -> successful async result
- `errAsync(error)` -> failed async result
- `unitAsync()` -> successful async result with `undefined`
- `fromPromise(promise, errorFn)` -> maps rejections into `Err`
- `fromSafePromise(promise)` -> wraps a promise expected not to reject
- `tryCatchAsync(promiseOrFactory, errorFn?)` -> catches rejections and sync throws from factories
- `fromThrowableAsync(fn, errorFn?)` -> wraps an async throwing function

Methods mirror `Result` where useful:

- `map(fn)`
- `mapErr(fn)`
- `andThen(fn)` accepts functions returning `Result` or `ResultAsync`.
- `orElse(fn)` accepts recovery functions returning `Result` or `ResultAsync`.
- `match(okFn, errFn)` resolves to the handler output.
- `matchTags(okFn, handlers)` resolves to direct tagged-error boundary handling.
- `unwrapOr(defaultValue)` resolves to value or default.
- `unwrapOrThrow()` resolves to value or throws the error.
- `safeUnwrap()` is legacy support for `safeTry`; prefer `yield* resultAsync`.

Static methods:

- `ResultAsync.combine(results)` short-circuits at the first error after all promises settle.
- `ResultAsync.combineWithAllErrors(results)` collects all errors after all promises settle.

## Tagged Errors

`createTaggedError` creates a real `Error` subclass with stable metadata.

```ts
class PaymentDeclinedError extends createTaggedError({
  name: 'PaymentDeclinedError',
  message: 'Payment $paymentId was declined by $provider',
}) {}
```

Instances expose:

- `_tag`
- `message`
- `messageTemplate`
- `fingerprint`
- typed props inferred from `$variables`
- `cause`
- `toJSON()`
- `findCause(ErrorClass)`

Static members:

- `ErrorClass.tag`
- `ErrorClass.is(value)`, a nominal `instanceof`-based guard
- `ErrorClass.err(props)`

Reserved template variables are rejected because they conflict with `Error` or tagged-error
metadata: `_tag`, `name`, `message`, `messageTemplate`, `fingerprint`, `stack`, and `cause`.

Use `.err(props)` when returning the error side of a result:

```ts
const decline = (paymentId: string) => PaymentDeclinedError.err({ paymentId, provider: 'stripe' })
```

Use `TaggedEnum<Members>` for lightweight non-Error variants:

```ts
type PaymentError = TaggedEnum<{
  CardDeclined: { readonly code: string }
  InsufficientFunds: { readonly balance: number }
}>
```

## Matching Tagged Errors

Use `matchError(error, handlers)` when all tagged errors in a union must be handled.

```ts
const response = matchError(error, {
  InvalidEmailError: (error) => ({ statusCode: 400, body: error.toJSON() }),
  UserAlreadyExistsError: (error) => ({ statusCode: 409, body: error.toJSON() }),
  DatabaseError: (error) => ({ statusCode: 500, body: error.toJSON() }),
})
```

When plain or untagged `Error` is part of the union, include an `Error` handler:

```ts
const message = matchError(error, {
  DatabaseError: (error) => error.message,
  Error: (error) => error.message,
  InvalidEmailError: (error) => error.message,
})
```

Use `matchErrorPartial(error, handlers, fallback)` when only selected errors need custom handling.

Do not add `partialCatchTags`; `catchTags` already has partial recovery semantics. If a partial
boundary API is needed, prefer `matchTagsPartial(okHandler, handlers, fallback)`.

## Side Effects

`tap`, `tapError`, `log`, and `finally` are observation helpers, not transform helpers.

- They preserve the original `Result` or `ResultAsync`.
- Callback errors are intentionally ignored.
- Use them for metrics, logging, tracing, and cleanup.
- Use `map`, `mapErr`, `andThen`, `orElse`, or `tryCatch` for fallible work that should affect the result.

## Current Preferred Style

Prefer this:

```ts
const result = validateInput(input)
  .andThen(saveInput)
  .tap((saved) => logger.info({ id: saved.id }, 'saved input'))
  .tapError((error) => logger.error({ error }, 'failed to save input'))
```

Avoid this for expected failures:

```ts
try {
  return await saveInputOrThrow(input)
} catch (error) {
  return error
}
```
