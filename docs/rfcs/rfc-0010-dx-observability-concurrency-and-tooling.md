# RFC 0010: Core DX, lean concurrency, opt-in observability, subpath tree-shaking, and tooling

- Status: Implemented (Validated; Awaiting Release)
- Date: 2026-11-19
- Target packages: `resultar`, `resultar-app`, `resultar-check`, and library package manifests (`resultar-config`, `resultar-di`, `resultar-fastify`, `resultar-hono`, `resultar-nestjs`, `resultar-request`, `resultar-request-typebox`, `resultar-request-zod`)
- References: [RFC 0001](./rfc-0001-result-task-core.md), [RFC 0004](./rfc-0004-effect-v4-ergonomics-and-tooling.md), [RFC 0006](./rfc-0006-task-cancellation-and-recovery.md), [RFC 0009](./rfc-0009-inference-scopes-and-application-lifecycle.md)

## Summary

Close the remaining developer-experience, observability, concurrency, packaging, tooling,
and documentation gaps relative to Effect core while preserving Resultar's lean,
zero-ceremony architecture and strict v4 compatibility guarantees.

This RFC covers six coordinated workstreams:

1. **Core ergonomics and API symmetries**: remove static/instance asymmetries (`scoped`,
   `forkChild`, `FiberHandle.await`), add `ResultTask.suspend`, `repeat`, `raceAll`,
   `raceFirstAll`, `runSync` / `runSyncExit`, `Cause` constructors and `isInterruptedOnly`,
   richer `ResultTaskCauseError` formatting, `Retry.policy` caps and error-aware delays,
   and `VirtualClock` auto-advancing test helpers.
2. **Subpath exports and side-effect-free packaging**: mark all JS library packages
   `"sideEffects": false` and publish clean public-only subpath entry points (`resultar/result`,
   `resultar/task`, `resultar/match`, `resultar/tagged`, `resultar/retry`, `resultar/function`).
3. **Lean concurrency primitives**: add interruption-safe `Ref`, `Deferred`, and bounded/unbounded
   `Queue` with FIFO backpressure and lossless shutdown draining.
4. **Opt-in zero-overhead observability**: add fiber-inherited `TaskLocal`, opt-in `Tracer`
   (`Tracer.noop` default, `Tracer.memory()`, custom `TaskTracer`), `withSpan`, named
   `ResultTask.fn(spanName, body, ...pipes)`, and span traces attached to failure `Cause` values.
5. **Native tooling upgrades (`resultar-check`)**: add safe `--fix` / `--fix-dry-run`
   (applying only `kind: "correction"` edits, never `intentional-discard`) and multi-editor
   `init` / `doctor` (`--editor zed|vscode|cursor|all`).
6. **Documentation hygiene and automated drift prevention**: add `docs/coming-from-effect.md`,
   eliminate stale counts/append-after-license drift, enrich core JSDoc + `@example` blocks,
   and enforce documentation invariants automatically in `scripts/test-documentation.mjs`.

The proposal below is preserved as design history. Public package documentation and
generated declarations remain authoritative for delivered APIs.

## Implementation record — 2026-11-19

