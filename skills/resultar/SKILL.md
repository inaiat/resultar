---
name: resultar
description: >
  Generate, refactor, review, and test TypeScript code using Resultar Results,
  lazy Tasks, tagged errors, matching, dependency injection, HTTP adapters,
  request clients, and resultar-check. Use for Resultar application code and
  migrations; preserve the consumer's existing execution contracts.
metadata:
  author: Resultar Maintainers
  version: "4.0.0"
---

# Resultar coding guide

Help developers write correct code against their installed Resultar version.
The workspace targets Node.js 24+, TypeScript 7+, and ESM. Read the consumer's
package versions and configuration before choosing APIs.

For applications combining workflows, DI and configuration, install `resultar-app`
and import their APIs from that entry point. These are direct component reexports;
framework adapters such as `resultar-hono` remain separate integrations. Direct
component imports are also supported: declare every package imported by name as a
direct application dependency. If only `resultar-app` is declared, import `Result`
and other application APIs from `resultar-app`, not a transitive package name.
Keep component versions aligned when mixing unified and direct imports.

## Choose the execution contract

- Use `Result<T, E>` for synchronous computations.
- Prefer `ResultTask<T, E, R>` for new asynchronous workflows: construction is
  lazy, each runner starts a fresh execution, and services/resources are tracked.
- Preserve existing `ResultAsync<T, E>` boundaries. They are eager, single-execution
  `PromiseLike<Result<T, E>>` values. Replace `Promise<Result<T, E>>` with direct
  `ResultAsync<T, E>` (`StrictResultAsync<T, E>` for `Promise<StrictResult<T, E>>`)
  without `async`; replace `Promise<ResultTask<T, E, R>>` with direct `ResultTask<T, E, R>`.
- For outbound HTTP JSON in lazy workflows, prefer `requestJsonTask` / `requestJsonZodTask` /
  `requestJsonTypeBoxTask` directly; preserve `requestJson` for eager `ResultAsync` boundaries.
  `resultar-request-typebox` also reexports TypeBox's `Type` as `t` for schema builders
  and `t.Static` inference; TypeBox is installed automatically as a runtime dependency
  (`>=1.3.4 <2.0.0`).
- Adapt an external driver's `Promise<T>` directly with `ResultTask.tryPromise({ try, catch })`.
  New repository and use-case methods return `ResultTask<T, E, R>`; do not mark
  those factories `async` or return `Promise<ResultTask<...>>` / `Promise<Result<...>>`.
- Bridge existing `ResultAsync<T, E>` (or `PromiseLike<Result<T, E>>`) operations with
  `ResultTask.fromResultAsync(() => operation())`; this is not a raw `Promise<T>` adapter.
  Put the operation **inside** the factory to repeat it on each run. Pass its
  signal to cancellation-aware dependencies. Passing an existing value reuses work.
- `StrictResult` and `StrictResultAsync` constrain `E` to `Error`; they do not
  change execution or pin inference. Respect supplied consumer contracts.

