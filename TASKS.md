# Resultar Improvement Roadmap

Prioritized tasks from the project review. This is a roadmap/checklist only; source behavior changes
should be handled in follow-up implementation tasks with focused tests.

## P0 - Safety

- [x] Add no-discard protection for `Result` and `ResultAsync`.
  - Goal: flag calls like `saveUser(input)` when the returned result is ignored.
  - Accept explicit ignores with `void saveUser(input)` or another deliberate convention.
  - Decide whether this lives as a local ESLint rule, shared config, or documented helper.
- [x] Move or delete the accidental note file under `src/`.
  - Current file: `src/Add a no-discard lint rule or ESLint hel`.
  - Preserve any still-useful content in this roadmap, an issue, or documentation before removing it.

## P1 - Release Reliability

- [x] Add CI for the main validation path.
  - Run `pnpm run check:full`.
  - Run `pnpm run build`.
- [x] Add package smoke checks.
  - Verify built `dist` imports work from the package entrypoint.
  - Verify packed files contain only the intended publish surface.
  - Prefer adding an `npm pack --dry-run` or equivalent check.
- [x] Review publish workflows.
  - Ensure publishing does not happen from ordinary branch pushes.
  - Keep npm and JSR publishing tied to explicit release triggers, tags, or protected branches.

## P1 - Dependency Health

- [ ] Fix the Vitest / coverage version mismatch reported by `pnpm run check:full`.
  - The current run warns that mixed Vitest and `@vitest/coverage-v8` versions are loaded.
  - Align the runner and coverage package versions before treating coverage output as stable.
- [ ] Re-run coverage after dependency alignment.
  - Record the new coverage numbers.
  - Add thresholds only after the version mismatch is resolved.

## P2 - API Cleanup

- [x] Decide the `safeTryAsync` policy before `2.0.0` stable.
  - Removed the deprecated export before `2.0.0` stable.
- [x] Revisit Node 24-only support.
  - Confirmed Node.js 24+ is intentional for the v2 package line.
  - Kept `Promise.try` usage in `ResultAsync.tryCatch`.
- [x] Replace cleanup API with clear Node.js 24 disposal semantics.
  - Use `log` for immediate best-effort observation across both result states.
  - Use `toDisposable` and `toAsyncDisposable` for explicit `using` / `await using` cleanup.

## P2 - Maintainability

- [x] Tighten TypeScript 6 strictness where practical.
  - Enabled `erasableSyntaxOnly`.
  - Enabled `exactOptionalPropertyTypes`.
  - Enabled `isolatedDeclarations`.
  - Enabled `noImplicitOverride`.
  - Enabled `noPropertyAccessFromIndexSignature`.
  - Enabled `noUncheckedSideEffectImports`.
  - Added a public API guard test for exported runtime names and removed methods.
- [x] Tighten broad lint exceptions where practical.
  - Start with unsafe assertions, deprecated APIs, and explicit `any`.
  - Keep exceptions that are necessary for the public type-level implementation.
- [x] Reduce duplicated tagged-error matching logic between `Result` and `ResultAsync`.
  - Extract shared runtime helpers only if they keep the public API and type inference unchanged.
  - Cover any helper extraction with focused runtime and type tests.

## Validation

Run these after roadmap items that change code, packaging, or dependencies:

```sh
pnpm run check:full
pnpm run build
```

Add targeted tests for any behavior-changing cleanup.