| Workstream | Delivered evidence |
| --- | --- |
| Core ergonomics, retry/repeat, cause, virtual clock | Implemented across [result-task.ts](../../packages/resultar/src/task/result-task.ts), [task-helpers.ts](../../packages/resultar/src/task/task-helpers.ts), [cause.ts](../../packages/resultar/src/task/cause.ts), [fiber.ts](../../packages/resultar/src/task/fiber.ts), [fiber-runtime.ts](../../packages/resultar/src/task/fiber-runtime.ts), [retry.ts](../../packages/resultar/src/core/retry.ts), [result-async.ts](../../packages/resultar/src/result-async/result-async.ts), and [task-clock.ts](../../packages/resultar/src/task/task-clock.ts). Covered by [dx-ergonomics.test.ts](../../packages/resultar/tests/dx-ergonomics.test.ts). |
| Subpath exports & `"sideEffects": false` | Public-only barrels in [packages/resultar/src/entries/](../../packages/resultar/src/entries/result.ts), WeakMap bridge in [task-runtime-bridge.ts](../../packages/resultar/src/task/task-runtime-bridge.ts), `exports`/`sideEffects` in [packages/resultar/package.json](../../packages/resultar/package.json), [packages/resultar/jsr.json](../../packages/resultar/jsr.json), [packages/resultar/vite.config.ts](../../packages/resultar/vite.config.ts), and `"sideEffects": false` across all 9 companion library packages. Verified via [smoke-package.ts](../../packages/resultar/scripts/smoke-package.ts) and [public-api.test.ts](../../packages/resultar/tests/public-api.test.ts). |
| Lean concurrency primitives | Implemented in [ref.ts](../../packages/resultar/src/task/ref.ts), [deferred.ts](../../packages/resultar/src/task/deferred.ts), and [queue.ts](../../packages/resultar/src/task/queue.ts); re-exported by `resultar`, `resultar/task`, and `resultar-app`. Covered by [concurrency-primitives.test.ts](../../packages/resultar/tests/concurrency-primitives.test.ts). |
| Opt-in observability | Implemented in [task-local.ts](../../packages/resultar/src/task/task-local.ts), [tracer.ts](../../packages/resultar/src/task/tracer.ts), [task-service.ts](../../packages/resultar/src/task/task-service.ts), [cause.ts](../../packages/resultar/src/task/cause.ts), and [result-task.ts](../../packages/resultar/src/task/result-task.ts). Covered by [observability.test.ts](../../packages/resultar/tests/observability.test.ts). |
| Native checker `--fix` & multi-editor setup | Safe multi-pass autofix in [fix.go](../../packages/check/native/cmd/resultar-check/fix.go) and [main.go](../../packages/check/native/cmd/resultar-check/main.go) with Go tests in [fix_test.go](../../packages/check/native/cmd/resultar-check/fix_test.go). Multi-editor `init`/`doctor` (`zed`, `vscode`, `cursor`, `all`, including `.vscode/tasks.json`, `.vscode/extensions.json`, and `.cursor/rules/resultar-check.mdc`) in [setup.ts](../../packages/check/src/setup.ts) with tests in [setup.test.ts](../../packages/check/scripts/setup.test.ts). |
| Official VS Code & Cursor LSP extension | Zero-runtime-dependency extension in [editors/vscode/](../../editors/vscode/README.md) (`dist/extension.cjs`, ~6.6 kB gz) bridging native `resultar-check lsp` for live unsaved-buffer diagnostics, inline `T / E / R` channel hover, preferred correction quickfixes vs opt-in `intentional-discard`, and `--fix` / `overview` commands. Verified with unit + real native Go LSP integration tests in [lsp-client.test.ts](../../editors/vscode/tests/lsp-client.test.ts) and [extension.test.ts](../../editors/vscode/tests/extension.test.ts). |
| Searchable docs portal & live playground | Single-source-of-truth static site in [website/](../../website/index.html) generated directly from repository Markdown (28 code-split pages, 42 rules, 972 search entries, Cmd+K instant search, Light/Dark themes) plus a zero-backend browser playground running real bundled `resultar` with 6 curated presets, shareable hash URLs, and visual `Tracer.memory()` span waterfalls. Verified by [content.test.ts](../../website/tests/content.test.ts) and [playground.test.ts](../../website/tests/playground.test.ts); Pages deploy workflow in [.github/workflows/docs.yaml](../../.github/workflows/docs.yaml). |
| Docs hygiene, Effect guide & drift checks | Added [docs/coming-from-effect.md](../coming-from-effect.md), updated [README.md](../../README.md), [DOCUMENTATION.md](../../DOCUMENTATION.md), [llms.txt](../../llms.txt), package READMEs, [skills/resultar/](../../skills/resultar/SKILL.md), and core JSDoc `@example` blocks; regenerated [docs/api-inventory.md](../api-inventory.md); added automated drift assertions to [scripts/test-documentation.mjs](../../scripts/test-documentation.mjs). |

