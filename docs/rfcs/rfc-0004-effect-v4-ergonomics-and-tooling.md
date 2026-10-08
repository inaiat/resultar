# RFC 0004: Functional ergonomics and developer tooling

- Status: In Progress
- Date: 2026-10-06
- Target packages: `resultar`, `resultar-check`, and the checker native packages
- Release: minor releases in the existing 3.x lines
- References: [RFC 0001](./rfc-0001-result-task-core.md), [RFC 0003](./rfc-0003-phase-3-remainder-and-validation.md)

## Summary

Add reusable function composition, generator function wrappers, tagged task recovery,
native disposable acquisition, and tooling that checks the code currently being edited.
Extend the checker's error-channel protection to the requirements channel of
`ResultTask<A, E, R>` so assertions cannot hide services or deferred release errors.

The three delivery phases are implemented in the workspace: functional utilities and
safety diagnostics, task ergonomics, and editor/CLI tooling. The minor releases are
prepared by a changeset; this RFC stays In Progress until publication.

## Scope and compatibility

- Preserve eager `ResultAsync` and lazy, repeatable `ResultTask` execution.
- Reuse the existing task interpreter, nominal yieldable contracts, scopes, and DI.
- Preserve the current `Cause` union and the contracts of `runExit`, `runResult`, and
  `runPromise`; this RFC does not introduce `Cause.Parallel`.
- Keep the native TypeScript-Go checker backend. Do not add a compiler fork, patch,
  Effect runtime dependency, or new editor-specific plugin.
- Publish additive core changes as a 3.x minor. Publish checker additions as an
  independent minor, keeping its native packages in their configured fixed group.
- Do not add compatibility shims or deprecated aliases. Migrate callers of any
  implementation path replaced by these changes.

Fibers, `forkChild`, task `race`/`timeout`, and `Cause.Parallel` are deferred together.
They remain open in RFC 0003, along with its independent live database/session pilot
and dependency-health work. Existing `ResultAsync` concurrency APIs are unaffected.
Task `Schedule`, retry, `all`/`forEach`, tracing, and general async/await migrations
are outside this delivery.

## 1. Function utilities

### Adoption decisions

| Utility | Decision | Reason |
| --- | --- | --- |
| `pipe` | Public root export in phase 1 | Apply a value to reusable transformations. |
| `flow` | Public root export in phase 1 | Compose reusable functions while preserving the first function's arguments. |
| `dual` | Internal helper in phase 1 | Share direct and curried implementations without widening the public API. |
| `identity` | Public root export in phase 1 | Preserve a callback input without an inline lambda. |
| `constant` | Public root export in phase 1 | Provide a fixed callback result or fallback. |
| `memoize` | Deferred | Identify a concrete synchronous computation and its cache contract first. |
| `memoizeIdempotent` | Deferred | Requires a demonstrated idempotent object transformation. |
| `cast`, `hole` | Excluded from the proposed public API | These do not advance the typed workflow contracts targeted here. |

### `pipe` and `flow`

`pipe(value, ...transforms)` accepts zero through eight transformations. With no
transformations it returns the input. Each subsequent function receives the previous
result, and overloads reject incompatible intermediate types.

`flow(first, ...transforms)` accepts one through nine functions. The returned function
preserves the first function's argument tuple, including optional and rest parameters,
and its explicit `this` requirement. Only the first function receives that receiver;
the remaining functions are unary transformations.

Both utilities are synchronous composition: exceptions propagate, and Promises pass
through as ordinary values. They do not execute or await a task automatically.

Share an indexed executor with instance `.pipe()`, avoiding the existing `slice`
allocation. Add the zero-transformation instance overload returning `this`; preserve
the existing one-through-eight overloads and their inference.

### `identity` and `constant`

```ts
export declare function identity<A>(value: A): A
export declare function constant<A>(value: A): () => A
```

`identity` returns its argument unchanged, including object identity. `constant`
captures the supplied value and returns the same value on every call. It does not
copy objects or recompute a factory, and its zero-argument function can serve as a
callback that ignores its input.

For a `Result<string, DomainError>`, a checked documentation example will demonstrate:

```ts
const message = result.match({
  ok: identity,
  error: constant("Unavailable"),
})
```

### Internal `dual`

Use a private helper to share the implementations of the direct and curried forms of
fixed-arity `ResultTask` combinators. Keep explicit public overloads and preserve
argument validation, including existing error messages. APIs with optional arguments
must not be dispatched solely by argument count; retain their existing dispatch or
use a specific predicate.

