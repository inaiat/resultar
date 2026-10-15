---
name: resultar
description: Build, review, migrate, test, and document TypeScript code using Resultar v3.7+, including Result, ResultAsync, ResultTask, StrictResult, createTaggedError, Result.gen/safeTry, request adapters, and resultar-check. Use when expected failures should become typed values, thrown or rejected work must be wrapped, Resultar pipelines or async policies need design, HTTP JSON needs TypeBox or Zod validation, Resultar diagnostics need configuration, or an existing Resultar codebase needs review or migration.
metadata:
  tags: [typescript, error-handling]
  domains: [foundation]
---

# Resultar Engineering

Use Resultar to keep expected failures explicit in TypeScript, starting with Result values and
adding task execution where the workflow needs it. Preserve concrete success and error types from
the domain boundary to the final transport, job, CLI, or integration boundary.

## Start From Repository Truth

1. Inspect the consuming project's `package.json`, lockfile, Resultar version, module format, and
   TypeScript version before proposing code.
2. Prefer the installed package types and local source over remembered APIs. The core package
   ships this guide at `node_modules/resultar/dist/agent/SKILL.md`; check its `versions.json` before
   using companion-package recipes. Online `main` documentation may describe a newer release.
3. In the Resultar repository, use these sources in order:
   - `packages/resultar/src/index.ts` for public exports.
   - `packages/resultar/README.md` and `DOCUMENTATION.md` for current semantics and examples.
   - `packages/check/README.md` for diagnostics.
   - `packages/request*/README.md` and `examples/request/` for request integrations.
4. Adapt examples when the consumer uses an older Resultar version; do not silently emit APIs
   that are absent locally.

## Adopt Gradually

Choose the smallest model that solves the current use case. Resultar does not require a whole
application rewrite or a move to services, scopes, clocks, or fibers before typed errors are useful.

1. Start with `Result<T, E>` in one synchronous validation, parser, or domain operation. `T` is
   the success value and `E` is the expected error type; Result's second parameter is not a
   service requirement.
2. Use `ResultAsync<T, E>` at existing eager, Promise-shaped boundaries. Migrate one adapter or
   use case at a time and preserve the execution contract of its callers.
3. Introduce `ResultTask<T, E, R>` only where reusable lazy work, typed service requirements,
   owned resource lifetimes, or structured cancellation and concurrency are needed. `R` tracks
   unresolved requirements; ordinary requirement-free tasks use its default `never`.
4. Add retry when an operation has a retryable error policy. `Retry.policy` works with both
   ResultAsync factories and ResultTask; retry does not require migrating every async call.
5. Add a custom `Clock` when task time policies need explicit time control or deterministic tests,
   and owned fibers when child lifetimes and cancellation need supervision. Task runs already
   supply a live clock; sequential tasks do not need explicit fibers.

