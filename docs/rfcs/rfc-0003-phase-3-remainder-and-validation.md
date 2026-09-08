# RFC 0003: Phase 3 remainder, live lifecycle validation, and dependency health

- Status: Draft
- Date: 2026-09-07
- Scope: `resultar` package
- Source: open items of the former `packages/resultar/TASKS.md` (removed 2026-09-07; done items archived in the Appendix below)
- References: [RFC 0001](./rfc-0001-result-task-core.md)

## Summary

The former `TASKS.md` was 14/18 checked. Everything checked stays done and is out of scope here.
This RFC specifies the 4 open items only:

1. Live private-consumer lifecycle validation (database + session provider) before production adoption.
2. Phase 3 remainder: child fibers, structured `race`/`timeout`, cancellation tests.
3. Vitest / `@vitest/coverage-v8` version-mismatch fix.
4. Coverage re-run with recorded numbers after the alignment.

## Non-goals

- No Phase 4 (`Schedule`, retry, `all`/`forEach`) and no Phase 5 (cookbook, Effect benchmarks, `request-*` migration, next-major decision). Those are untracked elsewhere, not smuggled in here.
- No `Layer`, container, or lifetime redesign (confirmed out in RFC 0001 and the composition-root note).
- No coverage thresholds before the mismatch is resolved (per TASKS ordering).

## 1. Live lifecycle validation (P0)

Context: `examples/resultar/src/application-lifecycle.ts` plus the linked private-consumer
pilot already cover boot rollback, SSE, cancellation, and the Node HTTP adapter on real
local ports. Pending per RFC 0001 § Scope and resources: live database and session-provider
validation, with the scope covering the whole server lifetime, not just creation.

### Acceptance

- [ ] Boot against a live database: failure rolls back already-acquired resources in LIFO order.
- [ ] Shutdown order HTTP → session → database observed against live sessions.
- [ ] SSE/cancellation exercised against a live session; no loser left ownerless.
- [ ] Scope lifetime covers server serve loop, not only construction.
- [ ] Go/no-go for production adoption recorded (pass or blocking findings).

### Test strategy

Manual pilot against live sessions; findings that reproduce locally become regression
tests in `packages/resultar/tests/`. No mocks standing in for the live check.

## 2. Phase 3 remainder: fibers, race, timeout (P0)

RFC 0001 exit criterion: no race or timeout loser left ownerless; finalizers run in all
exit states. Already delivered (resource slice, 2026-09-05): root scope per execution,
`scoped`, `acquireRelease`, awaited LIFO finalizers shielded from the interruption
signal, `Cause.Sequential`/`Interrupt`. Still missing: `Fiber`, `forkChild`/`join`/
`interrupt`, `race` and `timeout` over fibers, `Cause.Parallel`, scheduler involvement
only as needed.

### Proposed API (from RFC 0001, unchanged)

```ts
ResultTask.forkChild(task)
Fiber.join(fiber)
Fiber.interrupt(fiber)
ResultTask.race(left, right)
ResultTask.timeout(task, duration, onTimeout)
```

### Rules (from RFC 0001, normative here)

- Child fibers belong to the parent scope; closing the scope interrupts still-active children.
- `race` interrupts losers and awaits their finalizers; `timeout` is a specialized race.
- No preemptive cancellation of sync JavaScript is promised; external integration stays cooperative via `AbortSignal`.

### Acceptance

- [ ] `timeout` interrupts the task and awaits finalizers (success, `Err`, defect, and interrupt paths).
- [ ] `race` interrupts all losers and awaits their finalizers; winner value preserved.
- [ ] Parent interruption reaches children; scope close awaits children.
- [ ] Release-exactly-once and LIFO order hold under race/timeout (extends resource-slice guarantees).
- [ ] `runExit` preserves composite causes (`Sequential`; `Parallel` if introduced); `runResult` policy documented for the new paths.
- [ ] Cancellation tests per RFC 0001 test strategy (timeout/race/parent-interrupt).

## 3. Vitest / coverage alignment (P1)

Symptom per TASKS: `pnpm run check:full` warns that mixed Vitest and
`@vitest/coverage-v8` versions are loaded. Note: `pnpm-workspace.yaml` catalog
already pins both to `4.1.11`, so the mismatch likely comes from resolved
duplicates (stale lockfile entries or the `vp test` wrapper resolving its own
bundled Vitest), not from the declared range.

### Acceptance

- [ ] `pnpm why vitest` / lockfile inspection identifies the duplicate source.
- [ ] Dedupe + reinstall so `check:full` emits no mixed-version warning.
- [ ] `packages/resultar` `check:full` green after alignment.

## 4. Coverage re-run (P1, after §3)

- [ ] Record new coverage numbers in the delivery PR/notes.
- [ ] Add thresholds only after the warning is gone and numbers are stable.

## Validation

```sh
pnpm run check:full
pnpm run build
```

Plus targeted tests for §2 and regression tests for any reproducible §1 finding.

## Delivery

1. §3 → §4 (dependency health, no behavior change).
2. §2 (core behavior, focused runtime + cancellation + type tests).
3. §1 (live pilot; blocks production adoption, not releases).

## Appendix: completed TASKS items (Done, archived 2026-09-07)

Transcribed from `packages/resultar/TASKS.md` before its removal. Source of truth
for what was already done; this RFC tracks only the 4 open items above.

### P0 - Safety (done)

- [x] Resource slice of RFC 0001 Phase 3: root/child scopes, `acquireRelease`,
  LIFO awaited finalizers, deferred release error inference, preserved sequential causes.
- [x] Runnable application lifecycle example with boot rollback and HTTP-first shutdown.
- [x] Linked build integrated into a private consumer lifecycle; real Node HTTP adapter tested locally.
- [x] No-discard protection for `Result` and `ResultAsync` (`void` as explicit-ignore convention;
  local rule vs shared config vs helper decided at implementation).
- [x] Accidental note file under `src/` removed, useful content preserved.

### P1 - Release Reliability (done)

- [x] CI for the main validation path (`pnpm run check:full`, `pnpm run build`).
- [x] Package smoke checks (built `dist` imports, publish surface, `npm pack --dry-run` equivalent).
- [x] Publish workflows reviewed (no publish from ordinary branch pushes; npm/JSR tied to
  explicit release triggers, tags, or protected branches).

### P2 - API Cleanup (done)

- [x] `safeTryAsync` policy decided: deprecated export removed before the current major line.
- [x] Node 24-only support confirmed intentional; `Promise.try` kept in `ResultAsync.tryCatch`.
- [x] Cleanup API replaced with Node.js 24 disposal semantics (`log` for best-effort observation;
  `toDisposable` / `toAsyncDisposable` for `using` / `await using`).

### P2 - Maintainability (done)

- [x] TypeScript strictness: `erasableSyntaxOnly`, `exactOptionalPropertyTypes`,
  `isolatedDeclarations`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`,
  unchecked side-effect imports check, public API guard test.
- [x] Broad lint exceptions tightened (unsafe assertions, deprecated APIs, explicit `any`;
  necessary public type-level exceptions kept).
- [x] Duplicated tagged-error matching between `Result` and `ResultAsync` reduced via shared
  runtime helpers, public API and inference unchanged, focused runtime + type tests.