Implementation and publication are separate: [.changeset/dx-docs-observability-tooling.md](../../.changeset/dx-docs-observability-tooling.md)
and regenerated documentation artifacts are included; no registry publication has been performed.

## 1. Baseline and motivation

Prior to this RFC, Resultar already delivered a strong typed core (`Result`, `ResultTask`,
`ResultAsync`, `createTaggedError`, `Match`, `Cause`, `Fiber`, `Semaphore`, `Retry.policy`,
`Clock.virtual`, `resultar-di`, `resultar-config`, and the native TypeScript-Go `resultar-check`
analyzer). Auditing day-to-day DX and documentation against Effect core v4 revealed concrete
friction points:

- **API asymmetries and missing high-leverage primitives**:
  - `ResultTask.scoped(task)` and `ResultTask.forkChild(task)` lacked instance methods,
    `Fiber.await(handle)` lacked `handle.await()`, and `race`/`raceFirst` accepted only two tasks
    rather than an array (`raceAll`/`raceFirstAll`).
  - Synchronous-only tasks had no `runSync` / `runSyncExit`, deferred construction had no
    `ResultTask.suspend`, periodic polling had no `repeat`, and `Cause` lacked public constructors
    (`fail`, `die`, `interrupt`, `sequential`, `parallel`) and `isInterruptedOnly`.
  - `Retry.policy` lacked `maxDelayMs`, `maxElapsedMs`, and error-aware `delayMs(ctx, error)`.
  - `VirtualClock` required manual `advanceBy` loops instead of `advanceToNext()` / `runToCompletion()`.
  - `ResultTaskCauseError` printed a generic message without rendering `Cause.pretty(cause)`.
- **No lightweight coordination or opt-in observability**:
  - Teams writing concurrent workers had `Semaphore` and `Fiber`, but no `Ref`, `Deferred`, or
    backpressured `Queue`.
  - There was no fiber-inherited ambient state (`TaskLocal`) and no opt-in tracing/span
    propagation (`Tracer`, `withSpan`, named `ResultTask.fn`) for debugging production failures.
- **Bundle granularity**:
  - Library packages did not declare `"sideEffects": false`, and `resultar` exposed only a single
    root entry point rather than focused subpaths.
- **Tooling ergonomics**:
  - `resultar-check` already computed safe `kind: "correction"` quickfixes for LSP and `quickfixes`,
    but had no CLI `--fix` flag to apply them automatically.
  - `resultar-check init` and `doctor` targeted only Zed, leaving VS Code and Cursor users to wire
    tasks and agent rules manually.
- **Documentation drift**:
  - Multiple READMEs and `DOCUMENTATION.md` had addenda appended after `## License`; `llms.txt`
    had a section appended after `## Freshness rule` and omitted `resultar-app` and
    `resultar-config`; several docs still cited `41` rules instead of `42`, documented
    `err.fingerprint` as a string rather than a `[tag, template]` tuple, or listed a nonexistent
    `VirtualClock.advance` method; and there was no dedicated Effect migration map.

## 2. Core ergonomics, retry/repeat, cause, and virtual clock

### Design decisions

- **Symmetry without breaking v4**:
  - Add instance `task.scoped()`, `task.forkChild()`, and `fiber.await()` delegating to the
    existing static operations.
  - Add `ResultTask.suspend(factory)` to defer task construction until execution.
  - Add `ResultTask.raceAll(tasks)` (first success) and `ResultTask.raceFirstAll(tasks)` (first
    settlement), interrupting losers and awaiting their scope cleanup.
  - Add `task.runSync(options?)` / `task.runSyncExit(options?)` (plus static forms) executing
    purely synchronous graphs immediately without allocating a `Promise`: `runSync` returns
    `Result<A, E | ScopeError<R>>` (throwing an `Error` if an asynchronous step is reached, or on
    defects, interruption, or composite causes, matching `runResult`), while `runSyncExit` returns
    `Exit<A, E | ScopeError<R>>` (throwing only if an asynchronous step is reached).