### Deferred memoization

Effect's `Function.memoize` uses a per-wrapper `WeakMap` keyed by object identity;
mutation of an input does not invalidate its cached result, and `undefined` is not
a supported output. `memoizeIdempotent` also caches each output as a fixed point.
These contracts require separate evaluation before adoption and are distinct from
the existing execution-sharing contract of `ResultTask.memoize`.

## 2. Task ergonomics

### `ResultTask.fn`

Add a generator function wrapper:

```ts
const loadUser = ResultTask.fn(function* (id: string) {
  const repository = yield* UserRepository
  return yield* repository.findById(id)
})
```

The wrapper accepts a synchronous generator body. Calling it captures arguments and
`this` and returns a task without invoking the body. Each task execution creates a
fresh iterator. Infer success, error, and requirements from the same yieldable
contracts as `ResultTask.gen`; preserve concrete parameter tuples and receivers.
Special polymorphic signatures may require explicit annotations.

Delegate execution and generator cleanup to `gen`. Exceptions become `Die`, and the
generator returns its plain success value. Returning a task without `yield*` remains
a nested-success mistake diagnosed by the checker. This first version has no named
tracing, configuration overloads, or post-body transformations.

### `catchTag` and `catchTags`

Add instance methods and direct/curried static forms:

```ts
task.catchTag("NotFound", handleNotFound)
task.catchTags({ NotFound: handleNotFound, Unauthorized: handleUnauthorized })

ResultTask.catchTag(task, "NotFound", handleNotFound)
ResultTask.catchTag("NotFound", handleNotFound)(task)
ResultTask.catchTags(task, handlers)
ResultTask.catchTags(handlers)(task)
```

Handlers return `ResultTask`. Reuse the shared tagged-type and matching contracts to:

- Narrow each handler argument to the selected member of `E`.
- Remove only handled tags from `E`, then add handler errors.
- Union source and handler success types and requirements.
- Preserve pending scope markers and their release errors.
- Reject keys absent from the source error union; allow partial handling.

An unmatched simple `Fail` passes through. `Die` and `Interrupt` do not invoke recovery
handlers. Composite causes follow the existing `catchAll` policy: return
`Die(ResultTaskCauseError)` with the original cause tree retained on `error.cause`.
Handler exceptions become `Die`.

### `acquireDisposable`

Add `ResultTask.acquireDisposable(acquireTask)` for resources implementing `Disposable`
or `AsyncDisposable`. Preserve acquisition success/error/requirements types and add
the scope marker needed to own disposal.

Implement it through `acquireRelease` and the current scope machinery:

- Prefer `Symbol.asyncDispose` when both protocols are present.
- Register disposal only after successful acquisition.
- Run it exactly once, in LIFO order, protected from the interruption signal.
- Await async disposal before closing the scope.
- Convert disposal exceptions or rejections to `Die`, preserving composite cleanup
  behavior rather than inventing a typed domain error.

Existing `Result` and `ResultAsync` disposal APIs retain their current contracts.

## 3. Checker safety

### Requirements channel

The current `hasUnknownOrAnyError` and `resultErrorTypes` helpers inspect type argument
1, `E`. `unsafe-result-type-assertion` compares those extracted error types. Extend
the semantic analysis to type argument 2, `R`, specifically for `ResultTask`.

Add `no-unknown-task-requirements`, configured by `noUnknownTaskRequirements`, with
default severity `suggestion`. Detect `any` or `unknown` requirements, including
aliases, unions, and imported/reexported task types. A genuine `R = never` is valid.

Extend the existing `unsafe-result-type-assertion` rule, keeping its name and default
`warning`, to diagnose assertions that remove a required service or a scope marker.
Preserve the original source type through parenthesized/chained assertions, including
`as unknown as`, so the intermediate type cannot hide the requirement being erased.
Report whether the assertion narrows `E`, `R`, or both.

Legitimate requirement discharge through providers or `scoped` is not an assertion
violation. Include deferred release errors in the scope-marker protection; recovery
before closing a scope must not erase them. Compare semantic types and assignability
rather than relying only on rendered names.

### Unused suppressions

Add `unused-suppression`, configured by `unusedSuppression`, with default severity
`suggestion`. Track suppression use against enabled findings before filtering them
from output.

- Evaluate each rule listed in a directive independently.
- Do not report a disabled rule as unused merely because it was not analyzed.
- Report a wildcard directive when it suppresses no enabled finding.
- Diagnose unknown rule IDs at the directive.
- Offer removal of an unused entry/directive without deleting unrelated comments or
  justification text.

