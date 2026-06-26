# Resultar Lint Example

This package is retained as a compatibility example name, but it now uses the same TS7-only
`resultar-check` flow as the rest of the workspace.

Run it from the repository root:

```sh
pnpm --filter resultar-check-compat-example smoke
```

The `check` script runs:

```sh
resultar-check -p tsconfig.json --noEmit
```

The source intentionally contains ignored `Result` and `ResultAsync` calls plus one
assigned-but-unhandled Resultar value. The smoke test verifies that every configured Resultar rule is
reported through TypeScript 7.
