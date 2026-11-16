# RFC 0009: Inference, typed scope closure, and application lifecycle

- Status: Draft
- Date: 2026-11-16
- Target packages: `resultar`, `resultar-di`, `resultar-check`; Node lifecycle documentation first
- References: [RFC 0002](./rfc-0002-di-lifetimes-scopes.md), [RFC 0006](./rfc-0006-task-cancellation-and-recovery.md), [RFC 0007](./rfc-0007-task-promise-defect-boundary.md), [RFC 0008](./rfc-0008-declarative-configuration.md)

## Summary

Improve generic inference at synchronous boundaries, preserve expected errors when
closing long-lived scopes, make lifetime diagnostics actionable, and document a
small Node startup/shutdown integration using existing resource ownership APIs.

These are independent workstreams with separate acceptance gates. Configuration
definition, validation, and injection remain in RFC 0008. No new application
framework, scheduler, or lifecycle package is approved by this draft. Evaluate a
Node adapter only after executable recipes demonstrate repeated integration work.

All proposed APIs are design candidates. This document and its index entry do not
change runtime behavior, public declarations, or generated usage documentation.

## 1. Baseline and scope

The current implementation provides the following foundations:

- `Result.try` and `tryResult` share a synchronous error boundary and reject native
  Promise returns through their declaration constraints. Generic indexed returns
  need a dedicated inference regression.
- `ResultTaskScopeOwner` has no error type parameter. `addFinalizer` accepts an
  unknown error channel and `close()` returns `ResultTask<void, unknown>`.
- `makeScope` waits for pending work, adopts successful acquisition scopes, and
  shares closure across repeated calls. Its closing outcome is passed to finalizers;
  the returned task reports cleanup failures rather than replaying the body result.
- DI already owns resources, releases partially initialized graphs, and validates
  lifetimes. Its runtime error includes the resolution path and conflicting lifetimes.
- The checker already has `no-invalid-lifetime`, with guidance about incompatible
  consumer/dependency lifetimes. Static analysis should preserve the identity of
  each composed module when producing findings.
- DI does not install process signal handlers or implement HTTP draining. Those
  responsibilities currently belong to application adapters.

The relevant implementation is in [Result boundaries](../../packages/resultar/src/result/result.ts),
[Task scopes](../../packages/resultar/src/task/result-task.ts),
[DI modules](../../packages/di/src/module.ts), and
[checker rules](../../packages/check/native/internal/analyzer/rules.go).
RFCs are design history; installed declarations and package documentation remain
the authority for available APIs.

## 2. Preserve inference for generic synchronous returns

### Problem and regression

An indexed return such as `ModelMap[Key]` should retain its relationship to `Key`
when passed through `Result.try`, provided every possible value is synchronous.
Conditional types that exclude asynchronous values can make that proof difficult
inside a generic function even when concrete call sites are valid.

```ts
// Regression reproducer for the existing API, not a proposed overload.
import { Result } from "resultar"

interface ModelMap {
  account: { name: string }
  project: { title: string }
}

interface DecodeError {
  readonly _tag: "DecodeError"
}

declare function decode<Key extends keyof ModelMap>(key: Key): ModelMap[Key]

function readModel<Key extends keyof ModelMap>(
  key: Key,
): Result<ModelMap[Key], DecodeError> {
  return Result.try(
    () => decode(key),
    (): DecodeError => ({ _tag: "DecodeError" }),
  )
}
```

The minimal case was compiled with TypeScript 7.0.2 against the local built
declarations when drafting this RFC on 2026-11-16. It fails with `TS2322`:
`ModelMap[Key]` is not assignable to
`Exclude<ModelMap[Key], Promise<unknown>>`. This is baseline evidence, not an
implemented fix. Recheck against the target release before modifying overloads;
if it already passes there, preserve the case as a regression. Do not weaken
synchronous constraints just to make the example compile.

### Contract and acceptance

- Preserve the relationship between literal keys and their result types, including
  generic wrappers, unions, readonly properties, optional fields, and `never`.
- Keep inference of the error mapper in both callback and object forms. Cover
  `Result.try` and the named `tryResult` export through their shared declarations.
- Reject async callbacks and native Promise success values. Characterize structural
  thenables and mixed synchronous/asynchronous unions separately; any tightening
  of currently accepted inputs requires an explicit compatibility decision.
- Do not widen success or error types to `unknown` or `any`, introduce assertions
  at call sites, or change the meaning of the deprecated aliases.
- Preserve immediate execution, single invocation, exception mapping, and mapper
  behavior. A type-only fix should not change the runtime boundary.

