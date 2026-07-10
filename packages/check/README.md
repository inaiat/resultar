# Resultar Check

Resultar diagnostics for projects using TypeScript >=7.

`resultar-check` is the canonical Resultar diagnostics package and command. It requires TypeScript
>=7, runs the compiler first, then runs Resultar diagnostics over the same `tsconfig.json`. The same
package also ships AST-only adapters for Oxlint, ESLint, and Deno Lint.

## Install

For editor diagnostics and CLI checks, install `resultar-check` with project-local TypeScript >=7:

```sh
pnpm add -D resultar-check "typescript@>=7"
```

Add one check script:

```json
{
  "scripts": {
    "check": "resultar-check"
  }
}
```

`resultar-check` defaults to `tsconfig.json` and passes `--noEmit` to TypeScript unless a
`--noEmit` flag is already present.

Configure Resultar rules in `tsconfig.json`:

```json
{
  "$schema": "./node_modules/resultar-check/schema.json",
  "compilerOptions": {
    "plugins": [
      {
        "name": "resultar-check",
        "ignoreFilePatterns": ["*.test.ts", "*.spec.ts"],
        "noDiscard": "error",
        "preferMapErr": "error",
        "preferAndThen": "error"
      }
    ]
  }
}
```

The package-local schema provides editor completion and validation for `resultar-check` plugin
options.

`ignoreFilePatterns` disables Resultar diagnostics for matching files while leaving normal TypeScript
checking intact. Bare patterns such as `*.test.ts` match file basenames in any directory. Slash
patterns such as `tests/**` match normalized path suffixes.

`resultar-check` resolves a project-local `typescript@>=7` first and falls back to the TypeScript
dependency bundled with the package for CLI diagnostics.

## Editor Integration

`resultar-check` is a TypeScript language-service plugin. Editors must run a TypeScript server that
can resolve the local `resultar-check` package and see the `compilerOptions.plugins` entry above.

Use TypeScript >=7 for editor integration so the editor's TypeScript server can load
`resultar-check` from the same project.

After changing dependencies or `tsconfig.json`, restart the editor's TypeScript server. A working
setup reports diagnostics whose source is `resultar` and whose message starts with a rule name such
as `[resultar/noDiscard]`.

### VS Code

Add this to `.vscode/settings.json`:

```json
{
  "typescript.tsdk": "node_modules/typescript/lib",
  "typescript.enablePromptUseWorkspaceTsdk": true,
  "typescript.tsserver.pluginPaths": ["./node_modules"]
}
```

Then:

1. Run `TypeScript: Select TypeScript Version`.
2. Choose the workspace TypeScript version.
3. Run `TypeScript: Restart TS Server`.

If diagnostics still do not appear, confirm the workspace has `node_modules/typescript/lib`, the
status bar shows the workspace TypeScript version, and `resultar-check` is installed in the same
project or workspace root as the `tsconfig.json`.

### Zed

Use Zed's `vtsls` TypeScript server for plugin loading. Keep `typescript-language-server` in the
language server list as a fallback, but configure workspace TypeScript plugins through `vtsls`.

Add this to `.zed/settings.json`:

```json
{
  "languages": {
    "TSX": {
      "language_servers": ["vtsls", "typescript-language-server", "..."]
    },
    "TypeScript": {
      "language_servers": ["vtsls", "typescript-language-server", "..."]
    }
  },
  "lsp": {
    "vtsls": {
      "settings": {
        "vtsls": {
          "autoUseWorkspaceTsdk": true
        },
        "typescript": {
          "tsserver": {
            "pluginPaths": ["./node_modules"]
          }
        }
      }
    }
  }
}
```

You do not need a `typescript-language-server.initialization_options.plugins` block for
`resultar-check` when `vtsls` is first in the Zed language-server list.

Restart the TypeScript language server or reload Zed after changing settings. If diagnostics do not
appear, temporarily enable tsserver logging and inspect the Zed log:

```json
{
  "lsp": {
    "vtsls": {
      "settings": {
        "typescript": {
          "tsserver": {
            "log": "normal",
            "pluginPaths": ["./node_modules"]
          }
        },
        "vtsls": {
          "autoUseWorkspaceTsdk": true
        }
      }
    }
  }
}
```

If you have deliberately disabled `vtsls` and use only `typescript-language-server`, that server
still requires explicit plugin configuration with an absolute or package-root `location`. Prefer the
`vtsls` setup above for Zed projects.

## Rules

