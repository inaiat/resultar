# Native checker: rules, configuration, and repairs

The [checker manual](../../../packages/check/README.md#diagnostics) is the single
maintained table of all 42 diagnostic IDs, option names, defaults, and meanings.
Read the installed package's schema and README for its version. This guide explains
how to apply the rules without changing the application's execution contract.

## Verify and repair

Run `resultar-check --project tsconfig.json` through the project's package manager.
Use the documented JSON Lines, SARIF, JUnit, inspection, and LSP interfaces from the
[CLI reference](../../../packages/check/README.md#command-line). Fix the cause,
then rerun TypeScript, the checker, and the relevant behavior tests.

Common repairs (apply only when behavior is preserved):

| Diagnostic family | Repair |
| --- | --- |
| `no-discard`, `unused-suppression` | Handle/return/yield the value, or explicitly discard intentionally. Remove unused line suppression entries. |
| `yield-star-*`, `require-return-yield-star` | Use `yield*` for composition and `return yield*` for always-failing branches. |
| `no-result-in-task-gen` | Return a plain success value from modern generators; yielding a sync Result remains supported. |
| `no-await-*`, `no-run-inside-gen` | Yield the child operation; keep Task runners and native Promise awaits at boundaries. |
| `no-fn-iife`, `no-unnecessary-err-wrap-in-gen` | Use `gen` for immediate construction; yield a tagged error or its error helper directly. |
| `no-promise-in-result-success`, `no-throw-in-task-sync` | Adapt Promise work with `tryPromise`; adapt expected throws with `try`. |
| `no-unknown-result-error`, `no-unknown-task-requirements`, `unsafe-result-type-assertion` | Preserve inferred concrete unions and requirements; map unknown external causes, never erase obligations with assertions. |
| `prefer-tagged-error`, `tagged-error-name-match`, `no-tagged-error-constructor-override`, `typed-catch-mapper` | Use stable matching class/tag names and `.withProps`; return a concrete error from boundary mappers. |
| `no-throw`, `no-try-catch`, `no-try-catch-in-safe-try`, `no-unsafe-await` | Use typed boundaries for expected failures; preserve deliberate native interop under the project's policy. |
| `no-unscoped-acquire-release`, `prefer-acquire-disposable` | Give resources an explicit Task scope; use native disposal adapters where appropriate. |
| `no-invalid-lifetime` | A singleton cannot depend on scoped/transient/request locals; a scoped provider cannot depend on transient. |
| `prefer-map`, `prefer-map-err`, `prefer-and-then`, `prefer-or-else-succeed` | Choose transformation, chaining, error transformation, or infallible recovery according to callback behavior. |
| `prefer-tap`, `prefer-tap-error`, `prefer-as-void`, `prefer-filter-or-else` | Use the purpose-specific operator while preserving eager/Task callback failure semantics. |
| `prefer-catch-reason`, `prefer-first-success-of` | Recover nested reasons explicitly; supply fallback factories, not already-started values. |
| `prefer-result-for-each`, `unnecessary-pipe`, `no-useless-recovery` | Use collection helpers; remove empty composition and recovery of an infallible channel. |
| `no-promise-resultar` | Return `ResultTask<T, E, R>` directly for `Promise<ResultTask<...>>`, and `ResultAsync<T, E>` / `StrictResultAsync<T, E>` directly for `Promise<Result<...>>` / `Promise<StrictResult<...>>`, without an `async` wrapper. Map external rejections at their source. |
| `prefer-result-async` | Optional eager-boundary convention. It does not require new Task workflows to become eager. |

## Defaults and severity

Severities are `error`, `warning`, `suggestion`, `message`, and `off`.
The default `failOn: "message"` fails for every enabled severity.
`failOn: "warning"` fails for errors and warnings; `failOn: "error"` allows warnings.
Use `off` to disable a rule; there is no `info` severity or `never` threshold.

`noDiscardMode` accepts `must-use` (default) or `direct`.
`noUnsafeAwait` defaults to off; its mode is `resultar-context` or `all`.
`preferResultAsyncMode` accepts `result` (default) or `all`; enable it according to
an existing eager API policy, not as a blanket v4 recommendation.

## Adopt incrementally

```json
{
  "compilerOptions": {
    "plugins": [{
      "name": "resultar-check",
      "noDiscardMode": "must-use",
      "noPromiseResultar": "error",
      "preferResultAsync": "off",
      "failOn": "error"
    }]
  }
}
```

This enforces must-use values and rejects prohibited `Promise<Result>` / `Promise<ResultTask>`
application contracts at error severity while initially allowing other warnings during incremental
adoption. Review warnings and suggestions before lowering `failOn`. File overrides and per-rule
severities are described in the [configuration reference](../../../packages/check/README.md#configuration).

For a stricter Task project, `diagnosticSeverity: "error"` enables all rules at
error severity (keep `noPromiseResultar: "error"` and set `preferResultAsync: "off"`
when the optional eager-everywhere policy is inapplicable).
`noUnsafeAwaitMode: "all"` also affects bootstrap and driver callbacks, so explicitly
configure those interoperability boundaries. No preset proves code free of defects.

## Suppression and fixes

```ts
// resultar-check-disable-next-line no-throw -- native framework boundary
throw boundaryError
```

Inline suppression uses `resultar-check-disable-line`. Omitting IDs suppresses all
Resultar diagnostics for that line, not TypeScript diagnostics. Prefer a named rule.
`unused-suppression` checks unused and unknown entries against enabled findings.

Diagnostic fix kinds are `correction` and `intentional-discard`. LSP action kinds
such as `refactor.rewrite` are a separate protocol field, not additional fix kinds.
Review changes before applying fixes that alter observation, recovery, or execution.