Update configuration parsing, rule metadata, severities, file overrides, and aliases
consistently with existing rules. Preserve `failOn`; its current default is `message`,
so enabled new suggestions can also make the CLI fail. Document this migration impact.

### Generator recognition

Every applicable generator diagnostic must recognize `ResultTask.fn` as well as `gen`.
Resolve actual symbols through aliases, namespaces, and barrels. Preserve checks for
invalid yields, raw await, nested task returns, and scope/lifetime misuse.

## 4. Editor and CLI tooling

### Unsaved buffers

Layer an in-memory filesystem over the current TypeScript-Go project loader. Analyze
all open buffers, including new files covered by project inclusion rules but not yet
written to disk. Keep disk-backed CLI analysis as the empty-overlay case.

Create immutable project snapshots keyed by document versions/content rather than
disk modification time alone. Use one analysis worker per project with a 150 ms
debounce; discard outdated results. Rebuild typed programs against fresh overlay
snapshots to avoid stale filesystem caches.

Handle open, change, save, close, and watched-file events. Reanalyze affected open
documents, including dependents. Closing a buffer restores the disk-backed view and
clears or refreshes its diagnostics. Keep full-text synchronization and use the same
snapshot for diagnostics, hover, and code actions.

### Hover

Show success `T`, error `E`, and requirements `R` separately for `ResultTask`; show
`T`/`E` for `Result` and `ResultAsync`. For service tags, show identifier and service
contract. Render types without truncating error or requirements unions.

Support hover over task expressions and `yield*`: explain the operand's channels and
the success value obtained by delegation. Return no custom hover for unrelated code.
Use UTF-16 ranges and versioned workspace edits to prevent stale actions from applying
to a newer buffer.

### Refactors with preview

Add contextual LSP refactors only where types and syntax establish equivalence:

- Convert `_tag` dispatch inside task recovery into `catchTag`/`catchTags` when
  unmatched branches preserve the original failure and there are no extra effects.
- Combine consecutive `catchTag` calls only for distinct tags and when earlier
  handlers cannot introduce errors handled by later calls.
- Replace a `gen` containing only `return yield* task` with the referenced task only
  when the binding is a stable `const` reference and there is no extra work or cleanup.

Preserve lazy construction, evaluation order, receivers, and cleanup. If equivalence
cannot be established, do not offer the refactor. Retain the distinction between
corrections and intentional discards; `void task` does not execute or recover a task.

### `overview`

```sh
resultar-check overview --project tsconfig.json --format json
```

Inventory exported Resultar workflows/values, tagged errors, and service tags. Resolve
export aliases and barrels, with both export origin and declaration location. Show
the applicable success/error/requirements channels, including generic declarations.

JSON is a document with `schemaVersion: 1` and an `entries` array. Each entry includes
`kind` (`function`, `value`, `error`, or `service`), `name`, `exportedFrom`, declaration
`file`/`line`/`column`, and applicable `channels` (`success`, `error`, `requirements`).
Error/service entries include their statically known tag or identifier and service
contract as applicable. Type channels are rendered strings, not serialized compiler
objects. Sort output deterministically by source location and export name.

### `quickfixes`

```sh
resultar-check quickfixes --project tsconfig.json --format human
```

Preview diagnostic fixes using existing finding/fix metadata. JSON remains JSONL;
human output shows proposed edits. Preserve fix kind, description, and locations.
Contextual refactors remain editor actions rather than being applied by this command.

Both new commands accept `--file`, `--format human|json`, and `--json`. They do not write
files or include an apply flag. Return 0 after valid analysis and 1 when configuration
or compilation prevents analysis; send failure details to stderr. Preserve the
existing default diagnostics command and its JSONL/SARIF/JUnit contracts.

### Configuration schema

Compose the checker schema with the standard SchemaStore `tsconfig` schema through
`allOf`. Preserve editor completion and validation for TypeScript project options
alongside Resultar rule configuration, including projects with other plugin entries.
Editors resolve the standard reference from SchemaStore or their cache. This does not
select a TypeScript version or replace the native compiler's project validation.

## 5. Delivery and acceptance

### Phase 1: Function utilities and safety

- [x] Add public `pipe`, `flow`, `identity`, and `constant`, plus the private `dual` helper.
- [x] Share the indexed pipeline executor and preserve overload inference.
- [x] Protect `R` from unknown/any types and assertions that erase requirements/scopes.
- [x] Diagnose unused suppressions and update checker configuration/documentation.