Native Promises remain valid at framework/SDK callbacks and explicit execution
boundaries (`runPromise`, `runExit`, Async terminal methods). Label examples of
those boundaries, external driver stubs, and intentionally invalid checker fixtures.
Do not introduce `ResultAsync.try` merely to pass it into `fromResultAsync`;
use `tryPromise` directly for new Promise adapters. See the
[boundary decision table](../../DOCUMENTATION.md#promise-boundaries-and-application-contracts).

## Compose and handle failures

Use `yield*` for steps and return plain success values from `Result.gen` /
`Result.fn` / `ResultTask.gen` / `ResultTask.fn`. Task generators are synchronous;
`yield*` of a synchronous `Result` inside a Task is supported. Short-circuit an
always-failing branch with `return yield*`. Legacy `safeTry` instead returns a
final `Result`; do not replace it mechanically with `Result.gen`.

Use `createTaggedError(...).withProps<...>()` for new domain errors. Keep class
names and tags equal; use the generated constructor. Existing error contracts,
including the request client's `RequestError`, remain supported.

Prefer `andThen`, `mapErr`, `orElse`, and `ok` / `err` in new code. Capture expected
throws/rejections with `Result.try`, `ResultAsync.try`, `ResultTask.try`, or
`ResultTask.tryPromise`. Exceptions in Task callbacks become defects, not typed `E`.

`inspect` / `inspectError` are best-effort synchronous observers. Legacy eager
`tap` / `tapError` also swallow observer exceptions. Task `tap` / `tapError` can
compose fallible tasks; thrown callbacks become defects. Do not interchange them
without checking behavior.

Run Tasks only at application boundaries: `runResult`, `runPromise`, `runExit`,
`runSync`, `runSyncExit`, `runFork` (instance and static forms). `runResult` returns
`ResultAsync`, maps a simple typed failure to `Err`, and rejects for defects, interruption,
and composite causes. `runSync` / `runSyncExit` execute synchronous-only Tasks (`runSync`
returns `Result<T, E | ScopeError<R>>`, `runSyncExit` returns `Exit<T, E | ScopeError<R>>`;
both throw if an async step is encountered). Use `runExit` to inspect
every cause as a value. Provide required services with `provideService`, `provideServices`,
`provideServiceResolver`, or runner options; pass `{ tracer }` when opting into span tracing.

Give resource-owning work an explicit `task.scoped()` / `ResultTask.scoped(task)` boundary. Roots also
own scopes; an explicit scope bounds resource lifetime within a larger workflow.
Await finalizers and worker interruption before releasing dependencies. Default
Promise interruption is `'wait'`; `'detach'` stops waiting for foreign work, not
that work itself. Timeouts cannot guarantee a deadline for uncooperative cleanup.

## Load only the relevant reference

| Task | Read |
| --- | --- |
| Choose operators, runners, Cause/Fiber/Clock/Ref/Deferred/Queue/TaskLocal/Tracer, Match or subpaths | [API semantics](references/api.md) |
| Coming from Effect (API mapping & deliberate omissions) | [Coming from Effect](../../docs/coming-from-effect.md) |
| Retry, concurrency, resources, testing | [Workflow patterns](references/patterns.md) |
| DI, Hono, Fastify, NestJS, request/Zod/TypeBox | [Services and packages](references/services.md) |
| HTTP, database sessions, callbacks and worker boundaries | [Integrations](references/integrations.md) |
| Diagnose/configure the native checker | [Checker guide](references/anti-patterns.md) |
| Review generated changes | [Review checklist](references/review-checklist.md) |

The [full guide](../../DOCUMENTATION.md), [public API inventory](../../docs/api-inventory.md),
[package READMEs](../../README.md#ecosystem-packages), and [migration guide](../../docs/migrations/v4.md)
cover the complete ecosystem. Consult only the relevant sections. Installed
`node_modules/<package>/dist/*.d.ts` are authoritative; then use the matching
package README, full guide, and this skill. RFCs are design history.

## Verify generated code

Read the project's scripts. Type-check against installed declarations, run
`resultar-check` with its configured policy, and exercise relevant behavior.
Check laziness/repetition, typed errors versus defects, cleanup on interruption,
and service lifetimes when those change. Preserve deprecated signatures and eager
semantics during gradual migration. Do not invent shims for missing APIs.

The [compiled workflow](examples/workflow.mts) and [contract recipes](examples/contracts.mts)
are executable documentation. In this workspace run `vp run test:docs` after
building, and `vp run test:agents` for the generation graders. Passing graders
validates fixtures; it is not evidence of model performance.

## Promise defect boundaries

`ResultTask.fromPromise(signal => operation(signal))` defers a raw Promise factory
until each run and returns `ResultTask<A, never, never>`. Throws and rejections
become runtime defects; `runResult()` rejects for these failures. Use
`tryPromise({ try, catch })` for expected errors and `fromResultAsync` for existing
Result-producing operations. Unlike eager `ResultAsync.fromPromise`, this factory
accepts no error mapper or already-started Promise.

Cancellation waits for settlement. Register resource ownership directly with
`acquireRelease` before composing transformations so late acquisitions are released.
The checker recognizes async factories as explicit defect boundaries for
`no-unsafe-await`; `catchCause` remains meaningful even when `E = never`.

For Node configuration, `resultar-config` exposes `defineAppConfig({ properties,
source? })` with TypeBox fields and a singleton `appConfig` provider. Import `t`
from `resultar-config` for the same builders as TypeBox's `Type`; TypeBox is installed
automatically as a dependency (`>=1.3.4 <2.0.0`). Merge once per
root; explicit sources replace `process.env`. Dependencies must select `appConfig`
before acquiring startup resources. Preserve `AppConfigModule<typeof properties>`
through factories to retain precise error graphs. For direct startup loading, use
`await appConfig.load().runResult()`; each execution reads a fresh isolated snapshot.
Inject the validated value with `.override("appConfig", config.value)` to share it
with application services. See `packages/config/README.md`.

Declare cleanup unions with `ResultTask.makeScope<CloseError>()`; direct and acquired
finalizers must fit that invariant bound. `use` includes failed-attempt cleanup
errors; `close(exit)` reports cleanup only. Unknown requirements cannot establish a
narrow cleanup bound. Use `examples/cookbook/src/node-lifecycle.ts` for process signals
and HTTP draining; cancellation cannot force arbitrary external finalizers to settle.
