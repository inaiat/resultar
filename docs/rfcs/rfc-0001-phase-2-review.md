# Phase 2 Review — RFC 0001: ResultTask

- **Update:** 2026-09-07, after resolution and validation of the open tasks.
- **Reference:** [RFC 0001](./rfc-0001-result-task-core.md).
- **Scope:** [Phase 2 Specification](./rfc-0001-phase-2-done.md).
- **Status:** Closed — all fixes confirmed and validated.
- **Conclusion:** tasks F2-R1 and F2-R2 were implemented and verified with type, execution, and regression tests.
- **Nature:** review and tracking record with completed validation.

## State of the four original findings

| Original finding | State after the second review | Evidence and pending items |
| :--- | :--- | :--- |
| P1 — curried provideServices dropped unsatisfied requirements | Fixed | Type-level validation with `IncompatibleProvidedServices` rejects incompatible providers in `.pipe(...)` (F2-R1). Partial providers preserve $R$ and work once completed. |
| P2 — inconsistent nominal validation | Fixed | Objects without the brand are rejected, legitimate DI tokens are accepted, and yieldable envelopes without the brand are rejected. |
| P2 — provideService rejected legitimate undefined | Fixed | Dispatch uses arity, accepts undefined, and distinguishes a missing argument. |
| P2 — missing curried resolver | Fixed | Curried overload implemented with full $E$ and $R$ inference via `ResolverError` and `ResolverRequirements`, rejecting incompatible contracts via `IncompatibleResolvedServices` (F2-R2). |

## Confirmed fixes

### Nominal validation

`isServiceTag` checks the `ServiceTagTypeId` brand, the discriminator, identifier, key, and iterator.
The guard accepts objects and functions, including tokens created by `resultar-di.service(...)`.
In the reproduction, the object `{ _tag: 'ServiceTag', identifier: 'Clock' }` now returns false,
while a real DI token returned true.

`isResultTaskYield` and `isServiceYield` now check `ResultTaskYieldTypeId`. The reproduction
with an unbranded envelope returned `Die` with the message `ResultTask.gen yielded an unsupported value`.

### Undefined value in provideService

Dispatch now distinguishes calls by argument count (`arguments.length`). Providing
undefined was confirmed at runtime. The added tests cover instance,
data-first, and curried forms, unions with undefined, and genuinely omitted arguments.

## Resolved tasks

### F2-R1 — P1: reject an incompatible provider when applied to the task

- [x] **Completed**
- **Location:** curried overload and implementation of `ResultTask.provideServices`, in
  [result-task.ts](../../packages/resultar/src/result-task.ts).
- **Problem:** preserving the requirement R was not enough when the incompatible provider kept being
  installed and overwrote the correct service received at the execution boundary.
- **Solution:** Added the type helper `IncompatibleProvidedServices<R, Services>`. When a provider
  has a key matching a tag in $R$ but the provided type does not extend `ServiceForTag<Tag>`,
  the `task` parameter type in the curried function collapses to `never`. That way, TypeScript rejects
  the application via `.pipe(...)` both for reusable providers and for direct calls in pipe.
  At the same time, missing keys stay preserved in $R$ without wrongly erroring on legitimate
  partial providers.

#### Acceptance criteria met

- [x] `workflow.pipe(provideWrong)` produces a type error, even with the provider created separately.
- [x] The same incompatible contract is rejected when the provider appears directly in pipe.
- [x] Legitimate empty/partial providers keep the requirements that were not provided.
- [x] Completing a partial provider with the correct services at execution time works.
- [x] Compatible providers eliminate only the satisfied requirements, preserving scope requirements.
- [x] Tests verify that the valid service used in the execution case is not replaced by an incompatible value accepted by the types.
- [x] Negative and positive fixtures pass under strict type checking and in the test suite.

### F2-R2 — P2: infer errors and external requirements in the curried resolver

- [x] **Completed**
- **Location:** curried overload of `ResultTask.provideServiceResolver`, in
  [result-task.ts](../../packages/resultar/src/result-task.ts).
- **Problem:** the defaults `ResolverE = never` and `ResolverR = never` constrained providers before
  inferring the effectively returned channels.
- **Solution:**
  1. Added a dedicated overload in `ResultTask.succeed<A>(value: A): ResultTask<A, never>` to avoid
     improper contextual inference of `E = unknown` when used in resolvers with a generic return.
  2. Implemented curried `provideServiceResolver` with $E$ and $R$ channel inference via
     `ResolverError<Resolvers>` and `ResolverRequirements<Resolvers>`.
  3. Added the type helper `IncompatibleResolvedServices<R, Resolvers>` to reject resolvers
     whose returned type is incompatible with the corresponding service contract in $R$.

#### Acceptance criteria met

- [x] A resolver returning `ResultTask.fail('offline' as const)` is accepted without explicit generics.
- [x] Applied to the Clock workflow above, the result infers `ResultTask<number, 'offline', never>`.
- [x] A resolver depending on External is accepted and keeps External in the R of the resulting task.
- [x] Providers with different errors and requirements preserve the respective unions.
- [x] Scope requirements of providers with resources are not erased.
- [x] Verify both direct use in pipe and the stored resolver for reuse.
- [x] Incompatible contracts do not produce a task that looks executable without its dependencies.
- [x] Run the success, typed failure, and satisfied external dependency cases, plus the type fixtures.

## Validation evidence

- **Dedicated Phase 2 tests:** `packages/resultar/tests/result-task-phase2.test.ts` (26 passing tests).
  - Nominal validation of `ServiceTag` and yieldables.
  - Explicit `undefined` support in `provideService`.
  - Compile-time rejection of incompatible providers via `IncompatibleProvidedServices`.
  - Compile-time rejection of incompatible resolvers via `IncompatibleResolvedServices`.
  - Curried inference of errors and external requirements in `provideServiceResolver`.
  - Preservation of scope requirements and combination of multiple resolvers.
- **Static check and linter:** `pnpm run check:full` run successfully across the whole monorepo (0 type errors, 0 lint errors, 0 formatting errors).
- **Full test suite:**
  - `packages/resultar`: 28 test files, 555 passing tests.
  - `packages/di`: 6 test files, 56 passing tests.
- **Smoke and packaging:** `pnpm run smoke:package` run and approved on all packages (`resultar`, `di`, `request`, `request-typebox`, `request-zod`, `hono`).
- **Examples and integrations:** `pnpm run test:examples` run and approved on all integrated examples.

## Closing conclusion

With all pending items resolved, types statically validated, and the test suite 100% green, the Phase 2 review is formally **Closed**.