Use positive and negative compile-time fixtures against supported TypeScript
versions. Compare emitted declarations and compiler diagnostics. Measure type-check
cost if an overload introduces recursive or substantially more expensive inference.
If no declaration change is needed, ship the regression without inventing a new API.

## 3. Typed errors for long-lived scope closure

### Proposed usage

```ts
// Proposed API; the generic argument is not available in the current API.
const owner = ResultTask.makeScope<SubscriptionCloseError>()
owner.addFinalizer(() => subscription.close())
const closing = owner.close()
// Intended type: ResultTask<void, SubscriptionCloseError>
```

`subscription.close()` in this sketch is an application-owned task returning the
declared cleanup error. The desired extension is an owner with a declared upper
bound on finalizer errors. Keep calls without a type argument compatible with
the current unknown-error contract, for example through a default type parameter.

An owner is mutable and reused across executions. Its error type cannot silently
widen after another reference has already captured it. Declare the allowed error
union when creating it, and check every way a resource can enter the owner.

### Required type behavior

| Operation | Required contract |
| --- | --- |
| `makeScope<CloseError>()` | Create an owner bounded by `CloseError`; no acquisition or execution at construction. |
| `addFinalizer(release)` | Accept only finalizers whose expected errors fit `CloseError`; retain existing service requirement restrictions. |
| `use(task)` | Check cleanup errors carried by scope requirements before accepting the task; acquisition and body errors retain their own types. |
| Failed `use(task)` | Include any cleanup failures from its failed acquisition attempt in that execution's error contract. |
| Successful `use(task)` | Preserve cleanup requirements for resources adopted into the owner and enforce the declared bound. |
| `close(exit?)` | Expose the declared cleanup error bound; keep the supplied body outcome as finalizer context, not an extra replayed typed failure. |

Use the existing `ResultTaskScope<E>` requirement information where it is sound.
Do not implement the extension by asserting the return type of `close()`. Check
direct finalizers, acquired resources, nested/adopted scopes, and resource tasks
passed across function boundaries. The generic `use` signature and variance must
be reviewed with compile-time fixtures before accepting the public declaration.

If current task types cannot represent a necessary distinction between execution
errors and release errors, record a concrete failing case and review that type
change separately. Until then, retain the existing unknown-error owner. Soundness
is a delivery gate, not a reason to expose a narrower unverified return type.

### Runtime compatibility and acceptance

Preserve ordering, late-acquisition cleanup, cancellation, and failure composition
from RFCs 0006 and 0007. Defects and interruption remain runtime causes even when
the declared cleanup error is `never`. A type parameter is not a guarantee of
successful or bounded-time cleanup.

Verify allowed unions and `never`, incompatible direct finalizers, incompatible
acquisitions, independent body errors, and externally supplied closing outcomes.
Include negative variance tests preventing a broadly typed owner from being used
as one with a narrower cleanup contract.

Runtime tests must cover repeated and concurrent closure, pending acquisition,
registration during/after closure, cleanup failure and defects, and cancellation
while acquisition is still settling. Assert that finalizers run once and that a
failed finalizer does not skip the remaining releases. Use deterministic barriers
and settle pending work rather than leaving timers or foreign operations behind.

## 4. Improve existing lifetime diagnostics

Preserve the existing runtime resolution path and reuse `no-invalid-lifetime`.
Audit current coverage before adding findings or fields. The intended static
explanation identifies the consuming registration, the dependency path when known,
and the conflicting lifetimes, for example:

```text
sessions (singleton) -> repository (singleton) -> database (scoped)
```

Point to both relevant registrations through source locations or existing related
diagnostic information where supported. For a direct edge, do not require a full
graph traversal merely to produce an accurate explanation.

Keep module identities separate. Two independent roots may register a service with
the same name and different lifetimes without depending on each other. Names alone
must not be used to combine their dependency graphs. Follow actual composition
through supported named, token, class, merge, and override forms; document analysis
limits rather than inventing paths for dynamic registrations.

Guidance can suggest shortening the consumer's lifetime, explicitly making a truly
application-owned resource singleton, or passing request data to a method. Do not
automatically promote dependencies to singleton: that changes resource ownership
and can share request-specific data between users.

Acceptance fixtures include valid and invalid direct/transitive dependencies,
default scoped resources, explicit singleton resources, independent roots with
identical service names, supported merges/overrides, and unknown dynamic graphs.
Keep the rule ID and configuration stable. Any change to machine-readable diagnostic
output must be additive or explicitly versioned, with CLI/LSP compatibility tests.

