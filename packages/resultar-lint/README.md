# Resultar Lint

Lint, editor, and build-time diagnostics for Resultar.

## Install

```sh
pnpm add -D resultar-lint typescript
```

Enable the plugin in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "resultar-lint", "noDiscard": "error" }]
  }
}
```

This enables editor diagnostics in TypeScript-aware editors that load workspace TypeScript plugins.

## Lint-Like Check

For a command users can run next to their normal lint script, use the generic Resultar lint CLI:

```json
{
  "scripts": {
    "lint:resultar": "resultar-lint check --project tsconfig.json"
  }
}
```

This checks the project with TypeScript's compiler API and exits non-zero when a `Result` or
`ResultAsync` value is ignored.

By default, the check uses neverthrow-style `must-use` mode. It reports discarded Resultar
expressions and assigned `Result` values that are passed around but never consumed with `match`,
`unwrapOr`, `_unsafeUnwrap`, `isOk`, `isErr`, returned, or explicitly discarded. Use
`--mode direct` for the lower-noise expression-only check. When `--mode` is omitted, the CLI uses
`compilerOptions.plugins[].noDiscardMode` from the checked `tsconfig.json` if present, otherwise
`must-use`.

The check resolves `typescript` from the project where the command is run first, then falls back to
the copy visible to `resultar-lint`. Run it through your package manager so it uses the same TypeScript
version as the project:

```sh
pnpm exec resultar-lint check --project tsconfig.json
pnpm exec resultar-lint check --project tsconfig.json --mode direct
```

## Oxlint And Vite+

`resultar-lint` also exports an Oxlint JS plugin at `resultar-lint/oxlint`.

```ts
import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    jsPlugins: [{ name: "resultar", specifier: "resultar-lint/oxlint" }],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      "resultar/no-discard": "error",
    },
  },
});
```

Rule options:

```ts
export default defineConfig({
  lint: {
    jsPlugins: [{ name: "resultar", specifier: "resultar-lint/oxlint" }],
    rules: {
      "resultar/no-discard": ["error", { project: "tsconfig.json" }],
    },
  },
});
```

For TypeScript editor diagnostics or patched `tsc`, use `noDiscardMode: "direct"` only when you
want the lower-noise expression-only check:

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "resultar-lint", "noDiscard": "error", "noDiscardMode": "direct" }]
  }
}
```

The Oxlint rule runs the same TypeScript compiler-backed no-discard checker internally and caches
the project result for the current Oxlint process. This is necessary because Oxlint custom JS rules
do not currently expose TypeScript services to plugin authors.

See `examples/vite-plus` for a smoke test where `vp check` fails on ignored `Result` and
`ResultAsync` values.

## Build-Time Diagnostics

TypeScript language-service plugins are editor-only by default. To make `tsc` report Resultar
diagnostics during builds, patch the local TypeScript installation:

```sh
pnpm exec resultar-lint patch
```

To keep the patch applied after installs:

```json
{
  "scripts": {
    "prepare": "resultar-lint patch"
  }
}
```

Use `doctor` to verify patch status and `unpatch` to remove only Resultar patch blocks:

```sh
pnpm exec resultar-lint doctor
pnpm exec resultar-lint unpatch
```

The patch command supports TypeScript 6.x.

For TypeScript 7 native preview projects, the workspace `resultar-tsgo` wrapper runs `tsgo` first and
then runs the same no-discard check. See `examples/tsgo`.
