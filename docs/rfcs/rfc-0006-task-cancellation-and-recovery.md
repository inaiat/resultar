# RFC 0006: Task cancellation, resource cleanup, and recovery diagnostics

- Status: Implemented (validated; awaiting release)
- Date: 2026-11-14
- Target packages: `resultar`, `resultar-check`
- References: [RFC 0001](./rfc-0001-result-task-core.md), [RFC 0004](./rfc-0004-effect-v4-ergonomics-and-tooling.md)

## Summary

Preserve resources acquired concurrently with interruption, correct a checker
diagnostic for cause recovery, and provide a Task that remains pending until
interrupted.

The current checkout already provides `ResultTask.fromCallback`, recognizes
`ResultTaskScope` across function boundaries in `no-unscoped-acquire-release`,
and provides `runTaskJson` for Hono. These APIs establish the starting point
for this proposal and require no reimplementation. The findings below were
reproduced against the local build at commit `ca8a242`; they describe that
baseline, not a guarantee about future versions. [Core guide](../../packages/resultar/README.md) ·
[Checker guide](../../packages/check/README.md) ·
[Hono guide](../../packages/hono/README.md)

| Priority | Proposal | Evidence |
| --- | --- | --- |
| 1 | Preserve cleanup for late acquisitions and define composition boundaries | Reproduced leaks with direct and composed acquisitions |
| 2 | Correct `no-useless-recovery` for `catchCause` | Reproduced false positive |
| 3 | Add `ResultTask.never()` | Simplifies cancellation-bound workflows |

## 1. Release resources acquired after cancellation

A resource factory can complete successfully after its runner is interrupted.
When supplied directly as the acquisition, `tryPromise` in default wait mode
lets `acquireRelease` register the resource before the scope reports interruption.
`fromResultAsync` also waits
for the adapter to settle, but its post-settlement signal check can discard a
successful acquisition before `acquireRelease` sees it.

The problem also affects composition: wrapping a `tryPromise` acquisition in
an identity `map` or `andThen` introduces a cancellation checkpoint before
the outer `acquireRelease` receives the resource. Both compositions reproduced
a missing release. Removing the signal check in `fromResultAsync` alone
does not resolve this broader boundary.
[Task implementation](../../packages/resultar/src/task/result-task.ts)

### Reproduction

Run this JavaScript against a build of the current checkout.

```js
import { ResultAsync, ResultTask } from "resultar"

for (const [adapter, shape] of [
  ["tryPromise", "direct"],
  ["tryPromise", "map"],
  ["tryPromise", "andThen"],
  ["fromResultAsync", "direct"],
  ["fromResultAsync", "map"],
  ["fromResultAsync", "andThen"],
]) {
  const started = Promise.withResolvers()
  const pending = Promise.withResolvers()
  const controller = new AbortController()
  let releases = 0
  let uses = 0

  const acquireResource = () => {
    started.resolve()
    return pending.promise
  }
  const base =
    adapter === "tryPromise"
      ? ResultTask.tryPromise(acquireResource)
      : ResultTask.fromResultAsync(() => ResultAsync.fromSafePromise(acquireResource()))
  const acquire =
    shape === "map"
      ? base.map((resource) => resource)
      : shape === "andThen"
        ? base.andThen((resource) => ResultTask.ok(resource))
        : base

  const task = ResultTask.scoped(
    ResultTask.acquireRelease({
      acquire,
      release: () =>
        ResultTask.sync(() => {
          releases += 1
        }),
    }).andThen(() => ResultTask.sync(() => { uses += 1 })),
  )

  const running = task.runExit({ signal: controller.signal })
  await started.promise
  controller.abort("consumer disconnected")
  pending.resolve({ id: "resource" })

  const exit = await running
  console.log(adapter, shape, exit, { releases, uses })
}
```

| Adapter | Acquisition shape | Current outcome | Current releases | Current uses |
| --- | --- | --- | --- | --- |
| `tryPromise` with default interruption | Direct | `Interrupt` | 1 | 0 |
| `tryPromise` with default interruption | Identity `map` / `andThen` | `Interrupt` | 0 | 0 |
| `fromResultAsync` with a lazy factory | Direct | `Interrupt` | 0 | 0 |
| `fromResultAsync` with a lazy factory | Identity `map` / `andThen` | `Interrupt` | 0 | 0 |

### Proposed contract

When a waiting acquisition succeeds after interruption, register its finalizer
exactly once for that acquisition and await cleanup before publishing the
interrupted outcome. The use phase
must never run in this case. If cleanup fails, retain the interruption and
the cleanup failure under the existing cause composition rules.

### Composition and ownership boundaries

The preferred usage is to register ownership at the operation that produces
the resource, before composing transformations or further asynchronous work:

```ts
const owned = ResultTask.acquireRelease({ acquire: base, release })
const workflow = ResultTask.scoped(owned.map(transform).andThen(use))
```

Here `base`, `release`, `transform`, and `use` are application-supplied values.
If cancellation arrives after acquisition, release must already be registered
before the runtime skips `transform` and `use`.

Before accepting the implementation, decide whether acquisition composition
inside `acquireRelease` is supported under cancellation, or whether callers
must move ownership inward as shown above. Record the decision with the
identity `map` / `andThen` regressions. Do not claim that all acquisition
leaks are fixed while these cases remain undocumented.

Suppressing interruption throughout arbitrary `map`, `andThen`, or generator
bodies is not an automatic solution: callbacks may perform additional work,
throw, or wait indefinitely. A partial acquisition that throws or returns
`Err` before yielding its final resource must release its intermediate
resources itself, or register each in a scope as soon as it is acquired.
An outer `acquireRelease` cannot infer cleanup for values it never receives.

Keep factories lazy and repeatable. Preserve the single execution of an
already-started `ResultAsync` passed to the adapter. However, execution reuse
does not imply shared resource ownership. Reusing one successful eager value
in two `acquireRelease` scopes currently calls release twice on the same
resource, even without cancellation. This is a usage limitation, not a request
for automatic deduplication or reference counting. Recommend a fresh factory
per run for exclusive resources; shared resources need an explicit ownership
protocol outside this proposal.

A pre-aborted run must not invoke a lazy factory. An eager operation may have
started before the run; the adapter cannot retroactively prevent it or assume
ownership of its eventual result when acquisition never starts.

This proposal covers adapters that wait for settlement. If an external
operation never settles, cancellation can remain pending. Detached operations
need their own cleanup protocol; this RFC adds no detach mode or hard deadline.

### Failure precedence and compatibility

Preserve the existing `fromResultAsync` outcomes unless a separate compatibility
decision explicitly changes them:

| Settlement after cancellation | Current and proposed outcome | Release |
| --- | --- | --- |
| `Ok(resource)` in a direct acquisition | `Interrupt` after cleanup | Exactly once |
| `Ok(value)` outside acquisition | `Interrupt` | None |
| `Err(error)` | `Interrupt` | None for this acquisition |
| Promise rejection | `Die` | None for this acquisition |

These outcomes are intentionally recorded separately: the current runner's
final interruption check converts success, but does not replace every failure.
Deleting the adapter's signal check without preserving the `Err` behavior can
therefore change the public result. Synchronous factory throws remain defects.
When cleanup after late success fails, retain both interruption and the release
failure in the existing sequential cause composition, in that order. Finalizers
must run under the existing cleanup context despite the aborted caller signal.

### Acceptance

- [x] Convert the six adapter/composition reproductions into regression coverage;
  record the supported composition boundary and any required migration example.
- [x] For a supported late acquisition, assert one release, zero use callbacks,
  and interruption only after an asynchronous release barrier settles.
- [x] Cover typed release failure, thrown release defects, and preservation of
  both interruption and cleanup failure.
- [x] Verify the failure-precedence table and synchronous factory throws, both
  inside acquisition and for ordinary runners where applicable.
- [x] Cover cancellation before execution, while acquisition is pending, and
  after ownership registration. Preserve the abort reason.
- [x] Cover eager and factory adapter forms, repeated runs, and two concurrent
  factory runs with distinct resources and independent cancellation.
- [x] Verify that the recommended ownership-before-composition pattern releases
  resources even when downstream work is skipped or fails.
- [x] Document eager sharing and permanently pending/detached operation limits.

Use Promise barriers rather than timing sleeps to establish ordering. Prefer a
small bridge correction if it meets the agreed contract; an acquisition-specific
execution context needs justification from these tests before adding machinery.

## 2. Correct the `catchCause` diagnostic

`ResultTask<A, never>` has an empty typed failure channel. Runtime defects
can still reach `catchCause`. The checker currently uses the typed channel
to determine reachability for every recovery method, including
`catchCause`. [Rule implementation](../../packages/check/native/internal/analyzer/rules.go)

```ts
import { ResultTask } from "resultar"

const task = ResultTask.sync(() => {
  throw new Error("unexpected SDK failure")
})

const recovered = task.catchCause(() => ResultTask.ok("recovered"))
```

`recovered.runPromise()` resolves to `"recovered"`. The
`no-useless-recovery` rule should skip `catchCause` when its only evidence
is `E = never`. Keep the diagnostic for typed-only recovery such as
`orElse`. Add native checker fixtures for instance, static data-first, and
curried `catchCause` calls used in `pipe`, plus a typed-only recovery control
that still reports a diagnostic. Include a `Die` case with `E = never` and
preserve diagnostics for the other typed-only recovery methods.

