# RFC 0005: Contract safety, HTTP cancellation, and AI validation

> Proposal, not current usage guidance. The APIs and checker rule proposed here are
> not implemented by this document. For supported contracts, see the
> [core guide](../../packages/resultar/README.md),
> [request guide](../../packages/request/README.md), and
> [checker guide](../../packages/check/README.md).

- Status: Draft
- Date: 2026-11-11
- Target packages: `resultar-check`, `resultar-request`, `resultar-request-zod`, and `resultar-request-typebox`
- Related work: agent evaluations, documentation, and the live lifecycle pilot
- References: [RFC 0003](./rfc-0003-phase-3-remainder-and-validation.md), [RFC 0004](./rfc-0004-effect-v4-ergonomics-and-tooling.md)

## Summary

Strengthen the contracts that humans and coding agents rely on before expanding the
API. The library review reproduced four issues: undiagnosed `Promise<ResultTask>`
factories, HTTP retries continuing after transport cancellation, incorrect error
classification, and an exception while constructing an HTTP error.

The contract policy also prohibits native `Promise<Result<T, E>>` application
contracts: their replacement is `ResultAsync<T, E>`, returned directly without an
`async` wrapper. This is distinct from `Promise<ResultTask<T, E>>`, whose replacement
is a directly returned `ResultTask<T, E>`.

This RFC also proposes a Task-native HTTP entrypoint, evaluations using actual model
outputs, and completion of the existing live database/session pilot. These are
product and validation improvements, not additional reproduced runtime defects.

The review inspected the core, DI, HTTP integrations, checker, and tests. Its local
reproductions establish the specific findings below; they are not a claim that all
other behaviors are defect-free. No runtime implementation changed during the review.

## 1. Priorities and boundaries

| ID | Work | Priority | Evidence/status |
| --- | --- | --- | --- |
| C1 | Reject `Promise<Result>` and `Promise<ResultTask>` contracts | High | Task gap reproduced; Result policy explicitly required |
| H1 | Stop HTTP retries when the operation is cancelled | High | Cancellation gap reproduced |
| H2 | Preserve the stage of an HTTP failure | Medium | Incorrect mapping reproduced |
| H3 | Make HTTP error construction safe | Medium | Unexpected rejection reproduced |
| A1 | Add a Task-native HTTP entrypoint | After H1–H3 | API proposal |
| V1 | Measure coding-agent performance with real model outputs | After regression coverage | Evaluation proposal |
| V2 | Complete live database/session validation | Before production adoption covered by RFC 0003 | Existing acceptance gate |

Compatibility requirements:

- Preserve eager `ResultAsync` and lazy, repeatable `ResultTask` execution. Do not
  silently change `requestJson` into a lazy API.
- Preserve deprecated signatures and generator/tap behavior documented in the
  [v4 migration reference](../migrations/v4.md).
- Keep native Promises at SDK, driver, and framework boundaries. New repository
  and use-case factories should return `ResultTask` directly.
- Replace native `Promise<Result<T, E>>` contracts with `ResultAsync<T, E>`; use
  `StrictResultAsync<T, E>` for `Promise<StrictResult<T, E>>`. This correction preserves
  eager execution. Adopting a lazy Task is a separate design decision.
- Preserve concrete success, error, and requirement types across adapters.
- Preserve existing HTTP error mapper contracts; adding a required cancellation
  mapper or widening a discriminated union requires compatibility review.
- Use targeted tests and changesets for each shipped behavior change. This draft
  itself requires no runtime release or changeset.

A core interpreter rewrite, DI redesign, universal Promise ban, and removal of eager
compatibility APIs are outside this RFC. Keep fixes close to existing code and
introduce shared machinery only when there is a concrete reuse benefit.

## 2. C1 — Reject Promise-wrapped Result and Task contracts

### Finding

The following shape passed the native checker with no findings under both defaults
and the documented Task-oriented configuration:

```ts
import { ResultTask } from 'resultar'

export const load = async () => ResultTask.ok(42)
export const outcome = async () => {
  const value = await load()
  return value
}
```

`load()` returns `Promise<ResultTask<number>>`. Awaiting it retrieves a Task; it does
not execute that Task. This is particularly misleading in generated service code.

The default branch of
[`prefer-result-async`](../../packages/check/native/internal/analyzer/result_async.go)
targets `Promise<Result>` contracts. Its broad mode recommends eager `ResultAsync`
and is not a substitute for a Task-specific diagnostic. The Task configuration
deliberately disables that legacy policy, so the proposed contract protection must
cover both shapes without requiring its broad native-Promise policy.

### Proposal