| Rule                                            | tsconfig option                    | Purpose                                                                            |
| ----------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| `resultar/no-discard`                           | `noDiscard`                        | Require `Result` and `ResultAsync` values to be handled or explicitly discarded.   |
| `resultar/prefer-map-err`                       | `preferMapErr`                     | Prefer `mapErr` when `orElse` only returns another `Err`.                          |
| `resultar/prefer-and-then`                      | `preferAndThen`                    | Prefer `andThen` / `asyncAndThen` when `map` returns a Resultar value.             |
| `resultar/typed-catch-mapper`                   | `typedCatchMapper`                 | Require catch conversion helpers to map caught values to typed errors.             |
| `resultar/no-throw`                             | `noThrow`                          | Disallow `throw` statements so expected failures stay in Resultar error channels.  |
| `resultar/no-await-in-safe-try`                 | `noAwaitInSafeTry`                 | Disallow `await` inside `safeTry`; use `yield*` for Resultar values.               |
| `resultar/no-unsafe-await`                      | `noUnsafeAwait`                    | Require raw Promise awaits in Resultar async contexts to use Resultar boundaries.  |
| `resultar/no-try-catch-in-safe-try`             | `noTryCatchInSafeTry`              | Avoid raw `try/catch` inside `safeTry` generators.                                 |
| `resultar/yield-star-in-safe-try`               | `yieldStarInSafeTry`               | Require `yield*` for Resultar values inside `safeTry`.                             |
| `resultar/unsafe-result-type-assertion`         | `unsafeResultTypeAssertion`        | Prevent assertions that narrow Resultar error channels.                            |
| `resultar/prefer-tagged-error`                  | `preferTaggedError`                | Prefer `createTaggedError` over plain `Error` subclasses, `err(new Error(...))`, or `throw new Error(...)`. |
| `resultar/tagged-error-name-match`              | `taggedErrorNameMatch`             | Require `createTaggedError({ name })` to match the class name.                     |
| `resultar/no-tagged-error-constructor-override` | `noTaggedErrorConstructorOverride` | Keep the generated tagged-error constructor intact.                                |
| `resultar/no-useless-recovery`                  | `noUselessRecovery`                | Flag recovery calls on `Result<T, never>` / `ResultAsync<T, never>`.               |

Each option accepts `"error"`, `"warning"`, `"suggestion"`, `"message"`, or `"off"`.
`noThrow` defaults to `"off"` because it is a strict migration rule. Enable it when expected
domain/application failures should always return `Err`/`errAsync` instead of throwing. It reports all
`throw` statements in inspected source files, including throws inside `tryResultAsync` boundaries;
use `ignoreFilePatterns` for test, script, or process-boundary files that intentionally throw.

`noAwaitInSafeTry` defaults to `"error"` and reports every `await` expression inside an inspectable
`safeTry` body. Use `yield*` for both `Result` and `ResultAsync` values; wrap raw Promises with a
Resultar helper before yielding them. Nested functions inside `safeTry` are not inspected by this
rule.

`noUnsafeAwait` defaults to `"off"` because it is an architectural rule and may require migration in
existing async code. Enable it explicitly when a project is ready to enforce Resultar async
boundaries. By default, `noUnsafeAwait` uses `noUnsafeAwaitMode: "resultar-context"` and checks
functions returning `ResultAsync` or `Promise<Result>`, plus `safeTry` bodies. Raw Promise awaits are
allowed in async catch helpers such as `tryAsync`, `tryResultAsync`, `tryCatchAsync`, and
`fromThrowableAsync`; inside `safeTry`, prefer `yield*` with Resultar values. Use
`noUnsafeAwaitMode: "all"` to also report framework/bootstrap awaits such as Fastify plugin
registration. In `all` mode, the rule also reports `await` on Resultar async values inside raw
`Promise<T>` functions; return `ResultAsync` or `Promise<Result>` so the failure channel is preserved
instead of unwrapping and throwing from the Promise boundary.

