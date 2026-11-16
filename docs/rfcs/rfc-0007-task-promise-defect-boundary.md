# RFC 0007: Direct Promise adaptation with defect semantics

- Status: Implemented (Validated; Awaiting Release)
- Date: 2026-11-15
- Target packages: `resultar`, `resultar-check`
- References: [RFC 0005](./rfc-0005-contract-safety-http-and-ai-validation.md), [RFC 0006](./rfc-0006-task-cancellation-and-recovery.md)

## Summary

Add `ResultTask.fromPromise(factory)` for lazy Promise operations whose unexpected
throws and rejections belong to the runtime defect channel. Preserve cancellation
and direct resource acquisition semantics established by RFC 0006. Update existing
checker rules to recognize the boundary without requiring an error mapper.

This proposal describes an additive API. It does not change `tryPromise`, eager
`ResultAsync` adapters, or `fromResultAsync`. Implementation evidence is recorded below.
The baseline is checkout `210f3a3`, where `ResultTask.fromPromise` is absent.

## Motivation

Today, preserving an empty typed error channel around a raw Promise requires
composing two adapters.

```ts
import { ResultAsync, ResultTask } from "resultar"

// External SDK boundary. Rejections are deliberately treated as defects.
declare function operation(signal: AbortSignal): Promise<string>

const task = ResultTask.fromResultAsync((signal) =>
  ResultAsync.fromSafePromise(operation(signal)),
)
```

The factory defers execution, and unexpected rejection reaches the Task as `Die`.
This is valid, but requires understanding an eager adapter to construct a lazy
operation. A direct factory expresses the same contract.

```ts
// Proposed API
const task = ResultTask.fromPromise((signal) => operation(signal))
// ResultTask<string, never, never>
```

`tryPromise` remains appropriate when rejection represents an expected failure.
Its mapper produces typed `E`; its mapper-free overload produces `unknown` in
that channel. Neither is equivalent to the defect boundary proposed here.
Database, network, and SDK failures are not automatically defects. The application
must choose their classification; the checker cannot infer it from the driver.

## 1. Public API and execution contract

```ts
// Proposed member of ResultTask
static fromPromise<A>(
  factory: (signal: AbortSignal) => PromiseLike<A>,
): ResultTask<A, never, never>
```

Keep the initial API to one factory overload. Functions that ignore the signal
are accepted. Do not accept an already-started Promise, a catch mapper, or an
interruption options object in this RFC.

- Construction invokes no user code. Each run invokes the factory once, with
  that execution's native `AbortSignal`.
- Concurrent runs have independent execution and cancellation. Capturing an
  existing Promise inside the factory still reuses that Promise; the adapter
  cannot restart captured work or infer resource ownership.
- A pre-aborted run does not invoke the factory.
- Fulfillment produces `A`. Synchronous throws, rejected Promises, and errors
  while adopting a thenable produce `Die` with the original cause.
- `E = never` describes the typed failure channel only. It does not guarantee
  successful execution or remove the need for resource cleanup.
- `PromiseLike` adoption must follow native await semantics, including thenables
  that throw or attempt multiple settlements. Do not introduce a custom protocol.
- Preserve `A` as inferred, including generic and union types. A fulfilled
  `Result` is an ordinary success value here; use `fromResultAsync` to interpret
  its `Ok`/`Err` channel. Do not silently flatten nested Resultar values.

### Choosing the boundary

| Input and intended failure contract | API |
| --- | --- |
| Raw Promise factory, expected failures mapped to `E` | `ResultTask.tryPromise({ try, catch })` |
| Raw Promise factory, unexpected rejections treated as defects | Proposed `ResultTask.fromPromise(factory)` |
| Existing `PromiseLike<Result<A, E>>`, including `ResultAsync` | `ResultTask.fromResultAsync(valueOrFactory)` |
| Eager Promise conversion to an in-flight Result | Existing `ResultAsync` factories |