- **Retry and repeat**:
  - Extend `RetryPolicyOptions<E>` with `maxDelayMs?: number`, `maxElapsedMs?: number`, and
    `delayMs?: number | ((context: RetryContext, error: E) => number)`.
  - Preserve the existing v4 retry hook execution order (`attempt -> release -> while -> onRetry -> delay -> sleep`)
    across both `ResultTask` and `ResultAsync`.
  - Add `task.repeat(options)` and static/curried `ResultTask.repeat(...)` supporting `times`,
    `delayMs`, `backoff`, `maxDelayMs`, `maxElapsedMs`, `jittered`, `while`, `until`, and `onRepeat`.
- **Cause constructors and error diagnostics**:
  - Expose `Cause.fail`, `Cause.die`, `Cause.interrupt`, `Cause.sequential`, `Cause.parallel`,
    `Cause.isInterruptedOnly`, and `Cause.spans`.
  - Enrich `ResultTaskCauseError` with `Cause.pretty(cause)` in its message, a `.prettyCause`
    getter, and a `Symbol.for('nodejs.util.inspect.custom')` prototype method defined inside a
    `static {}` block (preserving `--isolatedDeclarations` compatibility).
- **VirtualClock test ergonomics**:
  - Add `advanceToNext(): Promise<boolean>` to step directly to the next scheduled timer.
  - Add `runToCompletion(task, { maxSteps? })` to drive multi-step sleeps, retries, and repeats
    deterministically without manual ticking while guarding against infinite loops (`maxSteps`
    default `10_000`).

## 3. Subpath exports and side-effect-free packaging

### Design decisions

- Add `"sideEffects": false` to `packages/resultar/package.json` and all 9 companion JS library
  packages (`app`, `config`, `di`, `fastify`, `hono`, `nestjs`, `request`, `request-typebox`,
  `request-zod`).
- Expose six focused public-only subpath barrels under `packages/resultar/src/entries/`:
  - `resultar/result`
  - `resultar/task`
  - `resultar/match`
  - `resultar/tagged`
  - `resultar/retry`
  - `resultar/function`
- **Public-only barrels**: Subpaths re-export exclusively public APIs (never internal helpers like
  `validateRetryPolicy` or `stringifyRedacted`) so `.d.ts` files stay clean and minimal.
- **Tree-shaking-safe runtime bridge**: Modules such as `Deferred`, `Queue`, `Ref`, and `TaskLocal`
  need to instantiate `ResultTask` without triggering circular module evaluation or top-level side
  effects that bundlers could strip under `"sideEffects": false`. `ResultTask` registers its
  constructors in a `WeakMap` inside `static {}` via `task-runtime-bridge.ts` keyed by `ResultTask`
  itself, and also installs `ResultTask.prototype.pipe` and `[ResultTaskTypeId]` inside `static {}`.

## 4. Lean concurrency primitives (`Ref`, `Deferred`, `Queue`)

### Design decisions

- **`Ref.make<A>(initial)`**:
  - Synchronous-atomic state container exposing lazy `ResultTask` operations: `get`, `set`,
    `update`, `updateAndGet`, `getAndUpdate`, `getAndSet`, `modify`.
- **`Deferred.make<A, E>()`**:
  - One-shot asynchronous synchronization exposing `await`, `succeed`, `fail`, `die`, `done`,
    `complete`, `poll`, `isDone`.
  - First settlement wins (`succeed`/`fail`/`die`/`done` return `boolean`); interrupted `await`
    waiters remove their listener cleanly without leaking memory.
- **`Queue.bounded<A>(capacity)` and `Queue.unbounded<A>()`**:
  - FIFO queue exposing `capacity`, `offer`, `offerAll`, `take`, `poll`, `takeAll`, `takeUpTo`,
    `shutdown`, `size`, `isShutdown`.
  - Bounded `offer` suspends when full and wakes producers in FIFO order as items are taken;
    interrupted `offer` or `take` waiters detach cleanly.
  - **Lossless shutdown**: `shutdown` rejects new offers (`false`), interrupts blocked producers,
    allows consumers to drain already-buffered items, and interrupts takers once empty.