Add an independent rule, provisionally named `no-promise-resultar`, that identifies
native Promise return contracts containing a Resultar Result or Task. Use resolved
types and library type identity, not textual matches on names such as `Result` or
`ResultTask`.

The diagnostic must recommend the replacement matching the original contract:

| Rejected application contract | Required replacement |
| --- | --- |
| `Promise<Result<T, E>>` | `ResultAsync<T, E>` |
| `Promise<StrictResult<T, E>>` | `StrictResultAsync<T, E>` |
| `Promise<ResultTask<T, E, R>>` | `ResultTask<T, E, R>` |

Return each replacement directly, without an `async` wrapper. An async function that
returns `ResultAsync` is still a native Promise-returning function: JavaScript awaits
the thenable and produces `Promise<Result>`. Merely replacing the value in its return
statement does not fix the contract.

For example, the following synchronous Result wrapped by `async` is rejected:

```ts
import { ok } from 'resultar'

const load = async () => ok(42) // Promise<Result<...>>
```

Its eager Resultar counterpart returns the asynchronous Result directly:

```ts
import { okAsync } from 'resultar'

const load = () => okAsync(42) // ResultAsync<...>
```

Real SDK calls must also map external rejections into the declared error channel;
changing only a return annotation is insufficient. These replacements do not ban
raw `Promise<T>` transport inputs or require rewriting the runtime's internal Promise
implementation. Any unavoidable native interop contract needs an explicit boundary
suppression, rather than an exemption for arbitrary application services.

Cover inferred and annotated functions, methods, interface contracts, aliases, and
Promise payload unions containing a Result or Task. Emit a useful diagnostic at the
factory or contract declaration without duplicate reports for the same return
contract, including when the existing legacy rule is also enabled. For Task factories,
recommend returning the Task directly or composing external work inside a Task boundary.

Do not automatically remove `async`: an implementation may contain awaits, throws,
or effects whose execution timing would change. Deliberate asynchronous Task
construction can use the existing explicit suppression mechanism.

Default `noPromiseResultar` to error severity so both prohibited shapes fail validation,
including when `preferResultAsync` is off and `failOn` is error. Consumers can explicitly
override the severity for incremental adoption. Keep the legacy rule's meaning and
the existing `failOn` default unchanged.

### Acceptance

- [ ] Inferred and explicit `Promise<Result<...>>`, `Promise<StrictResult<...>>`, and
  `Promise<ResultTask<...>>` contracts fail the documented application configuration.
- [ ] Result diagnostics recommend `ResultAsync`/`StrictResultAsync`; Task diagnostics
  recommend a direct Task, preserving success, error, and requirement types.
- [ ] An async wrapper returning a `ResultAsync` is also diagnosed through its inferred
  `Promise<Result>` return type.
- [ ] Aliases, methods, and union payloads are covered without name-based false positives.
- [ ] Direct `ResultAsync`, `StrictResultAsync`, and Task factories, raw SDK Promises,
  and explicit runner boundaries pass without an outer prohibited application contract.
- [ ] Legacy rule semantics remain unchanged, and overlapping rules do not duplicate findings.
- [ ] CLI and editor integration tests verify the message, location, and suppression.
- [ ] Generated-code evaluations include unannotated async Result and Task factories,
  so the failures cannot be caught solely by prescribed return annotations.

## 3. H1 — Carry cancellation through HTTP retry

### Finding

[`createRequestJsonRetryResult`](../../packages/request/src/request-json.ts) calls
`ResultAsync.retry` without a signal. Neither the request base options nor the retry
options currently expose one in the [public types](../../packages/request/src/types.ts).
Passing a signal to `fetch` through a closure therefore cancels the transport but
does not cancel the retry scheduler.

The local reproduction used a request factory that aborted a controller and threw
its abort reason. With `times: 2`, the factory ran three times. Both retry callbacks
observed an already-aborted signal; the final value was a `RequestError` with status
500 and an `AbortError` cause. Retry delays still elapsed.

This is a missing cancellation contract in the adapter, rather than evidence that
the core retry implementation ignores a supplied signal.

### Proposal

Add an optional operation signal to the eager request input and propagate it through
the retry scheduler and schema adapters. Existing callers may continue forwarding
that same signal to their transport through a closure; existing zero-argument request
factories remain valid. The adapter cannot force cancellation of a transport that
ignores the signal, and must document that limit.

Check cancellation before starting an attempt and while waiting for the next one.
Once the operation signal is aborted, stop scheduling work even if a custom retry
predicate would otherwise allow it. Recognized transport aborts must not be retried
by the default policy. Preserve custom abort reasons without relying only on an
error's name.

