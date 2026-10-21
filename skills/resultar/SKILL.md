---
name: resultar
description: Build, review, migrate, test, and document TypeScript code using Resultar v4, with Result for synchronous values, ResultTask for new lazy workflows, and ResultAsync for in-flight Results and eager compatibility. Covers typed errors, generators, services, scopes, request adapters, and resultar-check. Use when expected failures should become typed values, thrown or rejected work must be wrapped, async policies need design, HTTP JSON needs TypeBox or Zod validation, or an existing Resultar codebase needs review or migration.
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
2. Use `ResultAsync<T, E>` (`StrictResultAsync<T, E>`) as the in-flight `Result` returned by
   `task.runResult()` or at existing eager, Promise-shaped boundaries. Migrate one adapter or use
   case at a time while preserving execution.
3. Prefer `ResultTask<T, E, R>` for new asynchronous workflows. It supplies lazy, repeatable
   work; add typed service requirements, owned resources, or structured concurrency when needed.
   `R` tracks unresolved requirements; ordinary tasks use its default `never`.
4. Add retry when an operation has a retryable error policy. `Retry.policy` works with both
   ResultAsync factories and ResultTask; retry does not require migrating every async call.
5. Add a custom `Clock` when task time policies need explicit time control or deterministic tests,
   and owned fibers when child lifetimes and cancellation need supervision. Task runs already
   supply a live clock; sequential tasks do not need explicit fibers.