`ResultAsync.fromPromise` already has an eager error-mapping contract. Document
the difference explicitly; this proposal adds no top-level `fromPromise` export
and changes no existing factory's behavior.

### Runners and recovery

`runExit()` exposes `Die` as a failure cause. `runResult()` returns `Ok` on
success but rejects on defects, interruption, and composite causes under its
existing contract. `runPromise()` likewise rejects on defects. No runner turns
these defects into typed `Err` values automatically.

`catchCause` remains meaningful for this Task even with `E = never`. Typed-only
recovery such as `orElse` has no typed error to handle. External interruption
continues to follow the existing recovery restrictions.

## 2. Cancellation and resource ownership

The initial adapter always waits for the started Promise to settle. Aborting its
signal requests cooperative cancellation; it cannot stop foreign work. A Promise
that never settles can keep cancellation pending. There is no deadline guarantee.

Preserve the existing defect bridge's failure precedence.

| Event | Outcome |
| --- | --- |
| Fulfillment without cancellation | Success |
| Synchronous throw or rejection without cancellation | `Die(originalCause)` |
| Fulfillment after cancellation, ordinary execution | `Interrupt` at the next composition/runner checkpoint |
| Fulfillment after cancellation, direct acquisition | Register release, await cleanup, then report interruption |
| Rejection after cancellation | `Die(originalCause)`, preserving current bridge precedence |
| Signal aborted before execution starts | `Interrupt`; factory is not called |

A driver rejecting with an `AbortError` is still a rejection in this table. Do
not classify an error by its name or silently change the existing precedence.
Concurrent failures and finalizer failures retain the runtime's cause composition.

Register ownership directly around the operation producing the resource.

```ts
import { ResultTask } from "resultar"

// External resource boundary, with unexpected rejection classified as a defect.
interface Session {
  read(): Promise<string>
  close(): Promise<void>
}
declare function openSession(signal: AbortSignal): Promise<Session>

// Proposed API
const ownedSession = ResultTask.acquireRelease({
  acquire: ResultTask.fromPromise((signal) => openSession(signal)),
  release: (session) => ResultTask.fromPromise(() => session.close()),
})

const read = ResultTask.scoped(
  ownedSession.andThen((session) => ResultTask.fromPromise(() => session.read())),
)
```

For a late successful acquisition, release runs exactly once under the existing
cleanup context and finishes before the interrupted outcome is published. The
use phase never runs. Failed cleanup preserves interruption followed by the
cleanup failure under existing sequential cause rules.

Keep the RFC 0006 composition boundary. Putting `map`, `andThen`, or a generator
between resource creation and ownership registration can discard a late value
before the outer owner receives it. This RFC introduces no cancellation masking
for arbitrary callbacks and no automatic cleanup of partial acquisitions.

Defer a detach overload. It would require a separate ownership contract for late
success, rejection handling, and explicit cancellation precedence. Existing
`tryPromise` detach behavior remains available under its typed-error contract.

## 3. Checker integration

Extend existing rules; add no diagnostic ID or configuration option in this RFC.
Use Resultar symbol/type resolution so an unrelated method named `fromPromise`
does not receive special treatment.

The baseline [native rules](../../packages/check/native/internal/analyzer/rules.go)
contain two concrete integration points. `resultarAwaitBoundaryBody` recognizes
`tryPromise` but does not recognize the proposed factory. `isSymbolDisposeCall`
already has a `fromPromise` branch, but passes its argument directly to disposal
inspection rather than inspecting a factory body. This branch is not evidence
that the public API exists.

