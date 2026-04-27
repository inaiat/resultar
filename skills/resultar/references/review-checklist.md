# Resultar Review Checklist

Use this checklist when reviewing code that uses Resultar or when migrating thrown-error code to Resultar.

## API Fit

- Expected domain failures return `Result` or `ResultAsync`.
- Unexpected programmer errors may still throw.
- Sync functions do not return `ResultAsync` unless they call async work.
- Async functions do not return raw `Promise<T>` when failure is expected and typed.
- Tagged errors are used when errors need stable `_tag`, metadata, JSON output, or exhaustive matching.

## Type Quality

- Error unions are specific and not widened to `Error` too early.
- `isOk()` and `isErr()` are used for narrowing when direct branching is clearer than `match`.
- `matchTags` is used at `Result` boundaries with tagged-error unions.
- `matchError` handlers cover every tagged error in the union when only an error value is available.
- `matchTags` / `matchError` include an `Error` handler when plain or untagged `Error` is possible.
- `matchErrorPartial` has a deliberate fallback.
- `.err(props)` on tagged errors returns `Result<never, ErrorClass>` and composes naturally.
- Tagged error templates do not use reserved variables: `_tag`, `name`, `message`,
  `messageTemplate`, `fingerprint`, `stack`, or `cause`.
- `TaggedEnum` is used only for non-Error tagged variants; use `createTaggedError` for actual errors.

## Composition

- `map` is used only for infallible value transforms.
- `mapErr` is used only for error transforms.
- `filterOrElse` is used for predicate validation that preserves the value.
- `andThen` is used for fallible composition.
- `asyncAndThen` bridges `Result` into `ResultAsync`.
- `catchTag` / `catchTags` are used for local tagged-error recovery.
- `partialCatchTags` is not introduced; `catchTags` already leaves unhandled tags untouched.
- `pipe` is used only when reusable combinators improve clarity.
- `safeTry` is used for linear workflows where chains are harder to read.
- `yield* result` and `yield* resultAsync` are preferred over `safeUnwrap()`.

## Boundaries

- Transport code converts `Result` into HTTP responses, CLI output, jobs, or logs.
- Domain code does not know HTTP status codes unless that is actually the domain.
- External promise APIs are wrapped with `fromPromise` or `tryCatchAsync`.
- Throwing third-party calls are wrapped with `tryCatch` or `fromThrowable`.

## Observability

- `tap`, `tapError`, `log`, and `finally` are used only for observation and cleanup.
- Callback failures in side-effect helpers are not expected to alter control flow.
- Fallible side effects that matter are modeled with `andThen`, `orElse`, or `tryCatch`.

## Tests

- Runtime tests cover success and failure paths.
- Type tests cover inferred tagged-error props and exhaustive handlers.
- Tests use `vite-plus/test` in the Resultar repository.
- `_unsafeUnwrap()` and `_unsafeUnwrapErr()` are kept in tests, not application code.

## Red Flags

- Returning `T | Error` from functions that should use Resultar.
- Catching errors and returning strings without typed structure.
- Calling `_unsafeUnwrap()` in production code.
- Creating tagged errors without using the generated constructor props.
- Depending on spoofed `_tag` objects passing `ErrorClass.is`; guards are nominal.
- Swallowing domain errors by converting everything to `Error` too early.
- Using `tap` to perform fallible work that should affect the returned result.
