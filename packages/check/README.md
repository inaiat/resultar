# Resultar Check

**Resultar-aware linting for TypeScript >=7. Fast feedback with Oxlint, full semantic enforcement
with the TypeScript checker.**

TypeScript can prove that a value has type `Result<T, E>`. It cannot prove that the value was handled,
that a `safeTry` flow preserved its error channel, or that application code avoided falling back to
`throw`, raw `await`, and broad `try/catch` patterns. General-purpose linters do not understand those
contracts without Resultar-specific rules.

`resultar-check` turns those contracts into executable project policy. One package provides:

- an **Oxlint JavaScript plugin** for fast, syntax-only feedback;
- a **TypeScript language-service plugin** for diagnostics in the editor;
- a **CLI** that runs TypeScript first and then applies every Resultar rule over the same project;
- equivalent AST-only adapters for **ESLint** and **Deno Lint**.

Use Oxlint continuously while writing code, then keep the full checker as the type-aware quality gate.
Both surfaces use stable `resultar/*` rule IDs, so local feedback and CI speak the same language.

## Why Resultar Check

Result-based error handling is useful only while the failure channel remains visible. Small mistakes
can compile while weakening that guarantee: a returned `Result` is ignored, a type assertion narrows
away an error, `map` creates a nested Resultar value, or a familiar exception pattern appears inside
a `safeTry` workflow.

Resultar Check protects that design at review time:

- **Keep failures explicit.** Detect discarded `Result` and `ResultAsync` values before they become
  silent failure paths.
- **Protect composition.** Guide `map`/`andThen` and `orElse`/`mapErr` usage so pipelines retain the
  intended shape.
- **Enforce Resultar boundaries.** Catch raw `throw`, unsafe `await`, and `try/catch` patterns where
  they bypass typed error channels.
- **Keep domain errors predictable.** Enforce tagged-error construction, names, metadata, and typed
  catch mappers.
- **Adopt incrementally.** Run eight syntax-only rules through Oxlint, or enable the full set of
  fourteen rules when type information is available.

### Deterministic Guardrails For AI-Assisted Code

AI coding tools can generate valid TypeScript while falling back to common JavaScript patterns such
as `throw new Error`, unhandled return values, raw Promise awaits, or generic `try/catch`. Those
patterns may be reasonable in another codebase but violate a Resultar architecture.

Resultar Check gives that probabilistic workflow a deterministic correction loop:

1. The agent writes or refactors code.
2. Oxlint reports structural Resultar mistakes immediately.
3. `resultar-check` verifies type-aware contracts across the project.
4. The agent receives a stable rule ID and an actionable diagnostic instead of relying on reviewer
   memory.

This works with any coding agent that can run project commands; no model-specific integration is
required. It does not replace tests or review. It makes the architecture explicit enough for humans
and agents to validate the same rules repeatedly.

## Recommended Workflow

| Stage | Tool | What it catches | Why use it |
| --- | --- | --- | --- |
| Write, save, staged files | Oxlint + Resultar plugin | Eight syntax-only Resultar rules | Fast feedback without creating a TypeScript Program |
| Editor | TypeScript plugin | Full Resultar diagnostics beside TypeScript errors | Problems appear where code is written |
| CI and release | `resultar-check` CLI | TypeScript diagnostics plus all fourteen Resultar rules | Authoritative project-wide gate |
| Existing lint stack | ESLint or Deno Lint adapter | Same eight AST-only rules | Adopt Resultar policy without replacing the host |

The recommended default is **Oxlint for the inner loop plus `resultar-check` for CI**. Oxlint is not a
reduced replacement for the full checker; it is the low-latency first layer.

## Quick Start With Oxlint

Install Resultar Check and Oxlint:

```sh
pnpm add -D resultar-check oxlint
```

Create `oxlint.config.json`:

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

Add scripts for both feedback layers:

```json
{
  "scripts": {
    "lint:resultar": "oxlint --config oxlint.config.json",
    "check:resultar": "resultar-check"
  }
}
```

Run Oxlint on every local lint pass and `resultar-check` in CI. The AST-only rules need no type
information; the CLI requires a project-local TypeScript >=7 for the complete rule set.

See the runnable
[lint adapter example](https://github.com/inaiat/resultar/tree/main/examples/lint) for a parity test
that verifies Oxlint, ESLint, and the CLI against the same Resultar violations.

## Add The Full Type-Aware Gate

Install project-local TypeScript >=7 for editor diagnostics and CLI checks:

```sh
pnpm add -D resultar-check "typescript@>=7"
```

`resultar-check` defaults to `tsconfig.json` and passes `--noEmit` to TypeScript unless a
`--noEmit` flag is already present.

Configure the TypeScript plugin and type-aware rules in `tsconfig.json`:

```json
{
  "$schema": "./node_modules/resultar-check/schema.json",
  "compilerOptions": {
    "plugins": [
      {
        "name": "resultar-check",
        "ignoreFilePatterns": ["*.test.ts", "*.spec.ts"],
        "noDiscard": "error",
        "noUnsafeAwait": "error",
        "preferMapErr": "error",
        "preferAndThen": "error",
        "unsafeResultTypeAssertion": "error"
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

The [quick-start configuration](#quick-start-with-oxlint) is the recommended adapter path. Oxlint
loads the packaged JavaScript rule modules through `jsPlugins` and reports them with the same
`resultar/*` namespace used by ESLint and the CLI.

This layer deliberately avoids type-dependent guesses. It catches structural Resultar violations
quickly and leaves questions such as whether a value is actually `Result<T, E>` to the TypeScript
plugin and CLI. The `$schema` entry comes from Oxlint and provides completion for the host config;
Resultar rule names are registered by the JavaScript plugin.

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