| Rule or area | Required behavior |
| --- | --- |
| `no-unsafe-await` | Recognize the direct async factory as an explicit defect boundary, including in `all` mode. Keep unrelated and nested unwrapped async functions subject to existing checks. |
| `typed-catch-mapper` | Do not request a catch mapper for `fromPromise`; retain checks on `tryPromise`. |
| `no-unknown-result-error` | Accept the inferred `never` error channel. Retain existing diagnostics for unknown typed errors. |
| `no-useless-recovery` | Preserve RFC 0006's `catchCause` exemption and typed-only recovery diagnostics on `E = never`. |
| `no-discard` | Track the resulting Task through the ordinary must-use rules. Recognizing the factory must not consume the outer Task implicitly. |
| `no-promise-in-result-success` | Continue reporting raw Promises stored in synchronous success constructors or returned by Task `map`. Guidance may mention both boundary choices with their distinct error contracts. |
| `no-promise-resultar` | Continue rejecting application contracts that wrap Task in Promise. Recognizing an async factory must not exempt an outer `async` Task factory. |
| `prefer-acquire-disposable` | Inspect the factory body in `fromPromise(() => resource[Symbol.asyncDispose]())`, following the existing supported callback shapes. Preserve defect semantics when suggesting `acquireDisposable`; do not report factories with additional work. |
| `no-unscoped-acquire-release` | Preserve existing scope requirement tracking when acquisition or release uses the new factory. |

The await exemption means rejection is represented in the runtime cause model,
not that it becomes typed `E`. Update the relevant checker documentation to
explain that distinction. No general relaxation of `no-throw` or other configured
policies is proposed.

Do not add an automatic replacement of `tryPromise` with `fromPromise`. Removing
a mapper would change recovery, retry, and HTTP error mapping. Do not require
rewriting valid existing `fromResultAsync` bridges or recommend an API absent
from the consumer's installed declarations.

### Checker acceptance

- [x] Add native fixtures using declarations matching the proposed public API.
- [x] Accept async factories with await; retain `no-unsafe-await` controls for
  unrelated same-name APIs and nested async functions outside the direct boundary.
- [x] Cover direct imports, supported import aliases, and namespace imports.
- [x] Confirm no mapper/unknown-error finding for `fromPromise`, with positive
  controls for mapper-free `tryPromise` under the corresponding enabled rules.
- [x] Cover `catchCause` in instance, static, and pipe forms, plus typed-only
  recovery controls that still report findings.
- [x] Report discarded Tasks and invalid `map`/Promise-wrapped Task contracts;
  accept returned, yielded, and appropriately consumed Tasks.
- [x] Cover disposable factories, additional-work negative controls, scope
  propagation, and unrelated `fromPromise` methods.
- [x] Keep diagnostic configuration/schema unchanged. Review any repair wording
  against older installed versions; do not add an unconditional autofix.

## 4. Implementation and runtime acceptance

Prefer a small adapter in the existing Task implementation that awaits the
factory and returns success or `Die` using the existing runtime context. Preserve
late success until a direct owner registers release. Avoid a nested runner,
new scheduler, new scope abstraction, or cancellation check that discards a
success before ownership registration.

- [x] Assert no execution at construction, fresh repeated execution, and
  independent concurrent runs/signals.
- [x] Verify native Promise and structural thenable fulfillment, synchronous
  throws, rejection, and throwing/multiple-settlement thenables.
- [x] Assert original defect identity, runner outcomes, and `catchCause` recovery.
- [x] Verify every cancellation-table row, including rejection named `AbortError`.
- [x] Verify direct late acquisition releases once, skips use, and waits for an
  asynchronous cleanup barrier. Cover typed release failure and release defects.
- [x] Preserve the documented unsupported inner composition cases from RFC 0006
  and verify the ownership-before-composition alternative.
- [x] Add compile-time assertions for `A`, `E = never`, `R = never`, generic/union
  inference, ignored signal parameters, and `PromiseLike` input. Reject eager
  Promise input and catch-mapper/options arguments.
- [x] Compare the adapter with the existing
  `fromResultAsync(signal => ResultAsync.fromSafePromise(factory(signal)))`
  bridge for success, defects, cancellation, and direct late acquisition.

Use explicit Promise barriers instead of timing sleeps. Cancel or settle pending
test operations so lifecycle tests leave no background work.

## 5. Alternatives and scope