### Phase 2: Task ergonomics

- [x] Add `ResultTask.fn` and its generator diagnostics.
- [x] Add typed instance/direct/curried `catchTag` and `catchTags`.
- [x] Add `acquireDisposable` using existing scopes.

### Phase 3: Tooling

- [x] Add versioned project overlays and unsaved-buffer analysis.
- [x] Add channel-aware hover, including `yield*`.
- [x] Add safe contextual refactors with versioned previews.
- [x] Add read-only `overview` and `quickfixes` commands.
- [x] Compose the standard tsconfig schema and test editor completion/validation.

Every behavior change ships with a changeset and targeted tests. Update public exports,
API guard tests, package READMEs, `DOCUMENTATION.md`, the Resultar agent guide, and
checked/runnable examples. Record pipeline/function-wrapper benchmark measurements
without claiming improvements before measurement.

### Validation completed

Workspace `check:full` passed, including 629 core tests, six JSON schema editor tests,
compiler/lint checks, Go tests,
and package analysis. Build, package smoke tests, and all five example suites passed.
Targeted tests cover immutable overlays and dependent files, debounced versioned diagnostics,
UTF-16/CRLF edits, channel/service hover, barrel exports, and read-only previews. Proposed
refactors are applied to fresh snapshots and recompiled; unsafe candidates are rejected.
The native LSP/analyzer/config tests also passed with Go's race detector.
The schema editor tests passed against both an offline fixture and a complete
SchemaStore snapshot, covering standard options, Resultar options, and JSONC syntax.

### Implementation measurements

The runnable benchmark is `pnpm --filter resultar-benchmarks bench:function`.
On Node 24.21.0, macOS arm64, five samples after warmup measured these medians
for 500,000 iterations: previous pipeline executor with `slice`, 13.66 ms; root
`pipe`, 7.49 ms; reused `flow`, 7.73 ms; `fn` task construction, 7.46 ms;
manual `gen` construction, 6.88 ms. Repeated execution of the same `fn` task
completed 10,000 runs in 7.91 ms after warmup.

These are local microbenchmarks, not production guarantees. Results varied between
runs due to warmup and concurrent validation; the recorded run was isolated. Choose
the function wrapper for API ergonomics, without assuming a speedup. Task execution
still uses the existing generator interpreter. Compare measurements under the same
environment before making a general performance claim.

### Test cases

- Utilities: zero/max pipeline arity, incompatible intermediate types, `flow` optional/
  rest arguments and receiver, exception/Promise behavior, object identity, and constant
  reference capture.
- Tasks: lazy function invocation, fresh iterators on repeated runs, concrete `A/E/R`
  inference, handler narrowing, partial recovery, defects/composites, and pending scope
  errors that cannot be erased.
- Resources: failed acquisition, both disposal protocols, exactly-once LIFO release,
  and cleanup after success, typed failure, defect, and interruption.
- Safety: unknown/any requirements, valid `never`, service and scope removal, chained
  assertions, aliases/barrels, legitimate providers, and suppression use with disabled
  rules or partial directives.
- Tooling: unsaved dependent files, new included files, close/save transitions, stale
  versions, Unicode/CRLF ranges, hover over `yield*`, safe/unsafe refactor candidates,
  stable machine output, and previews that leave the filesystem unchanged.
- Regression: existing eager/lazy contracts, runners, cleanup behavior, and stack safety
  over 10,000-operation task chains.

Run the workspace gates after implementation:

```sh
pnpm run check:full
pnpm run build
pnpm run smoke:package
pnpm run test:examples
```

Keep this RFC Draft until work starts, In Progress while checklist items remain, and
Implemented only after release and public documentation. Do not mark RFC 0003's
concurrency or live lifecycle validation complete as part of this delivery.

## References

- [Effect v4 documentation](https://effect.website/docs/v4)
- [Effect Function API](https://effect.website/docs/v4/api/effect/Function), including
  `pipe`, `flow`, `dual`, and the object-identity memoization contracts
- [Effect API](https://effect.website/docs/v4/api/effect/Effect), for generator wrappers,
  tagged recovery, and native disposable acquisition
- [Effect Language Service](https://github.com/Effect-TS/language-service), for diagnostic,
  hover, refactor, and CLI workflow inspiration
- [Effect TypeScript-Go tooling](https://github.com/Effect-TS/tsgo); Resultar keeps its
  own existing native backend and does not adopt the compiler wrapper
