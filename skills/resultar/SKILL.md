---
name: resultar
description: Build, review, migrate, test, and document TypeScript code using Resultar v3.5+, including Result, ResultAsync, StrictResult, createTaggedError, safeTry, request adapters, and resultar-check. Use when expected failures should become typed values, thrown or rejected work must be wrapped, Resultar pipelines or async policies need design, HTTP JSON needs TypeBox or Zod validation, Resultar diagnostics need configuration, or an existing Resultar codebase needs review or migration.
---

# Resultar Engineering

Use Resultar to keep expected failures explicit in TypeScript without introducing an application
runtime. Produce code that preserves concrete success and error types from the domain boundary to
the final transport, job, CLI, or integration boundary.

## Start From Repository Truth

1. Inspect the consuming project's `package.json`, lockfile, Resultar version, module format, and
   TypeScript version before proposing code.
2. Prefer the installed package types and local source over remembered APIs.
3. In the Resultar repository, use these sources in order:
   - `packages/resultar/src/index.ts` for public exports.
   - `packages/resultar/README.md` and `DOCUMENTATION.md` for current semantics and examples.
   - `packages/check/README.md` for diagnostics.
   - `packages/request*/README.md` and `examples/request/` for request integrations.
4. Adapt examples when the consumer uses an older Resultar version; do not silently emit v3.5 APIs
   that are absent locally.

## Apply Opinionated Defaults

- Return `Result<T, E>` for synchronous fallible work and `ResultAsync<T, E>` for asynchronous
  fallible work.
- Prefer `StrictResult<T, E extends Error>` and `StrictResultAsync<T, E extends Error>` at
  application, service, HTTP, job, queue, CLI, and integration boundaries.
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

## Choose The Composition Operator

| Need                                      | Prefer                   |
| ----------------------------------------- | ------------------------ |
| Transform an `Ok` without failure         | `map`                    |
| Transform an `Err`                        | `mapErr`                 |
| Validate an `Ok` with a predicate         | `filterOrElse`           |
| Continue with a sync fallible step        | `andThen`                |
| Continue from `Result` into `ResultAsync` | `asyncAndThen`           |
| Recover the whole error channel           | `orElse`                 |
| Recover selected tagged errors            | `catchTag` / `catchTags` |
| Branch directly                           | `isOk()` / `isErr()`     |
| Convert a result at a boundary            | `match` / `matchTags`    |
| Map selected tagged errors with fallback  | `matchTagsPartial`       |
| Reuse a named Result combinator           | `pipe`                   |
| Write a readable linear pipeline          | `safeTry` with `yield*`  |

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

Prefer lazy Resultar policies over ad hoc timers or `Promise.race`:

- Use `ResultAsync.retry` / `retryOrElse` for typed retry and fallback policy.
- Use `timeout`, `race`, `raceAll`, or `raceFirst` for signal-aware concurrency.
- Use mapped `forEach` for first-error batch work and mapped `validateAll` for collecting every
  independent validation error.
- Use `withResource` when successful acquisition must always trigger best-effort release.
- Pass the provided abort signal into the underlying client; cancellation is cooperative.

Use `tap`, `tapError`, and `log` only for best-effort observation. Use `andThen`, `orElse`, or a
Resultar wrapper when callback failure must change control flow.

## Use `safeTry` For Linear Flows

```ts
const createUser = (input: CreateUserInput): StrictResultAsync<User, CreateUserError> =>
  safeTry(async function* () {
    const email = yield* validateEmail(input.email);
    const available = yield* ensureEmailAvailable(email);
    const user = yield* insertUser({ ...input, email: available });

    return ok(user);
  });
```

- Use `yield*` for both `Result` and `ResultAsync` values.
- Wrap raw promises before yielding them.
- Do not use raw `await` or broad `try/catch` inside a Resultar `safeTry` workflow.
- Prefer `yield* result` over legacy `safeUnwrap()`.

## Keep Boundaries Concrete

- Define request, command, and event payloads with concrete types; do not widen them to generic JSON
  records before the use case.
- Keep transport concerns out of domain code. Convert tagged errors to HTTP responses, CLI exit
  codes, job outcomes, or logs at the outer boundary.
- Use exhaustive `matchTags` when every tagged error needs a distinct mapping.
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
   quick fixes. It reads the same project configuration as the CLI.
3. Use JSONL, SARIF, or JUnit output when another CI or review system needs structured diagnostics;
   do not present those consumers as replacements for the native checker.
4. Run the repository's native formatting, build, tests, analysis, package smoke, and example
   workflows when available.

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
- Confirm no Result or ResultAsync value is silently discarded.
- Confirm mapped errors preserve `cause` and useful metadata.
- Confirm boundary handlers cover the actual error union.
- Confirm request validation derives the downstream type instead of widening it.
- Confirm validation claims match commands that actually passed.

## Load References Selectively

- Read `references/api.md` for current v3.5 exports, collection helpers, and async policy semantics.
- Read `references/patterns.md` for copyable implementation and migration patterns.
- Read `references/integrations.md` for request adapters and the CLI/editor/lint workflow.
- Read `references/review-checklist.md` for reviews, migrations, and final validation.