Keep existing Result helpers and ResultAsync adapters in use as tasks are adopted. `ResultAsync<T, E>` is a type alias for `ResultTask<T, E, never>`, and the `ResultAsync` runtime value is an alias for `ResultTask` (`instanceof ResultAsync === instanceof ResultTask`). Requirement-free tasks (`R = never`, i.e. `ResultAsync<T, E>`) implement `.then(...)` and can be `await`ed directly to resolve to `Result<T, E>`, whereas tasks with pending requirements (`R !== never`) cannot be `await`ed until requirements and `Scope` are satisfied. Read the
[gradual adoption guide](https://github.com/inaiat/resultar/blob/main/docs/gradual-adoption.md).

## Choose The Execution Model

| Contract                   | `Result` / `Result.gen`                                                | `ResultAsync<T, E>` (`ResultTask<T, E, never>`)                | `ResultTask<T, E, R>`                                                       |
| -------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Execution                  | Sync values; `Result.gen` also accepts async generators                | Lazy blueprint (starts on `await` or `run*`; `fromPromise` wraps an already-started `Promise`) | Lazy blueprint; building/composing starts nothing and each `run*` executes again |
| Generator return           | `return value`; `yield*` short-circuits failures                       | Compose through `ResultTask.gen` or async `Result.gen` with `yield*` | `return value`; compose tasks, services and Results with `yield*`           |
| Error transform / recovery | `mapErr` / `orElse` / `orElseSucceed` / `unwrapOr`                     | `mapErr` / `orElse` / `orElseSucceed` / `unwrapOr` (returns `ResultAsync<T, never>`) | `mapErr` / `orElse` / `orElseSucceed` / `unwrapOr` (returns `ResultTask<T, never, R>`) |
| Boundary fold              | `match` / `matchTags` / `matchTagsPartial` return `Out`                | Return `ResultAsync<Out, never>`; use `(await task).match(...)` or `runPromise` for `Out` | Return `ResultTask<Out, never, R>`; use `(await task).match(...)` or `runPromise` for `Out` |
| Observation                | `inspect` / `inspectError` / `inspectBoth` ignore callback failures    | Same, lazily; returned tasks are not executed                  | Same, lazily; returned tasks are not executed                               |
| Fallible side operations   | `andThen` (sync `tap` / `tapError` are deprecated best-effort aliases) | `tap` / `tapError` / `tapBoth` or `andThen`                    | `tap` / `tapError` / `tapBoth`; returned task errors and requirements join the workflow |
| Cleanup                    | Disposal callbacks are best-effort                                     | `withResource` / `acquireRelease` + `scoped`                   | `acquireRelease` + `scoped` await release and preserve failures             |

Use `ResultAsync<T, E>` for requirement-free async workflows (`R = never`) that callers `await` for `Result<T, E>`. Choose `ResultTask<T, E, R>` when the signature needs typed service requirements (`R`), explicit scopes, or fiber supervision.
`ResultTask.runResult` (and `await task` when `R = never`) can reject on defects, interruption, and composite causes. Use `runExit`
when the boundary must inspect every exit without rejection. See [API details](references/api.md).
For DI, Hono and Fastify, read [services and HTTP scopes](references/services.md). Use
`ResultTask.service<T>()(name)` or DI `Service.require<T>()(name)` for inferred identifiers. Class
services support optional `requires` with a factory returning a synchronous value or ResultTask
(Promises and thenables are rejected); generator-only `make`
remains available. Check installed versions before using these overloads.

## Apply Opinionated Defaults

- Return `Result<T, E>` for synchronous fallible work. For existing eager, Promise-shaped work,
  use `ResultAsync<T, E>`; use `ResultTask<T, E, R>` where the chosen contract is lazy or needs
  requirements, owned resources, or structured cancellation and concurrency.
- Prefer `StrictResult<T, E extends Error>` and `StrictResultAsync<T, E extends Error>` at eager
  application boundaries when errors extend `Error`. Keep concrete `E` and `R` on task boundaries.
- When migrating an eager async service or repository, return `ResultAsync` / `StrictResultAsync`
  directly instead of `Promise<T>`, `Promise<Result>` or `Promise<StrictResult>`. Map external
  driver failures to typed errors in the adapter; services compose that result directly. Remove
  the function's `async` wrapper; changing only its return annotation cannot change the runtime
  value. This is a migration target for that contract, not a prerequisite to start using Resultar.
- Enable `preferResultAsync` for the existing eager application contracts being migrated. Choose
  its mode and file scope deliberately; `preferResultAsync: "error"` with
  `preferResultAsyncMode: "all"` enforces a project-wide eager boundary policy, not a universal
  requirement for Resultar adoption. Document local rule suppressions for native framework/driver
  callbacks that require Promise interoperability.
- Prefer `createTaggedError` for expected domain and application failures that need stable identity,
  metadata, causes, serialization, or exhaustive handling.
- Keep error unions specific. Let composition widen them naturally; do not collapse them to `Error`
  before the boundary.
- Return `Err` for expected failures. Reserve `throw` for programmer defects, invalid library
  arguments, or deliberate terminal/process boundaries.
- Wrap third-party throws and promise rejections at the edge, then keep the internal flow Resultar-
  native.
- Avoid `T | Error`, sentinel `null`, broad `try/catch`, rejected expected failures, and unsafe casts
  as substitutes for a Resultar error channel.
- Keep `_unsafeUnwrap()` and `_unsafeUnwrapErr()` in tests. Use `unwrapOrThrow()` only when throwing
  is explicitly the intended boundary behavior.

For reusable synchronous transformations, use root `pipe` / `flow`. `identity` preserves
its callback input; `constant(value)` captures a fallback. These utilities do not await or
execute tasks. Use `Result.fn` and `ResultTask.fn` (including optional post-body pipeline
operators) for parameterized generator workflows, and `catchTag` / partial `catchTags` /
`catchReason` / `catchReasons` / `unwrapReason` for typed
recovery. Native disposables use `acquireDisposable` in a scope; async disposal is awaited and
disposal failures become defects. For unconditional task cleanup without a scoped resource, use
`ensuring(finalizer)`.

`Result` and `ResultAsync` expose direct and curried `map`, `mapErr`, `andThen`, `orElse`,
`orElseSucceed`, `unwrapOr`, `catchTag`, `catchTags`, `catchReason`, `catchReasons`,
`unwrapReason`, `inspect`, `inspectError`, `inspectBoth`, `as`, `asVoid`, `when`, `unless`, `filterOrElse`, `match`,
`matchTags`, and `matchTagsPartial` for `pipe`; these delegate the existing fluent semantics. Result
also exposes `asyncMap` / `asyncAndThen` for eager async steps.

For value and domain-union pattern matching, use root `Match` (check installed exports first).
`Match.type<Input>().pipe(...)` and fluent methods
build reusable functions; `Match.value` evaluates cases immediately. `Match.fn(selector)` passes
the narrowed selected value followed by every original argument to handlers, preserving native
HTTP contexts. `Match.context<Input, [context: Context]>()` passes `(narrowedInput, context)` without repeating
the input. `tagsExhaustive` / `exhaustive` require full coverage; `orElse` receives the remaining
type. `Match.result` returns a native Resultar Result for matched/unmatched input, whereas
`result.match` / `matchTags` consume domain Results. Boolean predicates and safe partial refinements
do not prove exhaustive coverage. See [API details](references/api.md#pattern-matching).

Existing API spellings remain callable for gradual migration. Task `succeed`, `fail`, `mapError`, `flatMap`,
and `catchAll` are deprecated in favor of equivalent `ok`, `err`, `mapErr`, `andThen`, and `orElse` calls.
`ResultAsync.fromTask` remains the same eager bridge as `ResultTask.toResultAsync`.
Prefer named `tryResult` / `tryResultAsync`; their existing aliases and the default export
remain supported with deprecation annotations.

## Choose The Composition Operator

Use `Result.fromNullishOr` to turn missing values into typed errors and `Result.liftPredicate`
to construct a Result from a predicate or refinement. Both support direct and curried forms;
callbacks that throw propagate their exceptions. Inspect task cause trees with `Cause.isCause`, `hasFails`,
`hasDies`, `hasInterrupts`, `failures`, `defects`, `findError`, and `pretty`; keep `findCause` for Error cause chains.

| Need                                      | Prefer                     |
| ----------------------------------------- | -------------------------- |
| Transform an `Ok` without failure         | `map`                      |
| Transform an `Err`                        | `mapErr`                   |
| Validate an `Ok` with a predicate         | `filterOrElse`             |
| Continue with a sync fallible step        | `andThen`                  |
| Continue from `Result` into `ResultAsync` | `asyncAndThen`             |
| Recover the whole error channel           | `orElse`                   |
| Recover selected tagged errors            | `catchTag` / `catchTags`   |
| Branch directly                           | `isOk()` / `isErr()`       |
| Convert a result at a boundary            | `match` / `matchTags`      |
| Map selected tagged errors with fallback  | `matchTagsPartial`         |
| Reuse a named Result combinator           | `pipe`                     |
| Write a readable linear pipeline          | `Result.gen` with `yield*` |

Use `catchTags` for partial pipeline recovery; unhandled tags stay in the error channel. Do not
invent `partialCatchTags`. Use `matchTagsPartial` only for boundary matching with a deliberate
fallback.

## Model Tagged Errors

```ts
import { createTaggedError, ok } from "resultar";
import type { StrictResult } from "resultar";

class InvalidEmailError extends createTaggedError({
  name: "InvalidEmailError",
  message: "Invalid email $email",
}) {}

const validateEmail = (email: string): StrictResult<string, InvalidEmailError> =>
  email.includes("@") ? ok(email) : InvalidEmailError.err({ email });
```

- Let message-template variables define required constructor props.
- Use `createTaggedError(options).withProps<Props>()` for precise metadata types, such as
  `{ id: string }`, and optional or structured fields. Template fields remain required; other
  template fields keep their defaults.
  The typed declaration creates a fresh nominal class with compile-time metadata types.
  Pass `cause` to the constructor as usual; its type follows `Error` or the custom base.
- Preserve `cause` when converting an external failure.
- Treat `ErrorClass.is(value)` as nominal; do not rely on spoofed `_tag` objects.
- Use `TaggedEnum` only for lightweight tagged domain variants that do not need to be real errors.
- Include an `Error` handler when a matched union can contain untagged errors.

## Compose Async Work

Wrap uncontrolled async work with the helper that matches how it is created:

- Use `fromPromise(promise, toError)` for an already-created promise.
- Use `tryResultAsync({ try, catch })` or `tryResultAsync(factory, toError)` when creating the
  promise can throw synchronously.
- Use `fromSafePromise` only when rejection is impossible by contract.
- Use `fromCallback` for callback or subscription APIs with explicit cleanup.
- Use `runPromise` only at a terminal boundary that intentionally resolves or throws.

Add built-in Resultar policies as each use case needs retry, timers, or racing:

- Use `ResultAsync.retry` / `retryOrElse` for typed retry and fallback policy.
- Use `timeout`, `race`, `raceAll`, or `raceFirst` for signal-aware concurrency.
- Use mapped `forEach` for first-error batch work and mapped `validateAll` for collecting every
  independent validation error.
- Use `withResource` when successful acquisition must always trigger best-effort release.
- Pass the provided abort signal into the underlying client; cancellation is cooperative.

Use `Retry.policy(options)` for retry configuration shared by ResultAsync and ResultTask. It keeps
attempt state per execution and supplies the same zero-based callback context in both models;
legacy options retain their existing signatures. See [retry patterns](references/patterns.md#apply-retry-and-timeout-policy).

Task retry, sleeps, and timeouts use the run clock automatically. Keep the default `Clock.live`
for ordinary execution; pass `clock: Clock.virtual()` at a task run for deterministic time tests.
For structured parallel work, start with `ResultTask.all` or `forEach` and explicit concurrency.
Use `forkChild` with `Fiber.join`, `Fiber.await`, or `Fiber.interrupt` only when the use case needs
to manage a child handle inside its owning scope.

`ResultTask.tryPromise` waits for in-flight work on interruption by default. Set
`interruption: 'detach'` in its options only when the run should stop waiting; underlying work can
continue, so an adapter must own resources acquired after detachment. Task scope finalizers still run.
`Fiber.await(fiber)` observes the full child Exit without requesting interruption; `join` unwraps
the child result and `interrupt` requests cancellation. Task runs yield every 2048 instructions by
default; `yieldEvery` / `scheduler` run options configure cooperative scheduling, not preemption of
synchronous callbacks. See [task API semantics](references/api.md#resulttask-lazy-workflows).

Use `ResultTask.runFork(task, options)` when a terminal boundary needs an immediately running
root fiber. Its native `FiberHandle` exposes `id`, `poll()` and removable `addObserver` diagnostics
after finalizers; diagnostics do not consume owned failures. `forkChild` returns the same native
handle within its scope. `Fiber.join(fiber, { interruption: 'detach' })` cancels the wait without
canceling the native target; default join behavior remains `'wait'`. Closing an owning scope still
interrupts and awaits its children.

Return `ResultTask<A, E, R>` directly from lazy service functions and plain success values inside
`ResultTask.gen` / `fn`. Compose a final step with `return yield* step`; `return step` leaves that
task unexecuted as the success value. `await task` runs a requirement-free task (`R = never`) and resolves to `Result<A, E>`, whereas tasks with pending requirements (`R !== never`) do not expose `.then(...)` until requirements are provided.

Across `Result`, `ResultAsync`, and `ResultTask`, `inspect` / `inspectError` / `inspectBoth` and `log` provide best-effort observation (swallowing callback failures and never executing returned tasks). On synchronous `Result`, deprecated `tap` / `tapError` keep best-effort observation. On `ResultTask` and `ResultAsync`, `tap` / `tapError` / `tapCause` / `tapBoth` compose fallible task side operations whose errors and defects propagate.

## Use `Result.gen` For Linear Result Flows

```ts
const createUser = (input: CreateUserInput): StrictResultAsync<User, CreateUserError> =>
  Result.gen(async function* () {
    const email = yield* validateEmail(input.email);
    const available = yield* ensureEmailAvailable(email);
    const user = yield* insertUser({ ...input, email: available });

    return user;
  });
```

- Return the plain success value (`return value`): `Result.gen` wraps plain successes in `Ok`
  automatically without inspecting properties or prototypes.
- Short-circuit early errors and final fallible steps via `yield*` (`return yield* err(...)` or
  `return yield* step()`). Returning a `Result`, `ResultAsync`, `Promise` (in sync generators), or
  `ResultTask` directly from `Result.gen` is rejected at compile time.
- A missing success return becomes `Ok(undefined)`; annotate concrete workflow output types where a
  value is required.
- `safeTry` remains the deprecated runtime function with its original Result-returning signatures
  and behavior.
- `Result.safeUnwrap()` remains callable; prefer `yield* result` for direct composition.
- `Result.fn` wraps a sync or async generator function (plus up to eight post-body pipeline
  operators receiving `(result, ...args)`) with the same `yield*` and plain-value return contract.
- `ResultTask.gen` and `ResultTask.fn` share the same plain-value return contract with lazy execution. Annotate generator returns with `ResultGenerator`, `ResultAsyncGenerator`, `ResultTaskGenerator`, or `ResultTaskYieldOf`.
- Use `yield*` for both `Result` and `ResultAsync` values.
- Wrap raw promises before yielding them.
- Do not use raw `await` or broad `try/catch` inside a Resultar `Result.gen` / `safeTry` workflow.
- `Result.gen` / `safeTry` return the first yielded `Err` without closing the generator; do not
  rely on `finally` for cleanup after early failure. `ResultTask.gen` closes its generator and
  executes yielded cleanup tasks before completion.

## Keep Boundaries Concrete

- Define request, command, and event payloads with concrete types; do not widen them to generic JSON
  records before the use case.
- Keep transport concerns out of domain code. Convert tagged errors to HTTP responses, CLI exit
  codes, job outcomes, or logs at the outer boundary.
- Use exhaustive `matchTags` when every tagged error needs a distinct mapping.
- Prefer inline `matchTags` in ordinary route handlers. Capture the native context or reply in
  the handler closure and let error types be inferred. Extract a mapper when its policy is reused.
- Use local `catchTag` / `catchTags` only when recovery belongs to domain policy.

## Handle HTTP JSON Requests

Use the Resultar request family instead of repeating fetch, parsing, validation, retry, and error
mapping logic:

- Use `resultar-request` with `validator` or `decode` for schema-library-agnostic boundaries.
- Use `resultar-request-typebox` when contracts use TypeBox and preserve `Static<typeof schema>`.
- Use `resultar-request-zod` when contracts use Zod and preserve transformed
  `z.output<typeof schema>`.
- Map request, HTTP, invalid-JSON, and validation failures to concrete tagged errors when they cross
  an application boundary.

Read `references/integrations.md` before implementing request adapters or diagnostics.

## Validate In The Preferred Order

1. Run the `resultar-check` CLI as the authoritative project and CI gate. It runs TypeScript and the
   full Resultar rule set against the project.
2. Configure `resultar-check lsp` as the editor's stdio language server for inline diagnostics and
   quick fixes. It analyzes unsaved buffers and dependencies with versioned edits; hover shows
   `T`, `E`, and `R`. It reads the same project configuration as the CLI.
3. Use JSONL, SARIF, or JUnit output when another CI or review system needs structured diagnostics;
   do not present those consumers as replacements for the native checker.
4. Run the repository's native formatting, build, tests, analysis, package smoke, and example
   workflows when available.

JSONL fixes distinguish `correction` from `intentional-discard`; LSP actions carry the same
classification in `data.kind`. Do not apply a discard just to silence the checker: `void task`
does not execute a lazy task or handle its errors. Corrections still need compilation and tests.

Use `resultar-check overview --json` to inventory exported workflows/errors/services and
`resultar-check quickfixes --json` to inspect proposed edits without writing files. Preserve
concrete task requirements: assertions must not hide services or pending scope errors.
Remove unused suppression entries; disabled rules are excluded from usage checks.

The checker schema combines standard `tsconfig` options and Resultar rules for editor
completion/validation. Schema resolution and compiler compatibility are separate checks;
read [checker configuration](references/integrations.md#configure-the-native-checker) for details.

Treat stable `resultar/*` rule IDs as architecture feedback. Fix the typed boundary or composition
problem instead of suppressing diagnostics broadly. Use narrow ignore patterns only for deliberate
test, script, generated, or process-boundary exceptions.

## Test And Document Behavior

- Cover `Ok` and every expected `Err` path with runtime tests.
- Cover inferred error unions, tagged-error props, narrowing, and exhaustive handlers with type
  tests. Use `expectTypeOf` and `@ts-expect-error` where supported.
- Use the consuming project's test runner. Use `vite-plus/test` inside this repository.
- Test retry, timeout, cancellation, concurrency, and cleanup policies with deterministic fakes.
- Derive documentation examples from checked source or runnable examples and keep package links
  reciprocal when packages are alternatives or adapters.

## Review Before Finishing

- Run the project's Resultar CLI check after edits.
- Confirm no Result, ResultAsync, or ResultTask value is silently discarded.
- Confirm mapped errors preserve `cause` and useful metadata.
- Confirm boundary handlers cover the actual error union.
- Confirm request validation derives the downstream type instead of widening it.
- Confirm validation claims match commands that actually passed.

## Load References Selectively

- Read `references/api.md` for current exports, collection helpers, and async policy semantics.
- Read `references/patterns.md` for copyable implementation and migration patterns.
- Read `references/integrations.md` for request adapters and the CLI/editor/lint workflow.
- Read `references/review-checklist.md` for reviews, migrations, and final validation.