Keep the eager error contract explicit: do not leak a new core abort error through
the current `as ResultAsync<T, RequestError>` assertion. Preserve the original cause
and existing request mapper shape. Decide and document the eager cancellation
representation before implementation; do not add a required mapper silently.
Task-owned interruption in A1 must use the existing Task interruption semantics.

### Acceptance

- [ ] A pre-aborted signal prevents the first request attempt.
- [ ] Abort during a retry delay prevents the next attempt and releases the wait.
- [ ] Abort during a cooperative transport prevents further attempts.
- [ ] Cancellation during an async retry hook/predicate prevents later attempts
  when it settles; tests do not assume arbitrary user callbacks can be forcibly stopped.
- [ ] Custom abort reasons are retained; timeout and cancellation remain distinguishable.
- [ ] Cancellation does not escape the declared eager error type.
- [ ] Uncancelled eager calls retain timing and retry-count behavior.
- [ ] Zod and TypeBox adapters forward the signal and retain inferred error types.

## 4. H2 — Classify errors at their originating stage

### Finding

`classifyRequestJsonError` currently categorizes any `RequestError` whose cause is a
`SyntaxError` as `invalidJson`. Both request execution and JSON reading use the same
base error handler.

A request factory rejecting with `new SyntaxError('request construction')` reached
`mapError.invalidJson`, despite no response being received. The default retry policy
also excludes this incorrectly classified failure.

### Proposal and acceptance

Record the failure category where the operation occurs and preserve the original
cause. Reuse the current internal error handling structure where possible; the
exception's class alone cannot identify the operation that failed.

- [ ] A request-stage `SyntaxError` reaches `mapError.request` and the request retry policy.
- [ ] A JSON parse `SyntaxError` reaches `mapError.invalidJson` and is not retried by default.
- [ ] Body read/network failures are not indiscriminately labeled invalid JSON.
- [ ] HTTP status failures and decoded-payload validation failures retain their categories.
- [ ] Mapper and retry-hook contexts agree about the failure category.
- [ ] Schema adapters preserve the same distinctions and concrete mapper return types.

See [request execution and classification](../../packages/request/src/request-json.ts).

## 5. H3 — Keep HTTP error construction inside the typed boundary

### Finding

`HttpResponseErrorCauseError` uses `JSON.stringify({ body, headers, statusCode })`
directly in its constructor. The public `RequestHeaders` type is `unknown`.

A structurally valid response with status 503 and circular headers caused a rejected
Promise with `TypeError`, rather than an `Err<RequestError>`. This is a library-owned
failure while representing an expected HTTP error, not an exception thrown by a
consumer's mapper. The reproduction used a structural response; it does not imply
that ordinary Fetch `Headers` objects are circular.

### Proposal and acceptance

Reuse the existing safe serialization helper in
[`request-json.ts`](../../packages/request/src/request-json.ts) for the message while
preserving the raw body, headers, and status fields.

- [ ] Circular headers, nested bigint values, and throwing serialization hooks do
  not turn an HTTP error into an unexpected Promise rejection.
- [ ] The original metadata remains accessible from the HTTP cause.
- [ ] HTTP status mapping and retry remain available for these responses.
- [ ] Ordinary serializable metadata retains its existing message representation.
- [ ] Existing behavior for exceptions thrown by consumer callbacks is unchanged.

## 6. A1 — Evaluate a Task-native HTTP entrypoint

Add a separate entrypoint, provisionally named `requestJsonTask`, only after the
HTTP boundary fixes have regression coverage. The name and final overloads remain
subject to API review; it must not appear as an available API in generated manuals
before implementation.

The proposed contract is:

- Accept a request factory receiving the execution `AbortSignal`; do not accept an
  already-running Promise as the lazy input.
- Return `ResultTask<T, E>` directly, with no outer `async` wrapper.
- Start no request at construction; create fresh work on each execution.
- Preserve decoder/schema inference and domain-error mapping.
- Reuse Task cancellation, clock, and retry behavior. Avoid nested retry loops or
  an independent delay scheduler that outlives the execution.
- Preserve cleanup ownership and interruption semantics when used with timeout,
  scopes, and concurrent Tasks.

Use existing Task machinery and share decoding/classification where needed. Do not
add a parallel HTTP runtime. Keep `requestJson` and current schema entrypoints eager.

Acceptance requires runtime tests for laziness, repeated execution, cancellation,
retry counts, and cleanup; type tests for inferred payload/error types; and compiled
recipes for plain decoding, Zod, and TypeBox. A Task-native example should replace
manual bridging only after it is shipped.