## 5. Opt-in zero-overhead observability (`TaskLocal`, `Tracer`, `withSpan`, named `fn`)

### Design decisions

- **Zero overhead by default**:
  - `Tracer.noop` is the default when `{ tracer }` is omitted. Tasks that do not invoke `withSpan`
    or named `ResultTask.fn` allocate zero span frames. When `withSpan` or named `fn` is used
    without `{ tracer }`, lightweight singly-linked `SpanStackNode` frames are still tracked on
    `ResultTaskRuntimeContext` so failure `Cause` values carry logical span traces without invoking
    any external tracer callbacks.
- **`TaskLocal.make<A>(defaultValue, name?)`**:
  - Fiber-inherited ambient context stored in an optional `locals` cell on `ResultTaskRuntimeContext`.
  - `locally(value, task)` and `locallyWith(fn, task)` (both data-first and curried) restore the
    prior binding on completion, typed failure, defect, or interruption.
  - `withChildScope` clones the active locals map so `forkChild`, `all`, and `race` inherit
    parent values while isolating mutations between parent and child fibers.
- **`Tracer` and `withSpan` / named `ResultTask.fn`**:
  - `Tracer.memory()` returns a `MemoryTracer` implementing `TaskTracer` directly (usable as
    `{ tracer: memory }` or `{ tracer: memory.tracer }`) recording `name`, `parentName`,
    `attributes`, `startTime`, `endTime`, `durationMs`, and final `exit`.
  - `task.withSpan(name, attributes?)`, static/curried `ResultTask.withSpan`, and named
    `ResultTask.fn(spanName, body, ...pipes)` (0–4 pipe stages) wrap execution in a span; tracer
    callbacks (`startSpan` / `end`) are isolated in `try/catch` so telemetry errors never alter
    task outcomes.
  - On failure, active span frames (innermost-first) are attached to the `Cause` via a `WeakMap`
    (preserving structural equality and serialization) and surfaced by `Cause.spans(cause)` and
    `Cause.pretty(cause)`.

## 6. Native checker autofix and multi-editor setup (`resultar-check`)

### Design decisions

- **Safe CLI autofix (`--fix` and `--fix-dry-run`)**:
  - Filter fixes strictly to `fix.Kind == analyzer.FixCorrection`. Fixes marked
    `kind: "intentional-discard"` (such as prepending `void ` to silence `no-discard`) are
    **never** auto-applied.
  - Validate edit bounds, skip conflicting/overlapping intervals deterministically, apply edits in
    reverse byte-offset order per file, and iterate up to 5 passes until convergence (stopping
    immediately if TypeScript diagnostics appear).
  - Support `--file <path>` filtering alongside `--fix` / `--fix-dry-run`.
  - Write human fix summaries to `stderr` so `--json`, `--format sarif`, and `--format junit`
    remain valid machine-readable output on `stdout`.
  - Re-analyze after writing so the process exit code reflects post-fix remaining diagnostics.
- **Multi-editor `init` and `doctor` (`--editor zed|vscode|cursor|all`)**:
  - Keep `--editor zed` as the default for full backwards compatibility.
  - `vscode` and `cursor` write/merge `.vscode/tasks.json` (preserving unrelated user tasks on
    `--force`) with `resultar-check` and `resultar-check: fix` tasks backed by a `problemMatcher`
    matching the exact CLI format (`file:line:col resultar/rule (severity) - message`).
  - `cursor` additionally scaffolds `.cursor/rules/resultar-check.mdc` for Cursor AI workflows.
  - `all` configures and validates Zed, VS Code/Cursor tasks, and Cursor rules together.

## 7. Documentation hygiene, Effect migration guide, and drift prevention

- Add [docs/coming-from-effect.md](../coming-from-effect.md) with a factual Effect → Resultar
  API table, end-to-end typed workflow example, and explicit deliberate omissions; bundle it into
  `packages/resultar/dist/agent/` and `dist/llms.txt`.
