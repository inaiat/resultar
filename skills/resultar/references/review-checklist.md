# Resultar Review And Migration Checklist

Use this checklist for implementation reviews, migrations, documentation changes, and final
validation. Report only issues supported by the installed Resultar version and repository evidence.

## Source And Scope

- Confirm the installed `resultar`, request adapter, and `resultar-check` versions.
- Inspect local exports, types, package README files, and runnable examples before suggesting an API.
- Separate issues introduced by the change from pre-existing workspace or dependency problems.
- Preserve unrelated changes in a dirty worktree.

## Failure Model

- Expected failures return `Result` or `ResultAsync`; programmer defects may still throw.
- Application and integration boundaries prefer `StrictResult` / `StrictResultAsync`.
- Tagged errors have stable names, useful metadata, inferred template props, and preserved causes.
- Error unions remain concrete instead of widening early to `Error`, `unknown`, or a string.
- `TaggedEnum` is limited to lightweight non-Error domain variants.
- Sensitive metadata is redacted when serialization or logging could expose it.

## Composition

- `map` performs only infallible success transforms.
- `mapErr` performs error-only transforms.
- `filterOrElse` represents predicate validation.
- `andThen` composes fallible steps; `asyncAndThen` is used for the sync-to-async bridge.
- `orElse` recovers the whole error channel; `catchTag` / `catchTags` recover selected domain cases.
- `safeTry` uses `yield*` for Resultar values and contains no raw `await` or broad `try/catch`.
- Returned `Result` and `ResultAsync` values are handled or explicitly discarded by supported policy.
- Type assertions do not narrow away possible errors.

## Async Boundaries And Policy

- External throws and rejections are wrapped once, close to the uncontrolled dependency.
- Error mappers accept `unknown` and produce concrete errors with `cause`.
- Promise factories use `tryResultAsync`; already-created promises use `fromPromise`.
- `fromSafePromise` is used only when rejection is impossible by contract.
- Callback integrations provide cleanup and model `AbortError` where applicable.
- Retry policy defines bounded attempts, delay/jitter, retryable errors, and cancellation.
- Timeout scope is explicit: per attempt or across the complete retry budget.
- `race`/`raceAll` are used for first settlement; `raceFirst` for first success.
- Signals reach the underlying client so cancellation is cooperative rather than cosmetic.
- Batch concurrency is bounded when workload size or dependency capacity requires it.
- `validateAll` is used only when collecting all independent failures is desired.
- `withResource` cleanup is treated as best-effort; important cleanup failures are modeled in the
  result channel.

## Boundaries And Recovery

- Domain code does not contain transport status codes, framework responses, or CLI exit behavior.
- `matchTags` handles the complete tagged error union at the boundary.
- `matchTagsPartial` and `matchErrorPartial` have intentional fallbacks.
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

## Observability And Cleanup

- `tap`, `tapError`, and `log` are used only for best-effort observation.
- Callback failure in observation helpers is not expected to change the result.
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

## Validation Order

1. Run the `resultar-check` CLI as the authoritative project check.
2. Confirm the TypeScript language-service plugin uses the workspace TypeScript version and emits
   Resultar diagnostics in the editor.
3. Run Oxlint, ESLint, or Deno Lint only as optional AST-only feedback.
4. Run formatting, build, tests, analysis, package smoke tests, and example workflows that apply.
5. Report exactly which commands passed, failed, or were blocked.

## Review Red Flags

- `T | Error`, sentinel `null`, message strings, or thrown expected failures replace a Resultar
  channel.
- A broad `try/catch` surrounds an entire workflow instead of wrapping one external boundary.
- Project-wide `try/catch` remains after the strict `noTryCatch` migration rule is enabled.
- `map` returns another `Result` or `ResultAsync`.
- `orElse` only replaces one error with another and should be `mapErr`.
- A raw promise is awaited inside a Resultar workflow without a typed mapper.
- `safeTry` contains raw `await`, plain `yield`, `try/catch`, or legacy `safeUnwrap()`.
- A Resultar value is created and ignored.
- `_unsafeUnwrap()` appears in production code.
- An assertion makes an error union narrower than the implementation can guarantee.
- Tagged errors override generated constructors, mismatch class names, or omit useful causes.
- A schema adapter returns a broad JSON type or duplicates the schema with a drifting interface.
- A promise rather than a request factory is configured for retry.
- Hand-written retry, timeout, or race logic duplicates a built-in ResultAsync policy.
- A lint-only pass is described as full Resultar validation.
- Documentation recommends an API absent from the installed package.