The existing bridge remains a valid alternative. If a proof of concept shows that
the new entrypoint adds little beyond that bridge, record the decision to defer it
without blocking C1 or H1–H3.

## 7. V1 — Evaluate actual AI-generated code

The [agent evaluation suite](../../skills/resultar/evals/README.md) currently checks
thirteen reference solutions and thirteen broken variants. Its CI self-test validates
graders and makes no model calls. Passing it is not a measurement of AI usability.

Use the existing generation-adapter interface rather than building another harness.
Run paired evaluations with and without the distributed guide, keeping model version,
settings, scenarios, attempt limits, and package versions fixed. Include Promise
boundaries, direct Task factories, HTTP cancellation, error classification, and
resource ownership alongside the existing compatibility cases.

Record first-attempt and final pass rates, repair attempts, diagnostic categories,
elapsed time, and usage/cost when available. Retain generated submissions and feedback
so failures can become regression fixtures. Keep reference solutions and hidden tests
out of generation inputs; supplement bounded graders with human review of failure
semantics and documented API use.

- [ ] Select and record the model, adapter configuration, and evaluation budget.
- [ ] Establish repeated baseline runs before claiming documentation improvements.
- [ ] Compare guidance variants using identical conditions and report sample size
  and limitations; do not claim a general benchmark from this small suite.
- [ ] Add confirmed recurring mistakes to regression cases without rewriting the
  legacy eager fixtures to fit modern Task defaults.
- [ ] Keep deterministic grader validation in CI; model runs remain explicit and separate.

This RFC authorizes no provider call or spending by itself.

## 8. V2 — Complete the existing live lifecycle pilot

[RFC 0003 §1](./rfc-0003-phase-3-remainder-and-validation.md#1-live-lifecycle-validation-p0)
remains the source of truth for this acceptance gate. This RFC does not duplicate or
close its checklist.

Run the pilot against a real database and session provider, covering startup rollback,
HTTP → session → database shutdown, SSE/client disconnect, and a scope that owns the
whole server lifetime. Record the environment, steps, observed ordering, retained
resources if any, and the production go/no-go decision in the RFC 0003 record.

Mocks and existing unit/smoke tests cannot close that live gate. Turn reproducible
findings into targeted automated regressions. Missing external infrastructure leaves
V2 pending rather than making the local suite a substitute.

## 9. Delivery and validation

1. Implement C1 and H1–H3 in reviewable changes, each with reproductions converted
   into regression tests and a changeset. Resolve H1's cancellation representation
   before changing its public contract.
2. Update package guides, checker configuration, compiled recipes, and agent
   anti-pattern guidance to reflect the shipped behavior. Maintain the distinction
   between native Promise inputs and prohibited Promise-wrapped Result/Task outputs;
   teach `Promise<Result>` → `ResultAsync` separately from `Promise<ResultTask>` → Task.
3. Prototype A1 using the corrected HTTP boundaries; record the API decision and
   compatibility assessment before publishing new exports.
4. Run V1 against the resulting public package and guidance. Track V2 independently
   under RFC 0003; local code completion must not mark the live pilot complete.

For implementation changes, run the workspace validation prescribed by `AGENTS.md`:
`pnpm run check:full`, `pnpm run build`, `pnpm run smoke:package`,
`pnpm run test:examples`, `pnpm run test:docs`, and `pnpm run test:agents`.
After public API or recipe changes, build and run `pnpm run docs:generate`, then
verify and commit the generated inventory and recipes.

A documentation-only RFC update needs link and diff checks rather than a full
runtime rebuild. Keep this RFC in Draft until its design is accepted, and track
implementation and validation completion separately from publication.

## 10. Alternatives and open decisions

- **Ban all Promises:** rejected. SDK and framework boundaries legitimately use them;
  the checker should diagnose the problematic composition contract.
- **Expand `prefer-result-async` to recommend Tasks:** rejected. It changes the meaning
  of a supported eager migration policy. Use an independent diagnostic.
- **Turn `requestJson` lazy in place:** rejected. Existing consumers rely on its
  execution timing. Any Task entrypoint must be additive.
- **Infer failure stage from exception names:** rejected. The same exception class
  can arise during request execution, body parsing, or user callbacks.
- **Introduce broad abstractions while fixing HTTP errors:** deferred. Start with
  the existing helpers and extract only what A1 demonstrably needs to share.

Before implementation, settle the exact eager cancellation representation and release
impact, the checker rule's final name/configuration, and A1's retry option shape. Before
V1/V2 execution, select the model budget and the live pilot environment. These open
choices do not invalidate the reproduced findings or justify marking them resolved.
