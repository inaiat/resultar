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

This checks the project with TypeScript's compiler API and exits non-zero when enabled Resultar
rules report findings.

By default, `noDiscard` uses neverthrow-style `must-use` mode. It reports discarded Resultar
expressions and assigned `Result` values that are passed around but never consumed with `match`,
`unwrapOr`, `_unsafeUnwrap`, `isOk`, `isErr`, returned, or explicitly discarded. Use
`--mode direct` for the lower-noise expression-only check. When `--mode` is omitted, the CLI uses
`compilerOptions.plugins[].noDiscardMode` from the checked `tsconfig.json` if present, otherwise
`must-use`.

Additional rules are enabled as warning diagnostics in TypeScript-aware editors and as active checks
in the CLI:

| Rule                                            | tsconfig option                    | Purpose                                                                            |
| ----------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| `resultar/no-discard`                           | `noDiscard`                        | Require `Result` and `ResultAsync` values to be handled or explicitly discarded.   |
| `resultar/prefer-map-err`                       | `preferMapErr`                     | Prefer `mapErr` when `orElse` only returns another `Err`.                          |
| `resultar/prefer-and-then`                      | `preferAndThen`                    | Prefer `andThen` / `asyncAndThen` when `map` returns a Resultar value.             |
| `resultar/typed-catch-mapper`                   | `typedCatchMapper`                 | Require catch conversion helpers to map caught values to typed errors.             |
| `resultar/no-try-catch-in-safe-try`             | `noTryCatchInSafeTry`              | Avoid raw `try/catch` inside `safeTry` generators.                                 |
| `resultar/yield-star-in-safe-try`               | `yieldStarInSafeTry`               | Require `yield*` for Resultar values inside `safeTry`.                             |
| `resultar/unsafe-result-type-assertion`         | `unsafeResultTypeAssertion`        | Prevent assertions that narrow Resultar error channels.                            |
| `resultar/prefer-tagged-error`                  | `preferTaggedError`                | Prefer `createTaggedError` over plain `Error` subclasses or `err(new Error(...))`. |
| `resultar/tagged-error-name-match`              | `taggedErrorNameMatch`             | Require `createTaggedError({ name })` to match the class name.                     |
| `resultar/no-tagged-error-constructor-override` | `noTaggedErrorConstructorOverride` | Keep the generated tagged-error constructor intact.                                |
| `resultar/no-useless-recovery`                  | `noUselessRecovery`                | Flag recovery calls on `Result<T, never>` / `ResultAsync<T, never>`.               |

Each option accepts `"error"`, `"warning"`, `"suggestion"`, `"message"`, or `"off"`:

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "resultar-lint",
        "noDiscard": "error",
        "preferAndThen": "error",
        "preferTaggedError": "off"
      }
    ]
  }
}
```

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
      "resultar/prefer-map-err": "error",
      "resultar/prefer-and-then": "error",
      "resultar/typed-catch-mapper": "error",
      "resultar/no-try-catch-in-safe-try": "error",
      "resultar/yield-star-in-safe-try": "error",
      "resultar/unsafe-result-type-assertion": "error",
      "resultar/prefer-tagged-error": "error",
      "resultar/tagged-error-name-match": "error",
      "resultar/no-tagged-error-constructor-override": "error",
      "resultar/no-useless-recovery": "error",
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

Each Oxlint rule runs the same TypeScript compiler-backed checker internally and caches the project
result for the current Oxlint process. This is necessary because Oxlint custom JS rules do not
currently expose TypeScript services to plugin authors.

See `examples/lint` for a smoke test where `vp check` fails on one or more violations for
every Resultar rule.

## Examples

The workspace keeps two lint example packages because Resultar diagnostics can run through different
tooling surfaces:

| Example                                                  | Tooling surface                                                              | What it proves                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`examples/lint`](../../examples/lint)           | TypeScript plugin, CLI, patched `tsc`, and Vite+ / Oxlint `jsPlugins`        | The full rule set runs through CLI, build-time TypeScript, and Vite+ diagnostics.          |
| [`examples/tsgo-lint`](../../examples/tsgo-lint) | TypeScript 7 `typescript@rc` through `resultar-tsgo`                         | Native `tsgo` type-checks first, then Resultar lint validation runs over the same project. |

Run every lint integration smoke from the repository root:

```sh
pnpm run test:language-service
```

Run one surface at a time:

```sh
pnpm run example:lint
pnpm run example:vite-plus
pnpm run example:tsgo-lint
```

## Build-Time Resultar Diagnostics

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

The patch command supports TypeScript 6.x and delegates to the installed `resultar-lint` runtime, so
patched `tsc` reports the same enabled rules from `compilerOptions.plugins[]`.

For TypeScript 7 projects using `typescript@rc`, the workspace `resultar-tsgo` wrapper runs `tsgo`
first and then runs the same Resultar lint check. See `examples/tsgo-lint`.