Keep existing Result helpers and eager adapters in use as tasks are adopted. One `resultar`
installation exports all synchronous, lazy `ResultTask`, and in-flight/eager `ResultAsync` helpers
and types from `"resultar"`.
In-flight value and Promise constructors (`ResultAsync.ok`, `ResultAsync.err`, `ResultAsync.unit`,
`ResultAsync.fromPromise`, `ResultAsync.fromSafePromise`, `ResultAsync.try`, and top-level `okAsync`,
`errAsync`, `unitAsync`, `fromPromise`, `fromSafePromise`, `tryResultAsync`) remain active for
boundary adaptation and mocks, while static orchestration helpers on `ResultAsync`, `fromCallback`,
`fromThrowableAsync`, `fromTask`, and `safeTry` are deprecated compatibility APIs.
`ResultAsync` is a `PromiseLike<Result<T, E>>` class representing an in-flight `Result`: work starts eagerly (or when `task.runResult()` is called) and repeated awaits
observe the same execution. `ResultTask` has no `.then` method; use explicit runners for every
Task, including when `R = never`. Prefer `task.runResult()`, `task.runPromise()`, `task.runExit()`,
and `task.runFork()` in new code; static runners remain equivalent and supported. Satisfying services
and scopes leaves a Task. Adapt Async with
`ResultTask.fromResultAsync`; `task.toResultAsync()` and `ResultAsync.fromTask(task)` are deprecated
aliases of `task.runResult()`. The inbound Task bridge accepts any `PromiseLike<Result<A, E>>`
or signal-aware factory, without requiring an Async instance. Read the
[gradual adoption guide](https://github.com/inaiat/resultar/blob/main/docs/gradual-adoption.md).

```sh
pnpm add resultar
```

## Choose The Execution Model

| Contract                   | `Result` / `Result.gen`                                             | `ResultAsync<T, E>` (in-flight `Result`)                              | `ResultTask<T, E, R>`                                                         |
| -------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Execution                  | Sync values; async `Result.gen` / `fn` return eager Async             | Starts eagerly (via `task.runResult()` or in-flight constructors); repeated awaits observe one execution | Lazy blueprint; each explicit `run*` executes again                           |
| Generator return           | `return value`; `yield*` short-circuits failures                    | Async `Result.gen` / `Result.fn`; bridge into Task generators         | `return value`; compose tasks, services and Results with `yield*`             |
| Error transform / recovery | `mapErr` / `orElse` / `orElseSucceed`; `unwrapOr` returns a value   | `mapErr` / `orElse` / `orElseSucceed`; `unwrapOr` returns a Promise   | `mapErr` / `orElse` / `orElseSucceed`; `unwrapOr` returns a Task              |
| Boundary fold              | `match` / `matchTags` / `matchTagsPartial` return `Out`             | Instance: `Promise<Out>`; static: `ResultAsync<Out, never>`               | Return `ResultTask<Out, never, R>`; execute with `runPromise` for `Out`       |
| Observation                | `inspect` / `inspectError` / `inspectBoth` ignore callback failures | Same, on its eager execution; returned tasks are not executed         | Same, lazily; returned tasks are not executed                                 |
| Fallible side operations   | `andThen`                                                           | `andThen`; deprecated `tap` / `tapError` remain best-effort observers | `tap` / `tapError` / `tapCause` / `tapBoth` compose failures and requirements |
| Cleanup                    | Disposal callbacks are best-effort                                  | `withResource` starts eagerly and releases best-effort                | `acquireRelease` + `scoped` await release and preserve failures               |

Prefer Task for new asynchronous workflows. Preserve the eager Async facade where callers depend
on it while migrating explicitly. `task.runResult()` returns `ResultAsync<A, E | ScopeError<R>>`,
converting a single typed failure to `Err` and rejecting defects, interruption, and composite causes.
`task.runPromise()` resolves the value or
rejects any failure; `task.runExit()` preserves every exit without rejection; `task.runFork()`
starts a root fiber immediately. Both instance and static runners enforce service requirements and
accept the same `ResultTaskRunOptions<R>` (`services`, `signal`, `clock`, `scheduler`, `yieldEvery`).
Deferred scope release errors join the runner's error type (`E | ScopeError<R>` internally).
Every runner call starts another execution; there is no public `task.run()` method.
See [API details](references/api.md).
For DI, Hono and Fastify, read [services and HTTP scopes](references/services.md). Use
`ResultTask.service<T>()(name)` or DI `Service.require<T>()(name)` for inferred identifiers. Class
services support optional `requires` with a factory returning a synchronous value or ResultTask
(Promises and thenables are rejected); generator-only `make`
remains available. Check installed versions before using these overloads.

## Apply Opinionated Defaults

- Return `Result<T, E>` for synchronous fallible work and prefer `ResultTask<T, E, R>` for new
  asynchronous workflows. Use `ResultAsync<T, E>` as the in-flight `Result` returned by `task.runResult()` or for existing eager contracts.
- Prefer `StrictResult<T, E extends Error>` when errors must extend `Error`. Use
  `StrictResultAsync<T, E extends Error>` on eager boundaries; keep concrete `E` and `R`
  on task boundaries.
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
- `ResultTask.map` is synchronous. Compose asynchronous steps with `andThen` and `tryPromise`;
  `ResultAsync.map` and `mapErr` continue to await Promise-returning callbacks.
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
`matchTags`, and `matchTagsPartial` for `pipe`. Async static matching and `unwrapOr` wrap outputs
in composable Async values; their instance forms remain native Promise terminals.
Result methods and statics `asyncMap` / `asyncAndThen` (`Result.asyncMap(result, callback)` /
`Result.asyncAndThen(result, callback)`, with curried forms for `pipe`) bridge synchronous Results into eager `ResultAsync`.

For value and domain-union pattern matching, use root `Match` (check installed exports first).
`Match.type<Input>().pipe(...)` and fluent methods
build reusable functions; `Match.value` evaluates cases immediately. `Match.fn(selector)` passes
the narrowed selected value followed by every original argument to handlers, preserving native
HTTP contexts. `Match.context<Input, [context: Context]>()` passes `(narrowedInput, context)` without repeating
the input. `tagsExhaustive` / `exhaustive` require full coverage; `orElse` receives the remaining
type. `Match.result` returns a native Resultar Result for matched/unmatched input, whereas
`result.match` / `matchTags` consume domain Results. Boolean predicates and safe partial refinements
do not prove exhaustive coverage. See [API details](references/api.md#pattern-matching).

Use Task's canonical `ok`, `err`, `mapErr`, `andThen`, and `orElse` in new code. Deprecated
`succeed` / `fail`, `mapError`, `flatMap`, and `catchAll` retain their contracts. Prefer `{ ok, err }`
object handlers and `Retry.policy(...)`; older handler shapes and Task retry options remain supported.
Prefer `task.runResult()` (or `ResultTask.runResult(task)`); `ResultAsync.fromTask` and static/instance `toResultAsync` remain callable as deprecated aliases.
Prefer `tryResult` and `tryResultAsync` from `resultar`; their supported aliases retain
deprecation annotations. Tagged errors keep `.err()`, `.taskErr()`, and `.errAsync()`; new eager code
can use `errAsync(new DomainError(props))`, importing `errAsync` from `resultar`.

## Choose The Composition Operator

Use `Result.fromNullishOr` to turn missing values into typed errors and `Result.liftPredicate`
to construct a Result from a predicate or refinement. Both support direct and curried forms;
callbacks that throw propagate their exceptions. Inspect task cause trees with `Cause.isCause`, `hasFails`,
`hasDies`, `hasInterrupts`, `failures`, `defects`, `findError`, and `pretty`; keep `findCause` for Error cause chains.

| Need                                        | Prefer                                    |
| ------------------------------------------- | ----------------------------------------- |
| Transform an `Ok` without failure           | `map`                                     |
| Transform an `Err`                          | `mapErr`                                  |
| Validate an `Ok` with a predicate           | `filterOrElse`                            |
| Continue with a sync fallible step          | `andThen`                                 |
| Start lazy work from a `Result`             | `ResultTask.fromResult` + `andThen`       |
| Preserve a sync-to-eager compatibility step | `Result.asyncAndThen` / `.asyncAndThen`   |
| Recover the whole error channel             | `orElse`                                  |
| Recover selected tagged errors              | `catchTag` / `catchTags`                  |
| Branch directly                             | `isOk()` / `isErr()`                      |
| Convert a result at a boundary              | `match` / `matchTags`                     |
| Map selected tagged errors with fallback    | `matchTagsPartial`                        |
| Reuse a named Result combinator             | `pipe`                                    |
| Write a sync linear pipeline                | `Result.gen` with `yield*`                |
| Write a lazy async linear pipeline          | `ResultTask.gen` with `yield*`            |

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

Return a Task from new async adapters and services. Use `ResultTask.tryPromise({ try, catch })`
to create the Promise on each run, capture factory throws and rejections, and map `unknown` into a
concrete error. Forward the supplied signal to the client. `map` stays synchronous; use `andThen`
to compose another Task or a synchronous Result.

- Use `retry(Retry.policy(...))` and `timeout(milliseconds, onTimeout)` for typed retry and time policy.
- Use `ResultTask.race` for first success or `raceFirst` for first outcome. They own their children
  and await loser cleanup.
- Use `ResultTask.forEach` for bounded first-error batch work and `validateAll` to collect
  independent validation errors.
- Use `acquireRelease` + `scoped` for awaited, failure-preserving resource cleanup.
- Fold a Task with `match` / `matchTags`, then execute that fold with `folded.runPromise()`.
  Use `runResult` for a Result boundary or `runExit` to inspect every cause without rejection.

Request helpers and existing callback adapters return eager `ResultAsync`.
Create them inside `ResultTask.fromResultAsync((signal) => adapter(...))` when new Task work must
be lazy and repeatable. Capturing an already-created Async shares its existing execution.

For an existing eager contract, keep `fromPromise` for an existing Promise, `tryResultAsync` for
a Promise factory, `fromSafePromise` only for guaranteed non-rejection, and `fromCallback` for
subscriptions with cleanup. Its `ResultAsync.retry` / `retryOrElse`, `timeout`, `race` / `raceAll` /
`raceFirst`, collections, and best-effort `withResource` remain supported; their semantics differ
from Task ownership. Do not replace such a boundary with a Task without migrating its callers.
`runPromise(asyncResult)` imported from `resultar` is the legacy terminal; core Task uses
`task.runPromise()` (or the equivalent `ResultTask.runPromise(task)`).

Use `Retry.policy(options)` for retry configuration shared by ResultAsync and ResultTask. It keeps
attempt state per execution and supplies the same zero-based callback context in both models;
eager Async options retain their existing signatures. Task also retains its older retry options:
one-based retry callbacks and boolean jitter differ from the portable policy contract.
See [retry patterns](references/patterns.md#apply-retry-and-timeout-policy).

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

Use `task.runFork(options)` when a terminal boundary needs an immediately running
root fiber. Its native `FiberHandle` exposes `id`, `poll()` and removable `addObserver` diagnostics
after finalizers; diagnostics do not consume owned failures. `forkChild` returns the same native
handle within its scope. `Fiber.join(fiber, { interruption: 'detach' })` cancels the wait without
canceling the native target; default join behavior remains `'wait'`. Closing an owning scope still
interrupts and awaits its children.

Return `ResultTask<A, E, R>` directly from lazy service functions and plain success values inside
`ResultTask.gen` / `fn`. Compose a final step with `return yield* step`; `return step` leaves that
task unexecuted as the success value. Execute all tasks with an explicit runner;
`await task` returns the unexecuted Task because Task has no `.then` method.

Across `Result`, `ResultAsync`, and `ResultTask`, `inspect` / `inspectError` / `inspectBoth` and
`log` provide best-effort observation, swallowing callback failures without executing returned
tasks. Deprecated `Result` and `ResultAsync` `tap` / `tapError` retain that observation contract.
Only Task `tap` / `tapError` / `tapCause` / `tapBoth` compose fallible side operations whose
errors and defects propagate.

## Use `Result.gen` For Linear Result Flows

```ts
const validateUser = (input: CreateUserInput): StrictResult<ValidUserInput, InvalidUserError> =>
  Result.gen(function* () {
    const email = yield* validateEmail(input.email);
    const name = yield* validateName(input.name);

    return { email, name };
  });
```

Use `ResultTask.gen(function* () { ... })` for new workflows that also perform async work;
see the [linear Task recipe](references/patterns.md#write-a-linear-workflow). `Result.gen` and
`Result.fn` also accept async generators, returning eager `ResultAsync`. The deprecated root
`safeTry` supports both sync and async bodies whose final return is a `Result`.
Use `ResultTask.gen` for Task workflows; do not invent a `ResultTask.safeTry` alias.

- Return the plain success value (`return value`): `Result.gen` wraps plain successes in `Ok`
  automatically without inspecting properties or prototypes.
- Short-circuit early errors and final fallible steps via `yield*` (`return yield* err(...)` or
  `return yield* step()`). Returning a `Result`, `ResultAsync`, `Promise` (in sync generators), or
  `ResultTask` directly from `Result.gen` is rejected at compile time.
- A missing success return becomes `Ok(undefined)`; annotate concrete workflow output types where a
  value is required.
- Deprecated `safeTry` retains synchronous and asynchronous bodies whose final value is a Result.
  It is separate from modern `Result.gen`, whose plain success payloads remain opaque.
- `Result.safeUnwrap()` remains callable; prefer `yield* result` for direct composition.
- `Result.fn` wraps a synchronous or asynchronous generator function (plus up to eight post-body pipeline
  operators receiving `(result, ...args)`) with the same `yield*` and plain-value return contract.
- `ResultTask.gen` and `ResultTask.fn` share the same plain-value return convention with lazy execution.
  Generator annotations (`ResultGenerator`, `ResultAsyncGenerator`, `ResultTaskGenerator`,
  `ResultTaskYieldOf`, `ResultGenOptions`, `AsyncResultGenOptions`, `SafeTryOptions`, and
  `SafeTryAsyncOptions`) are exported from `resultar`.
- Synchronous `Result.gen` yields Results. Async `Result.gen` yields Results and eager `ResultAsync`
  values. Task generators yield Tasks, Results, and services; bridge Async with `fromResultAsync`.
- Wrap raw promises before yielding them; prefer `ResultTask.tryPromise` in new Task generators.
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
- These helpers retain eager `ResultAsync` returns. In a new Task, call the helper inside
  `ResultTask.fromResultAsync((signal) => loadRequest(signal))`, where `loadRequest` creates the
  request helper and forwards that signal to fetch.
  Constructing the helper before the factory would start the request immediately.

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
