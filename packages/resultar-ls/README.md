# Resultar Language Service

TypeScript language-service diagnostics for Resultar.

## Install

```sh
pnpm add -D resultar-ls typescript
```

Enable the plugin in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "resultar-ls", "noDiscard": "error" }]
  }
}
```

This enables editor diagnostics in TypeScript-aware editors that load workspace TypeScript plugins.

## Lint-Like Check

For a command users can run next to their normal lint script, use the no-discard binary:

```json
{
  "scripts": {
    "lint:resultar": "resultar-no-discard --project tsconfig.json"
  }
}
```

This checks the project with TypeScript's compiler API and exits non-zero when a `Result` or
`ResultAsync` value is ignored.

The check resolves `typescript` from the project where the command is run first, then falls back to
the copy visible to `resultar-ls`. Run it through your package manager so it uses the same TypeScript
version as the project:

```sh
pnpm exec resultar-no-discard --project tsconfig.json
```

## Build-Time Diagnostics

TypeScript language-service plugins are editor-only by default. To make `tsc` report Resultar
diagnostics during builds, patch the local TypeScript installation:

```sh
pnpm exec resultar-ls patch
```

To keep the patch applied after installs:

```json
{
  "scripts": {
    "prepare": "resultar-ls patch"
  }
}
```

Use `check` to verify patch status and `unpatch` to remove only Resultar patch blocks:

```sh
pnpm exec resultar-ls check
pnpm exec resultar-ls unpatch
```

The patch command supports TypeScript 6.x.

For TypeScript 7 native preview projects, the workspace `resultar-tsgo` wrapper runs `tsgo` first and
then runs the same no-discard check. See `examples/tsgo`.
