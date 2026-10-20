# Resultar Review And Migration Checklist

Use this checklist for implementation reviews, migrations, documentation changes, and final
validation. Report only issues supported by the installed Resultar version and repository evidence.

## Source And Scope

- Confirm installed `resultar`, request adapter, and checker versions; `resultar/async` ships with `resultar`.
- Prefer `resultar/async` imports for explicit eager code. Existing main-entry Async exports and
  Result/Task/tagged-error bridges remain available; migration preserves their contracts.
- Inspect local exports, types, package README files, and runnable examples before suggesting an API.
- Separate issues introduced by the change from pre-existing workspace or dependency problems.
- Preserve unrelated changes in a dirty worktree.

## Failure Model

- New sync failures return `Result` / `StrictResult`; new async workflows return lazy `ResultTask`
  with concrete error and requirement types. Programmer defects may still throw.
- `ResultAsync` / `StrictResultAsync` are the official in-flight `Result` types returned by `task.runResult()`. Legacy adapters and static orchestration helpers on `ResultAsync` in `resultar/async` remain deprecated for existing eager boundaries; migration
  preserves their start-once and repeat-await behavior until callers move to explicit Task workflows and runners.
- Tagged errors have stable names, useful metadata, inferred template props, and preserved causes.
- Error unions remain concrete instead of widening early to `Error`, `unknown`, or a string.
- `TaggedEnum` is limited to lightweight non-Error domain variants.
- Sensitive metadata is redacted when serialization or logging could expose it.

## Composition

- Result and Task `map` / `mapErr` perform synchronous success/error transforms. Async retains its
  Promise-awaiting callbacks; a Task mapper returning a Promise stores it as a success value.
- `filterOrElse` represents predicate validation.
- Task `andThen` composes Task or synchronous Result steps. `fromResult` lifts a Result, and
  structural `fromResultAsync(factory)` defers a `PromiseLike<Result>` producer. Free `asyncAndThen`
  / `asyncMap` from `resultar/async` provide alternatives to the retained Result methods and statics.
- Prefer `task.runResult()` (or `ResultTask.runResult(task)`) when bridging a requirement-free Task into an in-flight `ResultAsync`, and `errAsync(new DomainError(props))` in eager compatibility code;
  `ResultAsync.fromTask`, Task `toResultAsync`, and tagged `.errAsync()` remain supported.
- `orElse` recovers the whole error channel; `catchTag` / `catchTags` recover selected domain cases.
- Core `Result.gen` / `Result.fn` and legacy core `safeTry` support sync and async bodies. Modern
  `gen` returns plain success values; `safeTry` returns a final Result. Explicit eager imports
  can use `resultar/async` as `genAsync` / `fnAsync` / `safeTryAsync` aliases.
  New async generators use `ResultTask.gen`, yielding Tasks, Results, and services.
  No raw Promise yields, raw `await`, or broad `try/catch` bypass typed composition.
- Returned `Result`, `ResultAsync`, and `ResultTask` values are handled or explicitly discarded by supported policy.
- Type assertions do not narrow away possible errors.

## Async Boundaries And Policy

- External throws and rejections are wrapped once, close to the uncontrolled dependency.
- Error mappers accept `unknown` and produce concrete errors with `cause`.
- New Promise factories use `ResultTask.tryPromise({ try, catch })` and forward its signal.
- Existing eager adapters import `tryResultAsync`, `fromPromise`, and `fromSafePromise` from
  `resultar/async`, using factories for fresh work and `fromPromise` for existing Promises,
  and `fromSafePromise` only when rejection is impossible by contract.
- Callback integrations provide cleanup and model `AbortError` where applicable.
- Retry policy defines bounded attempts, delay/jitter, retryable errors, and cancellation.
- Retry configuration shared across ResultAsync and ResultTask uses `Retry.policy`, preserving
  each execution model. Canonical predicates use zero-based context and only run with budget;
  older Task options and eager Async options keep their distinct callback signatures and jitter behavior.
- Task promise adapters choose `'wait'` or `'detach'` deliberately. Detachment stops waiting,
  while the adapter owns resources acquired by underlying work after interruption.
- Timeout scope is explicit: per attempt or across the complete retry budget.
- `ResultAsync.race` / `raceAll` select the first `Ok`; if every task fails, return the last completed `Err`. `ResultAsync.raceFirst` selects the first completed `Result`.
- ResultAsync races and timeouts abort pending losers without waiting for their settlement or cleanup.
- `ResultTask.race` selects the first success; `ResultTask.raceFirst` selects the first outcome. Both await loser cleanup.
- `Fiber.await` observes completion; `join` composes the result and `interrupt` requests cancellation.
- `yieldEvery` / `scheduler` configure instruction scheduling, not synchronous preemption or time.
  Tests use a deterministic scheduler when ordering across yields matters.
- Signals reach the underlying client so cancellation is cooperative rather than cosmetic.
- Batch concurrency is bounded when workload size or dependency capacity requires it.
- `validateAll` is used only when collecting all independent failures is desired.
- Task resources use `acquireRelease` / `acquireDisposable` + `scoped` for awaited cleanup and
  preserved release failures. Existing Async `withResource` cleanup stays best-effort; an eager
  cleanup failure that must affect control flow is modeled as an explicit fallible step.

## Boundaries And Recovery

