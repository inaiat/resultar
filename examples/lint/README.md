# Resultar Lint Example

This package is retained as a compatibility example name, but it now uses the same TS7-only
`resultar-check` flow as the rest of the workspace.

The example is intentionally split into two TypeScript files:

- `src/index.ts` is a diagnostics catalog. It has one or more intentional examples for every
  `resultar-check` rule, with comments explaining why the rule fires.
- `src/resultar-clean.ts` is the matching style guide. It shows the accepted Resultar pattern for
  the same situations and should stay free of Resultar diagnostics.

Run it from the repository root:

```sh
pnpm --filter resultar-check-compat-example smoke
```

The `check` script runs:

```sh
resultar-check
```

The package `tsconfig.json` enables every Resultar rule as an error and opts into:

```json
{
  "name": "resultar-check",
  "noDiscardMode": "must-use",
  "noUnsafeAwait": "error",
  "noUnsafeAwaitMode": "all",
  "noUnsafeAwaitIgnoreCalls": ["fastify.after"]
}
```

That means the example covers both normal Resultar contexts and broader framework/bootstrap awaits.
`fastify.after` is intentionally ignored to document the exact call-path escape hatch: `fastify.after`
is allowed, while `fastify.ready`, `app.after`, and unrelated raw Promise awaits are still reported.

The smoke test verifies that every configured Resultar rule is reported through TypeScript 7 and that
`src/resultar-clean.ts` has no diagnostics.