Use `noUnsafeAwaitIgnoreCalls` for framework lifecycle awaits that a project intentionally allows
without wrapping in Resultar. Entries are exact source call paths; bare function identifiers and
dotted property paths are supported, while wildcards and type-aware matching are not:

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "resultar-check",
        "noUnsafeAwait": "error",
        "noUnsafeAwaitMode": "all",
        "noUnsafeAwaitIgnoreCalls": ["startServer", "fastify.after"]
      }
    ]
  }
}
```

The default `noDiscard` mode is neverthrow-style `must-use`: it reports discarded Resultar
expressions and assigned `Result` values that are passed around but never consumed with `match`,
`unwrapOr`, `_unsafeUnwrap`, `isOk`, `isErr`, returned, or explicitly discarded. Use
`--mode direct` for the lower-noise expression-only check.

```sh
pnpm exec resultar-check
pnpm exec resultar-check --mode direct
```

## AST-Only Lint Adapters

Use the AST-only adapters when a lint host should report fast syntax-only Resultar feedback. These
adapters intentionally cover only rules that do not need TypeScript type information; use the
`resultar-check` CLI with the normal project `tsconfig.json` for the full rule set.

The AST-only adapter rules are:

| Rule                                            | Checks                                                |
| ----------------------------------------------- | ----------------------------------------------------- |
| `resultar/no-await-in-safe-try`                 | `await` inside `safeTry` bodies                       |
| `resultar/no-tagged-error-constructor-override` | constructor overrides on `createTaggedError` classes  |
| `resultar/no-throw`                             | raw `throw` statements                                |
| `resultar/no-try-catch-in-safe-try`             | raw `try/catch` inside `safeTry` bodies               |
| `resultar/prefer-tagged-error`                  | native `Error` classes, `err(new Error(...))`, throws |
| `resultar/tagged-error-name-match`              | tagged error runtime name and class name mismatch     |
| `resultar/typed-catch-mapper`                   | missing catch mapper on Resultar try helpers          |
| `resultar/yield-star-in-safe-try`               | plain `yield` inside `safeTry` bodies                 |

### Oxlint

Oxlint can load the same JavaScript plugin surface through `jsPlugins`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "jsPlugins": [
    {
      "name": "resultar",
      "specifier": "./node_modules/resultar-check/dist/eslint/plugin.js"
    }
  ],
  "rules": {
    "resultar/no-await-in-safe-try": "error",
    "resultar/no-tagged-error-constructor-override": "error",
    "resultar/no-throw": "error",
    "resultar/no-try-catch-in-safe-try": "error",
    "resultar/prefer-tagged-error": "error",
    "resultar/tagged-error-name-match": "error",
    "resultar/typed-catch-mapper": "error",
    "resultar/yield-star-in-safe-try": "error"
  }
}
```

The Oxlint configuration schema is shipped by `oxlint`, so package-local configs can use:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json"
}
```

### ESLint

ESLint flat config can load `resultar-check/eslint`:

```js
import resultar from "resultar-check/eslint";

export default [
  {
    plugins: { resultar },
    rules: {
      "resultar/no-await-in-safe-try": "error",
      "resultar/no-tagged-error-constructor-override": "error",
      "resultar/no-throw": "error",
      "resultar/no-try-catch-in-safe-try": "error",
      "resultar/prefer-tagged-error": "error",
      "resultar/tagged-error-name-match": "error",
      "resultar/typed-catch-mapper": "error",
      "resultar/yield-star-in-safe-try": "error"
    }
  }
];
```

### Deno Lint

Deno Lint can load `resultar-check/deno`:

```json
{
  "lint": {
    "plugins": ["npm:resultar-check/deno"],
    "rules": {
      "include": [
        "resultar/no-await-in-safe-try",
        "resultar/no-tagged-error-constructor-override",
        "resultar/no-throw",
        "resultar/no-try-catch-in-safe-try",
        "resultar/prefer-tagged-error",
        "resultar/tagged-error-name-match",
        "resultar/typed-catch-mapper",
        "resultar/yield-star-in-safe-try"
      ]
    }
  }
}
```

### TypeScript Plugin + CLI

The TypeScript plugin plus `resultar-check` CLI path is the full checker. It can run every rule,
including rules that need TypeScript type information. Oxlint, ESLint, Deno Lint, and
`resultar-check` can return the same Resultar diagnostic count only when they run the same AST-only
rule subset.

The default `resultar-check` CLI configuration may report additional type-aware rules such as
`resultar/no-discard`, `resultar/no-unsafe-await`, `resultar/prefer-map-err`,
`resultar/prefer-and-then`, `resultar/unsafe-result-type-assertion`, and
`resultar/no-useless-recovery`.

When you want to compare adapter output with the CLI, create a dedicated CLI project file that
extends the normal `tsconfig.json` and turns off type-aware-only rules:

```json
{
  "$schema": "./node_modules/resultar-check/schema.json",
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "plugins": [
      {
        "name": "resultar-check",
        "noAwaitInSafeTry": "error",
        "noDiscard": "off",
        "noTaggedErrorConstructorOverride": "error",
        "noThrow": "error",
        "noTryCatchInSafeTry": "error",
        "noUnsafeAwait": "off",
        "noUselessRecovery": "off",
        "preferAndThen": "off",
        "preferMapErr": "off",
        "preferTaggedError": "error",
        "taggedErrorNameMatch": "error",
        "typedCatchMapper": "error",
        "unsafeResultTypeAssertion": "off",
        "yieldStarInSafeTry": "error"
      }
    ]
  }
}
```

Then run the CLI against that file:

```sh
pnpm exec resultar-check --project tsconfig.resultar-check.json
```

See `examples/lint` for a parity smoke that runs Oxlint, ESLint, and the CLI against the same
fixture and fails if the per-rule counts differ.

Rule IDs stay under the `resultar/` namespace for stable lint output and config.