- Fix all audited drifts (`err.fingerprint` tuple, rule count `42`, `VirtualClock` methods,
  missing `resultar-app` / `resultar-config` / `resultar-request-*` in `llms.txt`, stray sections
  after `## License` / `## Freshness rule`, outdated negative statements in
  `skills/resultar/references/api.md`, and canonical DI style guidance in `packages/di/README.md`).
- Enrich JSDoc + `@example` blocks on core entry exports (`Result`, `ok`, `err`, `redact`,
  `AbortError`, `serviceTag`, `taggedEnum`, `matchError`, `matchErrorPartial`).
- Harden [scripts/test-documentation.mjs](../../scripts/test-documentation.mjs) with automated
  regression checks:
  1. No documentation file appends headings or extra content after `## License`.
  2. `llms.txt` keeps `## Freshness rule` as its final section.
  3. Every publishable package in `packages/*` is listed in both `README.md` and `llms.txt`.
  4. Every cited rule count across root/package docs and skills matches the actual table in
     `packages/check/README.md` (which itself is verified against `config.go`).

## 8. Non-goals and deliberate omissions

Resultar intentionally does **not** introduce:

- A built-in schema validation library (continue pairing with Zod, TypeBox, Valibot, or ArkType).
- A pull/push stream algebra (`Stream`), Software Transactional Memory (`STM`), or distributed
  cluster/workflow runtime.
- A custom HTTP server framework or mandatory global runtime singleton.
- Removal or semantic changes to any deprecated v4 APIs documented in
  [docs/migrations/v4.md](../migrations/v4.md).

## 9. Validation and acceptance

All workspace verification gates pass on branch `feat/dx-docs-observability-tooling` (re-validated after addressing the review findings tracked in [RFC 0010 and RFC 0011 correction plan](./rfc-0010-0011-fix-plan.md)):

- **Playground security and real-browser verification**:
  - Shared links (`#/playground?code=...`) no longer auto-execute on initial load or `hashchange`; code is loaded into the editor and requires an explicit **Run** click (`⌘/Ctrl+Enter`).
  - Browser execution runs inside an ephemeral `<iframe sandbox="allow-scripts">` (opaque origin `null`, CSP `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval';`) bundled with a self-contained runtime, preventing access to portal DOM, `localStorage`, `sessionStorage`, and cookies.
  - [website/tests/playground-browser.test.ts](../../website/tests/playground-browser.test.ts) serves `website/dist` and drives headless Chrome over CDP to verify manual run gating on direct load and hash navigation, opaque-origin isolation, and all 6 presets (including `retry-virtual-clock` at `1350 ms` virtual elapsed time and `observability` with all 3 spans in the waterfall).
- **Browser-compatible macrotask scheduling**:
  - `VirtualClock.flush()` and `Scheduler.live.yield()` use a shared `scheduleMacrotask` helper (`setImmediate` when available, `setTimeout(..., 0)` + `clearTimeout` fallback in browsers/edge runtimes), preserving FIFO wake order and cancellation without Node-only globals (tested in [packages/resultar/tests/task-scheduler.test.ts](../../packages/resultar/tests/task-scheduler.test.ts)).
- **Queue trace isolation and cancellation cleanup**:
  - `Queue.shutdown()` and closed-queue `take()` construct a fresh `Interrupt` `Cause` per operation so `Cause.spans()` traces never cross-contaminate across queues or concurrent consumers.
  - `Queue` waiters use FIFO `Set`s and immediately unlink and clear payload, callback, and signal references on abort (verified with interleaved FIFO/backpressure tests and `WeakRef` + GC diagnostics in [packages/resultar/tests/concurrency-primitives.test.ts](../../packages/resultar/tests/concurrency-primitives.test.ts)).
- **Workspace gates**:
  - `RESULTAR_JIT=1 pnpm run check:full`
  - `RESULTAR_JIT=0 pnpm run test`
  - `pnpm run build`
  - `pnpm run smoke:package`
  - `pnpm run test:examples`
  - `pnpm run test:docs`
  - `pnpm run test:agents`
  - `pnpm run check:vscode && pnpm run build:vscode && pnpm run test:vscode`
  - `pnpm run test:website` (including real headless Chrome browser test against `website/dist`)