## 5. Node application startup and shutdown

### Recipe before abstraction

Publish a small executable Node recipe composed from existing task and DI resource
APIs. Keep framework/SDK callbacks at explicit execution boundaries. Do not add a
generic application builder or require the proposed configuration package.
Configuration, when present, follows the dependency ordering described in RFC 0008.

The recipe owns the HTTP server, signal listeners, background subscriptions, and
external connections. It must demonstrate startup failure after partial acquisition
and orderly shutdown after serving begins. Existing DI already provides resource
release; the recipe supplies process signals and HTTP policy.

### Lifecycle contract

| Situation | Required behavior |
| --- | --- |
| Program construction | No listeners, connections, or server start before execution. |
| Startup failure | Release everything already acquired; do not report readiness. |
| Shutdown during startup | Request cancellation, preserve late acquisition ownership, and release before completing. |
| First shutdown request | Stop accepting new work and begin one shared shutdown operation. |
| Repeated signals or shutdown calls | Join the same operation; never double-release resources. |
| Active requests or streams | Apply an explicit drain/cancel policy, including SSE and upgraded connections if supported. |
| HTTP drain deadline | Apply the application's documented force-close policy for remaining HTTP work. |
| Resource release | Stop dependents before releasing their dependencies; wait for finalizers. |
| Release failure | Continue remaining releases and preserve causes for the executable boundary. |
| Completion or startup failure | Remove installed signal handlers and clear owned timers. |

A serving callback must remain active for the whole serving lifetime. Avoid a
design where server startup returns and immediately closes its owning scope.
Signal listeners request shutdown; they should not independently invoke runners
that race to close the same scope. Preserve the first shared shutdown outcome.

An HTTP drain deadline is not a deadline on arbitrary finalizers. An uncooperative
SDK or cleanup Promise may never settle. A timeout or abort signal cannot forcibly
stop it. The recipe must document this limit; core and DI must not silently detach
cleanup or call `process.exit()`. Any forced process termination is an explicit
policy at the executable boundary or in its supervisor.

Use `runExit` when reporting execution, interruption, and cleanup causes together.
Keep failure details structured and let the executable choose logging and exit
codes. No new retry policy, error taxonomy, or scheduler is part of this workstream.

### Tests and possible extraction

Test the lifecycle table using barriers, controlled clocks where available, and
isolated process fixtures for real signals. Include a normal request, a long-lived
stream, startup failure, repeated signals, cleanup failure, and no leftover process
listeners after completion. Explicitly settle deliberately blocked test operations.

Use at least two application compositions to evaluate whether a small Node adapter
removes repeated lifecycle code. Record its ownership contract, signal policy,
deadline semantics, runtime dependencies, and public signature before proposing a
package. A recipe-only result is acceptable and does not block the other workstreams.

## 6. Delivery and validation

| Phase | Deliverable | Acceptance gate |
| --- | --- | --- |
| 0 | Baseline fixtures | Reproduce inference cases, characterize owner closure, and audit existing diagnostics without assuming missing behavior. |
| 1 | Synchronous inference regression/fix | Preserve indexed types and mapper inference while maintaining the synchronous boundary and compatibility. |
| 2 | Typed-owner prototype | Demonstrate sound error bounds for all registration/adoption paths; approve exact signatures before implementation. |
| 3 | Lifetime diagnostic improvements | Produce accurate paths and locations without mixing modules or changing ownership automatically. |
| 4 | Executable Node lifecycle recipe | Pass startup/shutdown, partial acquisition, streaming, failure, and listener-cleanup tests. |
| 5 | Optional adapter review | Demonstrate reuse in two compositions and review a separate public contract before extracting a package. |

Phases 1 through 4 can be reviewed and released independently after their baseline
fixtures. A blocked typed-owner design or a recipe-only lifecycle outcome must not
hold unrelated improvements hostage. Track completion per workstream and distinguish
implementation from publication; do not mark the entire RFC implemented early.

Each behavior or public declaration change requires targeted tests and a changeset.
Update the relevant package READMEs and agent guidance only after the APIs exist.
Follow `AGENTS.md` for workspace validation; build and regenerate API inventory and
recipes after public API or recipe changes, then run documentation and agent checks.
Preserve eager `ResultAsync` semantics and the supported deprecated API contracts.

Open decisions are the inference fix, sound typed-owner signatures,
the supported static graph analysis shapes, and whether lifecycle reuse warrants
an adapter. No change in this RFC requires implementing RFC 0008 first.
