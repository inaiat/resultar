# Resultar Workspace

Resultar makes expected failures visible in TypeScript signatures and keeps them composable through
sync, async, retry, timeout, concurrency, cleanup, and exhaustive boundary workflows. The workspace
contains the core library, HTTP request adapters, compiler-backed diagnostics, and runnable examples.

If you are evaluating or using the main library, start with:

- [resultar package README](packages/resultar/README.md)
- [gradual adoption: Result to ResultTask](docs/gradual-adoption.md)
- [full Resultar guide](DOCUMENTATION.md)
- [new features](#new-features)
- [API map](DOCUMENTATION.md#api-map)
- [AI/RAG map](llms.txt)

## Packages

| Package                    | Purpose                                                                                                                                                             | Documentation                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `resultar`                 | Core `Result<T, E>`, lazy `ResultTask<T, E, R>`, and `ResultAsync<T, E>` library with tagged errors, typed services, async policies, redaction, and strict aliases. | [package README](packages/resultar/README.md), [full guide](DOCUMENTATION.md) |
| `resultar-check`           | Native TypeScript 7 compiler checks plus type-aware Resultar diagnostics.                                                                                           | [check README](packages/check/README.md)                                      |
| `resultar-request`         | Fetch-first JSON request helper with Resultar errors, validation, retry, and error mapping.                                                                         | [request README](packages/request/README.md)                                  |
| `resultar-di`              | Typed dependency composition, scoped resources, and overrides for ResultTask applications.                                                                          | [DI README](packages/di/README.md)                                            |
| `resultar-request-typebox` | TypeBox adapter for `resultar-request`.                                                                                                                             | [TypeBox adapter README](packages/request-typebox/README.md)                  |
| `resultar-request-zod`     | Zod adapter for `resultar-request`.                                                                                                                                 | [Zod adapter README](packages/request-zod/README.md)                          |
| `resultar-hono`              | Typed Hono bindings with one DI scope per response and explicit shutdown.                                                  | [Hono README](packages/hono/README.md)                                          |
| `resultar-fastify`           | Native Fastify application/request services, cancellation and resource scopes.                                           | [Fastify README](packages/fastify/README.md)                                    |

## Main Library

Install the core package when you want expected failures in function signatures instead of hidden
behind `throw`, rejected promises, nullable returns, or ad hoc `T | Error` unions.

```sh
pnpm add resultar
```

```sh
npm install resultar
```

The npm package README is [packages/resultar/README.md](packages/resultar/README.md). It covers the
selling points and quick-start examples for:

- `Result<T, E>`, lazy `ResultTask<T, E, R>`, and `ResultAsync<T, E>`
- explicit `ResultTask` execution with typed services, generator composition, defects, and cleanup
- `StrictResult<T, E extends Error>` and `StrictResultAsync<T, E extends Error>`
- `createTaggedError`, `taggedEnum`, and redacted error props
- reusable `pipe` combinators for `Result` and `ResultAsync`
- `ResultAsync.timeout`, `retry`, `retryOrElse`, `race`, `raceAll`, and `withResource`
- `Result.gen`/`safeTry`, `matchTags`, local recovery, and boundary response mapping

## Adopt gradually

Start with `Result<T, E>` in one function and handle its `Ok` / `Err` at the caller. Keep using
ordinary application code around it. Add `ResultAsync<T, E>` where existing Promise-based work
needs typed failures, then introduce `ResultTask<T, E, R>` in individual workflows that need lazy,
repeatable execution. `E` names expected errors; the task's third parameter `R` names requirements.

| When the workflow needs... | Add... |
| --- | --- |
| Explicit success and failure | `Result`, `ok`, `err`, `match` |
| Composition across fallible steps | `andThen`, `mapErr`, `Result.gen` |
| Typed failures around existing async work | `ResultAsync`, `tryResultAsync` |
| Deferred execution and a reusable workflow | `ResultTask`, `fromResultAsync`, an explicit `run*` boundary |
| Controlled time and transient-failure policy | `Clock`, `Retry.policy`, task `retry` / `timeout` |
| Concurrent work owned by a scope | `forkChild`, `Fiber`, `scoped` |

Each stage is useful on its own. Synchronous domain functions can keep returning `Result` inside
task workflows, and existing async callers can consume a task through `toResultAsync`. Services
and DI are optional; introduce them when dependencies or resource lifetimes call for them.
The [gradual adoption guide](docs/gradual-adoption.md) walks through these boundaries with examples.
The [v4 migration notes](docs/migrations/v4.md) cover release compatibility and retained APIs.

## New features

These additions are implemented in the workspace and covered by unit, type, mutation, and smoke tests:

| Feature | What it enables | Guide |
| --- | --- | --- |
| `Match` (`value`, `type`, `context`, `fn`, `valueTags`, `typeTags`) | Exhaustive and partial pattern matching over values, tagged unions, discriminators, predicates, and HTTP route contexts. | [Pattern Matching](DOCUMENTATION.md#pattern-matching) |
| Structured task concurrency (`forkChild`, `runFork`, `Fiber`, `Semaphore`) | Scope-owned child fibers, detached join (`{ interruption: 'detach' }`), root background fibers, and bounded permits (`withPermit`, `withPermits`). | [Structured Task Concurrency](DOCUMENTATION.md#structured-task-concurrency-fibers-and-semaphores) |
| Task races, timeouts, timing, and `Clock.virtual` | Structured `race` / `raceFirst` / `timeout` with awaited loser finalizers, `delay` / `timed`, and deterministic virtual-clock testing. | [Task Racing and Timeouts](DOCUMENTATION.md#task-racing-timeouts-timing-and-virtual-clock) |
| Portable `Retry.policy` & `ResultTask.retry` / `retryOrElse` | Reusable exponential/jittered retry policies shared across `ResultAsync` and `ResultTask`. | [Portable Retry Policies](DOCUMENTATION.md#portable-retry-policies-and-resulttask-retry) |
| `ResultTask` collections & loops (`all`, `forEach`, `validateAll`, `zip`, `loop`, `iterate`) | Sequential, bounded (`{ concurrency: n }`), or unbounded task collections with fail-fast sibling interruption or error accumulation. | [ResultTask Collections](DOCUMENTATION.md#resulttask-collections-and-loops) |
| `Cause` helpers, `sandbox` / `unsandbox` / `catchCause`, `ensuring` / `onExit` | Inspect sequential/parallel causes, expose full `Cause<E>` on the error channel for selective recovery, and register unconditional finalizers. | [Structured Task Concurrency](DOCUMENTATION.md#structured-task-concurrency-fibers-and-semaphores) |
| Cooperative `Scheduler` & `yieldEvery` | Configure fiber batch budgets (`Scheduler.live`, custom `TaskScheduler`) and insert cooperative yield points in CPU-bound loops. | [Structured Task Concurrency](DOCUMENTATION.md#structured-task-concurrency-fibers-and-semaphores) |
| `Result.gen` & `Result.fn` plain-value returns | Write linear synchronous or async generators that return plain success values and compose post-body pipeline operators. | [Result Generators](DOCUMENTATION.md#result-generators) |
| `createTaggedError(...).withProps<Props>()` | Declare explicit typed payload properties on tagged errors even when the message template is static, enforced by `resultar-check`. | [Tagged Errors](DOCUMENTATION.md#tagged-errors) |
| `Result.fromNullishOr` & `Result.liftPredicate` | Construct `Result` values or reusable curried validators from nullable values, predicates, and TypeScript refinements. | [Creating Results](DOCUMENTATION.md#creating-results) |
| `pipe`, `flow`, `identity`, `constant` | Reusable synchronous function composition, typed callbacks, and fixed fallbacks. | [Function composition](DOCUMENTATION.md#function-composition-and-parameterized-tasks) |
| `ResultTask.fn`, `catchTag` / `catchTags`, ` catchReason` / `catchReasons`, `acquireDisposable` | Parameterized lazy task generators, tagged/reasoned error recovery, and native `Disposable` / `AsyncDisposable` ownership. | [Task functions](DOCUMENTATION.md#parameterized-task-functions) |
| `resultar-check` diagnostics, LSP, and `overview` / `quickfixes` CLI | Enforce `resultTaskRequirementsSafety`, `unusedSuppression`, `taggedErrorPropsMismatch`, and `matchExhaustive` in CLI and editor. | [No-Discard Validation](DOCUMENTATION.md#no-discard-validation) |

`ResultAsync` remains eager; `ResultTask` remains lazy and repeatable. See the
[gradual adoption guide](docs/gradual-adoption.md), [v4 migration notes](docs/migrations/v4.md),
[task resilience example](examples/resultar/src/task-resilience.ts), and
[functional ergonomics example](examples/resultar/src/functional-ergonomics.ts) (`pnpm run example:resultar`).


## Documentation Map

Use the full guide when you need a specific recipe:

| Topic                          | Link                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| Gradual adoption                | [Result to ResultTask](docs/gradual-adoption.md)                                            |
| Core model                     | [The Model](DOCUMENTATION.md#the-model)                                                     |
| Tagged errors                  | [Tagged Errors](DOCUMENTATION.md#tagged-errors)                                             |
| Redacted error props           | [Redacted Error Props](DOCUMENTATION.md#redacted-error-props)                               |
| Catching and recovering errors | [Catching And Recovering Errors](DOCUMENTATION.md#catching-and-recovering-errors)           |
| Async wrapping                 | [Wrapping Throwing Or Rejecting Code](DOCUMENTATION.md#wrapping-throwing-or-rejecting-code) |
| Lazy workflows                 | [Lazy tasks and requirements](DOCUMENTATION.md#lazy-tasks-and-service-requirements)                              |
| Local recovery                 | [Recovering Tagged Errors Locally](DOCUMENTATION.md#recovering-tagged-errors-locally)       |
| Async racing and timeouts      | [Concurrent Racing And Timeouts](DOCUMENTATION.md#concurrent-racing-and-timeouts)           |
| Async retry policies           | [Retrying Async Work](DOCUMENTATION.md#retrying-async-work)                                 |
| Bounded async mapping          | [Async Concurrency Mapping](DOCUMENTATION.md#async-concurrency-mapping)                     |
| Resource cleanup               | [Resourceful Async Iterables](DOCUMENTATION.md#resourceful-async-iterables)                 |
| Safe linear result code        | [Result Generators](DOCUMENTATION.md#result-generators)                                     |
| Validation error recipes       | [Validation Error Recipes](DOCUMENTATION.md#validation-error-recipes)                       |
| No-discard diagnostics         | [No-Discard Validation](DOCUMENTATION.md#no-discard-validation)                             |
| Public exports                 | [Public Entry Point](DOCUMENTATION.md#public-entry-point)                                   |

## Resultar Check

Use `resultar-check` as the canonical Resultar diagnostics command. Its native TypeScript-Go backend
runs the compiler first, then runs every enabled Resultar diagnostic over the same `tsconfig.json`.

```sh
pnpm add -D resultar-check
```

```json
{ "scripts": { "check": "resultar-check" } }
```

`resultar-check` defaults to `tsconfig.json` and runs TypeScript with no emit.

Version 3 is native-only: a small Node launcher selects a platform package, then the TypeScript-Go
binary performs compiler diagnostics and all Resultar rules in one project pass. It also exposes:

- human, JSON Lines, SARIF 2.1.0, and JUnit output;
- configurable severities, file overrides, suppressions, and CI `failOn` policy;
- a stdio LSP server with unsaved-buffer diagnostics, channel/service hover, quick fixes, and refactors;
- requirements safety and unused-suppression diagnostics;
- `overview` and `quickfixes` commands for read-only inventories and edit previews;
- `init` and `doctor` commands for a portable Zed setup;
- macOS, Linux, and Windows binaries for ARM64 and x64.

See [packages/check/README.md](packages/check/README.md) for the recommended `noDiscard`, `noThrow`,
and `noTryCatch` configuration, every diagnostic, output formats, editor setup, and the v3 migration
guide.

## Examples

| Example                                | Surface                | What it validates                                                                 |
| -------------------------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| [examples/resultar](examples/resultar) | Core Resultar cookbook | Sync validation, `safeTry`, tagged errors, async resilience, and resource cleanup |
| [examples/check](examples/check)       | Native diagnostics     | Exact findings for all supported rules plus a zero-diagnostic clean project              |
| [examples/request](examples/request)   | Request helpers        | Fetch-style JSON calls with TypeBox and Zod adapters                              |
| [examples/hono](examples/hono)         | Hono + DI application  | Class services, inferred AppHono bindings, overrides and response scopes (Node) |
| [examples/fastify](examples/fastify)   | Native Fastify + DI    | Class services, TypeBox routes, inferred request services and explicit HTTP mapping |

Both HTTP examples use three files: `services.ts` defines and registers services,
`routes.ts` maps results to native HTTP responses, and `main.ts` creates and starts the app.
They import DI helpers from their framework adapter and omit `bindings` to expose all registered
services. Pass `bindings: ["health", "users"]` to restrict the view, or `bindings: []` to select none.
Fastify declares `request.services` in `main.ts`; Hono exports `AppHono` there for route files.
Both derive service types with `InferRequestServices<typeof createApplication>`.

To start an example, enter `examples/fastify` or `examples/hono` and run `pnpm dev`.
Both default to port 3000; use different `PORT` values if running them together.

Run all example smokes with:

```sh
pnpm test:examples
pnpm test:agents
```

## Development

Common workspace checks:

```sh
pnpm check:full
pnpm build
pnpm smoke:package
pnpm test:examples
```

Release metadata is managed with Changesets. Add a changeset with the feature or fix:

```sh
pnpm changeset
```

After the change merges to `main`, the `Release` workflow opens or updates a `Version packages` PR.
When that PR is merged, CI publishes npm and JSR from the versioned package metadata.

Dry-run publish checks:

```sh
pnpm run release:npm -- --dry-run
pnpm run release:jsr -- --dry-run
```

## Requirements

- Node.js 24+
- ESM-only core package

The root package is private. Published package metadata and README content live in each package
directory.


### Hono integration

[`resultar-hono`](packages/hono/README.md) connects typed DI services to ordinary Hono handlers,
with one scope per response and explicit application shutdown. See the
[runnable example](examples/hono/README.md); port and runtime configuration stay in the bootstrap.

For an existing Hono router, use `createHonoServices(module).middleware(keys)` to infer
`c.var.services` per route while preserving runtime bindings and RPC types.

### Fastify integration

[`resultar-fastify`](packages/fastify/README.md) registers native application and request services
over the same DI scopes. Keep ordinary async handlers and explicit `reply.code().send()` mappings;
the plugin manages resource ownership through streamed replies and shutdown. The
[Fastify example](examples/fastify/README.md) includes `UsersRepository` and `Users` classes
with `requires`, function-based `Health`, and TypeBox routes.

### Coding-agent validation

Run `pnpm test:agents` to verify executable coding contracts and their deliberately broken variants
without model calls. See [the evaluation guide](skills/resultar/evals/README.md) to grade generated
submissions or compare model runs with and without the bundled skill.