Keeping the existing bridge requires no API but retains the two-adapter ceremony.
Using `tryPromise` with a mapper that throws obscures the intentional defect
contract and should not become the recommended workaround.

`fromSafePromise` would resemble the existing eager helper, but "safe" can be
misread as a guarantee of successful execution. Prefer `fromPromise` with explicit
defect documentation, acknowledging its different contract on `ResultAsync`.

Typed errors for long-lived scope closure and generic inference improvements to
`Result.try` are separate follow-ups. They require their own signatures and
regressions and are not bundled into this Promise boundary proposal.

## 6. Delivery

1. Review the factory signature, wait-only cancellation contract, and checker
   behavior before implementation.
2. Implement the core adapter with runtime/type regressions and a changeset.
3. Update checker recognition and fixtures with its own changeset. Coordinate
   release so strict checker users can adopt the factory without false positives.
4. Update the core/check READMEs, `DOCUMENTATION.md` boundary decision table,
   `llms.txt`, the agent skill and relevant references. Add an executable recipe
   covering both expected-error and defect boundary choices.
5. Build and regenerate API inventory/recipes, then run the validation required
   by `AGENTS.md`, including documentation and agent checks. Record validation
   and publication separately before marking this RFC implemented.

Published usage guides and generated inventories now describe the available API;
the original proposal sections above remain as design history.

## Implementation evidence (2026-11-15)

The factory is implemented directly in `result-task.ts`, using the existing
runtime context and native await adoption. The checker recognizes its async
callback and inspects disposal factories without adding diagnostics or settings.
Separate core and checker changesets are included; publication remains pending.

Runtime regressions in `rfc-0007.test.ts` cover laziness, repetition, defect
identity, recovery, pre-abort, independent concurrent signals, late rejection
precedence (including AbortError), and structural/throwing thenables. The RFC 0006
acquisition matrix now includes the new adapter for direct, map and andThen shapes.
The native `TestFromPromiseDefectAwaitBoundary` regression preserves the unrelated
method control. The compiled `promiseDefectBoundary` recipe has an execution test.

Validation includes workspace `check:full`, build, package smoke, examples,
documentation and agent checks. That validation passed 1,113 core cases. Remaining
acceptance coverage was completed in the follow-up below.

## Acceptance completion (2026-11-16)

All implementation checklists above are now backed by executable coverage. No
additional production behavior was necessary for this follow-up.

- `packages/resultar/tests/rfc-0007.test.ts` now includes generic/union and nested
  Result inference, rejected eager/catch/options inputs, captured Promise reuse,
  native multiple-settlement/throwing thenables, runner outcomes, and parity with
  the existing defect bridge before/after cancellation. Both adapters await late
  resource cleanup and retain interruption followed by typed or defect release
  failures. The inner-generator ownership limit is explicit, alongside the
  existing RFC 0006 map/andThen matrix and direct-ownership tests.
- `packages/check/native/internal/analyzer/rfc0007_test.go` compiles 44 scenarios
  against actual built declarations: direct, aliased, namespace and reexported
  imports, direct versus nested/foreign await boundaries, mapper/unknown-error
  controls, cause versus typed-only recovery, discard, returned/yielded/consumed
  tasks, Promise success/outer-contract violations, propagated scopes and
  disposable callbacks with additional-work/foreign-method negative controls.
  Diagnostic IDs, configuration, schema and repair behavior are unchanged.
- `DOCUMENTATION.md` now includes the defect boundary in the Promise decision map,
  error-handling table and operation index. The existing compiled contract recipes
  demonstrate both expected-error and defect boundaries; their execution tests
  verify rejection identity and lazy execution.
- Core and checker changesets record the expanded coverage. The acceptance checks
  pass with 60 targeted RFC 0006/0007 runtime tests and the 44 checker scenarios.
  Publication remains pending; this record does not claim a registry release.

Workspace validation completed: `check:full` (1,139 core tests), `build`,
`smoke:package`, `test:examples`, `test:docs`, and `test:agents` all passed.