This is a checker correction. It does not change runtime recovery or make
external interruption recoverable. Preserve the existing behavior where a
pure external interruption bypasses the recovery callback, and interruption
combined with cleanup failure still propagates after recovery.

## 3. Add `ResultTask.never()`

A task that owns subscriptions sometimes needs to remain alive after
initialization and finish when its caller interrupts it. An empty
`fromCallback` subscription can provide that wait today. A dedicated
primitive makes the lifecycle explicit at the call site.

```ts
// Proposed public signature
static never(): ResultTask<never, never, never>
```

Construction is lazy. Each run waits independently, allocates no timer
and performs no polling. A pre-aborted signal produces interruption
immediately. Runner cancellation, fiber interruption, and cancellation as
a losing branch of a race must stop the wait and remove its abort listener.
The enclosing scope closes under the existing finalizer rules. Without a
cancellation source, the task remains pending. It produces no success value
or typed failure; interruption is still represented by the runtime cause.

Distinguish the existing race contracts when documenting this primitive:

| Composition | Expected behavior |
| --- | --- |
| `race(never(), ok(value))` | Return the success after interrupting and cleaning up the pending branch |
| `race(never(), err(error))` | Keep waiting for a success until externally interrupted |
| `raceFirst(never(), err(error))` | Return the failure after interrupting and cleaning up the pending branch |

These examples use the corresponding `ResultTask` static methods. `never()`
must not change `race` from first-success to first-completion semantics.

Test two concurrent executions with independent cancellation, a pre-aborted
signal, and a scoped resource released when interruption ends the wait.
Exercise all three race cases, explicit fiber interruption, and preservation
of the abort reason. Use barriers and explicit cancellation to terminate
pending test executions. Verify the listener is removed when the wait ends,
including repeated runs, and cleanup failures retain existing cause behavior.
Add a compile-time assertion for `ResultTask<never, never, never>` and verify
composition does not widen success, error, or requirement types.

Prefer implementing the primitive through the existing empty `fromCallback`
subscription if it satisfies these contracts. No separate scheduler or
additional lifecycle abstraction is required by this proposal.

## Delivery

1. Resolve the acquisition-composition boundary and failure-precedence contract
   before landing the resource correction. Convert the accepted cases into
   focused regression tests and document remaining ownership limits.
2. Land the checker correction independently with native fixtures. It need not
   wait for the resource design decision.
3. Add `never()` independently after accepting its signature, with runtime and
   type tests, an executable example, and a generated API inventory entry.

Every behavior change needs a changeset and the validation required by
`AGENTS.md`. After public API or recipe changes, build and regenerate the docs.
Track implementation, validation, and release separately; existing callback, scope-checking,
and Hono APIs are not pending deliverables of this RFC.

## Implementation decision and evidence (2026-11-14)

Ownership must be registered directly around the operation producing the resource, before
`map`, `andThen`, or generator composition. Arbitrary acquisition composition is not masked from
interruption. The six adapter/shape regressions explicitly retain the unsupported inner identity
composition cases (zero releases), and verify direct acquisition plus the ownership-before-composition
migration. This deliberately does not claim to repair every acquisition leak.

The bridge returns late success to the owner and leaves interruption to the next composition/runner
boundary; late typed errors still become interruption and thrown/rejected defects retain precedence.
No new runtime context, scheduler, deduplication or detach behavior was introduced.

`never()` delegates to the existing empty `fromCallback` subscription. `catchCause` is excluded from
`no-useless-recovery`'s typed-channel reachability inference; other recovery methods retain the check.

- Runtime/type regressions: [rfc-0006.test.ts](../../packages/resultar/tests/rfc-0006.test.ts),
  plus the updated internal bridge assertion in [coverage tests](../../packages/resultar/tests/result-task-coverage.test.ts).
- Native checker regression: `TestCauseRecoveryDoesNotRequireTypedFailures` in
  [rfc0004_test.go](../../packages/check/native/internal/analyzer/rfc0004_test.go) covers instance,
  static, standalone pipe and instance pipe calls, with eight typed-only controls.
- Public usage and limits: [core guide](../../packages/resultar/README.md#cancellation-during-acquisition).
- Executable lifecycle recipe: `holdResource` in [contracts.mts](../../skills/resultar/examples/contracts.mts).
- Release tracking: separate changesets for late acquisition cleanup, cause recovery diagnostics,
  and `never()`. Publication remains pending.

Validation passed: `pnpm run check:full`, `pnpm run build`, `pnpm run smoke:package`,
`pnpm run test:examples`, `pnpm run test:docs`, and `pnpm run test:agents`.
Generated API inventory and recipes were refreshed after build. Core coverage includes 1,103
passing tests (29 new RFC 0006 regressions); the native checker regression and 11 executable
documentation tests passed. Agent checks validate graders only, not model performance.