- Domain code does not contain transport status codes, framework responses, or CLI exit behavior.
- `matchTags` handles the complete tagged error union at the boundary.
- `matchTagsPartial` and `matchErrorPartial` have intentional fallbacks.
- Task `match` / `matchTags` / `matchTagsPartial` are compositional folds, followed by an explicit
  runner at the boundary. Async instance matching remains a native Promise terminal;
  Async static/direct/curried matching returns a composable Async value.
- An `Error` handler exists when untagged errors can reach tagged matching.
- Recovery is local only when the fallback is genuine domain/application policy.
- `_unsafeUnwrap*` remains in tests; `runSync`, `runPromise`, and `unwrapOrThrow` appear only at
  deliberate terminal boundaries.

## HTTP Requests

- `resultar-request` is used for a custom guard/decoder; TypeBox and Zod use their dedicated
  adapters.
- TypeBox success types derive from `Static<typeof schema>`.
- Zod success types derive from `z.output<typeof schema>` so transforms are preserved.
- Validated values are not widened back to `JsonRecord`, `Record<string, unknown>`, or `unknown`.
- Error mapping distinguishes request, HTTP, invalid-JSON, and validation failures.
- Numeric HTTP handlers take precedence over generic HTTP mapping where needed.
- Retry uses a request factory and does not retry non-retryable `4xx`, JSON, or validation failures
  without explicit policy.
- Request helpers really return eager Async. A new lazy workflow invokes them inside
  `ResultTask.fromResultAsync((signal) => ...)` and forwards the signal to fetch; it does not capture
  an already-started request and claim it was deferred.

## Observability And Cleanup

- `inspect` / `inspectError` / `inspectBoth` and `log` across all models are best-effort and never
  execute returned Tasks. Deprecated Result and Async `tap` / `tapError` keep that observer contract.
- Only Task `tap` / `tapError` / `tapCause` / `tapBoth` compose effectful side operations and can
  introduce typed failures or defects.
- Resource cleanup and observation use the semantics of the concrete execution model.
- `Result.gen` / `safeTry` do not close a suspended generator on early `Err`; cleanup does not rely
  on `finally` on that path. `ResultTask.gen` interprets yielded generator cleanup.
- Audits, publishes, or cleanup that must succeed use `andThen`, `orElse`, or another Resultar
  boundary.
- Logs expose stable tags and safe context without leaking redacted values.

## Tests And Documentation

- Runtime tests cover `Ok` and every expected `Err` branch.
- Type tests cover inferred error unions, required tagged-error props, narrowing, and exhaustive
  handlers.
- Retry, timeout, cancellation, races, concurrency, and cleanup use deterministic fakes.
- Tests use the repository's actual runner; this repository uses `vite-plus/test`.
- Documentation examples compile or have a matching runnable example.
- Core request, TypeBox, and Zod docs link to one another as alternatives/adapters.
- API names, package links, and version claims match current source.
- `Result.gen` and `ResultTask.gen` return plain success values and compose fallible steps or early
  errors via `yield*`; `safeTry` retains its final-Result contract.
- APIs retained in the compatibility subpath and main entry preserve eagerness and legacy callback
  semantics. Prefer canonical Task names while preserving deprecated aliases during migration.
- Stable checker names such as `preferResultAsync` describe an existing eager-contract policy,
  scoped deliberately; they do not override the Task default for new workflows.
- Instance `task.runResult()`, `runPromise()`, `runExit()`, and `runFork()` use the same options,
  service checks, and deferred release error types as their supported static forms. Prefer instance
  runners in new recipes. `runResult` rejection paths and deferred release errors are handled at the owning boundary.
- An intentional-discard fix is not mistaken for executing or handling a lazy task.

## Validation Order

1. Run the `resultar-check` CLI as the authoritative project check.
2. Confirm the `resultar-check lsp` stdio server emits Resultar diagnostics and quick fixes in the
   editor.
3. Use JSONL, SARIF, or JUnit output when a CI/review system needs structured diagnostics; keep the
   native CLI as the authoritative check.
4. Run formatting, build, tests, analysis, package smoke tests, and example workflows that apply.
5. Report exactly which commands passed, failed, or were blocked.

## Review Red Flags

- `T | Error`, sentinel `null`, message strings, or thrown expected failures replace a Resultar
  channel.
- A broad `try/catch` surrounds an entire workflow instead of wrapping one external boundary.
- Project-wide `try/catch` remains after the strict `noTryCatch` migration rule is enabled.
- `map` returns another Resultar container, or a Task mapper returns a Promise instead of composing
  an asynchronous step.
- `orElse` only replaces one error with another and should be `mapErr`.
- A raw promise is awaited inside a Resultar workflow without a typed mapper.
- `Result.gen` / `safeTry` contain raw `await`, plain `yield`, or broad `try/catch` instead of supported Result composition.
- A Resultar value is created and ignored.
- `_unsafeUnwrap()` appears in production code.
- An assertion makes an error union narrower than the implementation can guarantee.
- Tagged errors override generated constructors, mismatch class names, or omit useful causes.
- A schema adapter returns a broad JSON type or duplicates the schema with a drifting interface.
- A promise rather than a request factory is configured for retry.
- Hand-written retry, timeout, or race logic duplicates the built-in policy of the chosen model.
- A lint-only pass is described as full Resultar validation.
- Documentation recommends an API absent from the installed package.
