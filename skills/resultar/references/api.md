# Resultar v3.5+ API Guide

Use this reference after checking the version installed by the consuming project. The local package
types and source are authoritative when they differ from this guide.

## Contents

- [Package Baseline](#package-baseline)
- [Core Types And Constructors](#core-types-and-constructors)
- [Composition And Recovery](#composition-and-recovery)
- [Tagged Errors](#tagged-errors)
- [Boundary Matching](#boundary-matching)
- [Async Boundaries](#async-boundaries)
- [Async Policies](#async-policies)
- [Collections And Control Flow](#collections-and-control-flow)
- [`safeTry`](#safetry)
- [Observation And Cleanup](#observation-and-cleanup)

## Package Baseline

Resultar v3.5 is an ESM package targeting Node.js 24+. The repository currently uses TypeScript 7.
Do not infer consumer requirements from memory: inspect `package.json`, the lockfile, and exported
types first.

Prefer named imports and type-only imports:

```ts
import { ResultAsync, createTaggedError, ok, safeTry, tryResult, tryResultAsync } from "resultar";
import type { StrictResult, StrictResultAsync } from "resultar";
```

`tryCatch` and `tryCatchAsync` remain compatibility aliases. Prefer `tryResult` and
`tryResultAsync` in new v3.5+ code.

## Core Types And Constructors

| Need                                                | API                                      |
| --------------------------------------------------- | ---------------------------------------- |
| Synchronous fallible value                          | `Result<T, E>`                           |
| Asynchronous fallible value                         | `ResultAsync<T, E>`                      |
| Error-only sync channel                             | `StrictResult<T, E extends Error>`       |
| Error-only async channel                            | `StrictResultAsync<T, E extends Error>`  |
| Successful value                                    | `ok(value)` / `okAsync(value)`           |
| Successful `undefined`                              | `unit()` / `unitAsync()`                 |
| Expected failure                                    | `err(error)` / `errAsync(error)`         |
| Catch synchronous throws now                        | `tryResult(fn, toError)`                 |
| Wrap a synchronous throwing function                | `fromThrowable(fn, toError)`             |
| Catch promise rejection or a throwing async factory | `tryResultAsync(input, toError)`         |
| Wrap an async throwing function                     | `fromThrowableAsync(fn, toError)`        |
| Deliberately leave Resultar at a terminal boundary  | `runSync(result)` / `runPromise(result)` |

Use the named options form when it improves readability:

```ts
const parsed = tryResult({
  try: () => JSON.parse(input) as unknown,
  catch: (cause) => new ParsePayloadError({ cause }),
});
```

`runSync` returns the `Ok` value or throws the `Err`; `runPromise` resolves the `Ok` value or
rejects with the `Err`. Keep both at framework, bootstrap, CLI, or test boundaries.

## Composition And Recovery

- `map` transforms an `Ok` value with an infallible function.
- `mapErr` transforms an `Err` value.
- `filterOrElse` validates or narrows an `Ok` value and introduces a typed error on failure.
- `andThen` chains fallible work. On `ResultAsync`, it accepts sync or async Resultar work.
- `asyncAndThen` bridges a synchronous `Result` into `ResultAsync`.
- `orElse` recovers the complete error channel.
- `catchTag` recovers one tagged error.
- `catchTags` recovers selected tagged errors; unhandled variants stay in the error union.
- `pipe` applies named combinators without changing Result semantics.

Let each step expose its narrow error type and let composition infer the union:

```ts
type CreateUserError = InvalidEmailError | UserExistsError | SaveUserError;

const createUser = (input: CreateUserInput): StrictResultAsync<User, CreateUserError> =>
  validateEmail(input.email)
    .asyncAndThen(ensureEmailAvailable)
    .andThen((email) => saveUser({ ...input, email }));
```

Do not manually cast the final error union. A surprising inferred union is usually evidence that a
step has a broad or inaccurate signature.

## Tagged Errors

`createTaggedError` creates nominal `Error` subclasses with stable `_tag`, message-template props,
`cause`, `fingerprint`, `toJSON()`, and `.err()` support.

```ts
class UserNotFoundError extends createTaggedError({
  name: "UserNotFoundError",
  message: "User $userId was not found in $source",
}) {}

const missing = UserNotFoundError.err({ userId, source: "database" });
```

- Let `$variables` in the message template define required constructor props.
- Preserve the original failure with `cause` when adapting external code.
- Keep the configured `name` equal to the class name.
- Do not override the generated constructor.
- Treat `ErrorClass.is(value)` as a nominal `instanceof`-based guard; a matching `_tag` is not
  sufficient.
- Avoid reserved template fields such as `_tag`, `name`, `message`, `messageTemplate`,
  `fingerprint`, `stack`, and `cause`.
- Use `TaggedEnum`/`taggedEnum` for lightweight tagged data that should not be an `Error`.
- Use `redact`, `isRedacted`, and `revealRedacted` when sensitive error metadata must not serialize
  or log by default.
- Use `findCause` or an instance's `findCause` to inspect a typed cause chain.

## Boundary Matching

Use branch methods inside an algorithm and matching when converting the completed result:

- `isOk()` / `isErr()` narrow for direct control flow.
- `match(onOk, onErr)` handles a simple boundary.
- `matchTags(onOk, handlers)` exhaustively maps tagged errors.
- `matchTagsPartial(onOk, handlers, fallback)` handles selected tags with a deliberate fallback.
- `matchError(error, handlers)` handles an error value directly.
- `matchErrorPartial(error, handlers, fallback)` partially handles an error value.

Include an `Error` handler whenever an error union can contain an untagged `Error`. Do not invent
`partialCatchTags`; `catchTags` already supports partial recovery.

## Async Boundaries

Choose the wrapper based on ownership of the promise:

- `fromPromise(existingPromise, toError)` wraps a promise that has already been created.
- `tryResultAsync(() => createPromise(), toError)` also catches synchronous factory throws and is
  preferred when the agent controls creation.
- `fromSafePromise(promise)` is only for promises guaranteed not to reject by contract.
- `fromCallback(options)` adapts callback or subscription APIs and returns
  `ResultAsync<T, E | AbortError>`. Supply cleanup and forward cancellation where supported.
- `AbortError` and `isAbortError` identify Resultar cancellation.

Always map `unknown` causes into a specific error near the external boundary:

```ts
const loadUser = (id: string): StrictResultAsync<User, LoadUserError> =>
  tryResultAsync(
    () => client.loadUser(id),
    (cause) => new LoadUserError({ cause, id }),
  );
```

## Async Policies

Use the built-in lazy policies instead of hand-written `Promise.race`, timers, or retry loops:

- `ResultAsync.retry(task, options)` retries typed failures and includes `AbortError` in the error
  channel. Use `times`, `delayMs`, `jittered`, `while`, and the provided signal deliberately.
- `ResultAsync.retryOrElse(task, options)` applies a typed fallback after retry exhaustion. The
  exhausted task error is replaced by the fallback error channel.
- `ResultAsync.timeout(task, options)` returns the task error or the typed `onTimeout` error.
- `ResultAsync.race(left, right)` and `raceAll(tasks)` return the first settled result.
- `ResultAsync.raceFirst(left, right)` returns the first `Ok`; if both fail, it returns the last
  observed `Err`.
- `ResultAsync.raceWith(left, right, handlers)` exposes the winner and a handle to the still-running
  task for custom cooperative policy.
- `ResultAsync.withResource({ acquire, use, release })` releases after every acquire-success path.
  Release errors are best-effort and do not enter the result channel; model cleanup in `use` when it
  must affect control flow.

Race, timeout, retry, callback, and resource helpers rely on cooperative cancellation. Pass their
`AbortSignal` into fetch, database, SDK, timer, or subscription work; aborting a wrapper cannot stop
an underlying operation that ignores the signal.

## Collections And Control Flow

Both `Result` and `ResultAsync` provide collection helpers:

- `combine` preserves array/tuple/record shape and returns the first error.
- `combineWithAllErrors` collects every error.
- `validateAll` collects all validation errors; async mapped use supports bounded `concurrency`.
- `zip` combines exactly two values.
- `firstSuccessOf` tries candidates until one succeeds and otherwise returns the final error.
- `forEach` stops at the first error; use `{ discard: true }` when successful values are irrelevant.
- `when`, `unless`, `loop`, and `iterate` model Resultar-native control flow where they improve
  clarity.

Prefer `ResultAsync.forEach(items, mapper, { concurrency })` for bounded first-error processing and
`ResultAsync.validateAll(items, mapper, { concurrency })` for independent validation where every
error matters.

## `safeTry`

Use `safeTry` when a linear generator is clearer than a chain:

```ts
const workflow = safeTry(async function* () {
  const input = yield* validateInput(raw);
  const remote = yield* loadRemote(input);
  const saved = yield* saveRemote(remote);

  return ok(saved);
});
```

Use `yield*` for `Result` and `ResultAsync`. Wrap raw promises before yielding. Avoid raw `await`,
`try/catch`, and legacy `safeUnwrap()` inside the generator.

## Observation And Cleanup

`tap`, `tapError`, and `log` preserve the original result. Callback throws and rejected callback
promises are intentionally ignored, so use them only for best-effort logging, metrics, tracing, and
observation. Use `andThen`, `orElse`, or a Resultar boundary when side-effect failure must alter the
workflow.

`toDisposable` and `toAsyncDisposable` integrate with Node.js `using` / `await using`; their
cleanup callbacks are also best-effort. Prefer `withResource` for acquire/use/release workflows.
