# Resultar Check

**Resultar-aware diagnostics for TypeScript >=7. Start with the CLI and TypeScript language server;
use lint adapters for additional AST-only feedback.**

TypeScript can prove that a value has type `Result<T, E>`. It cannot prove that the value was handled,
that a `safeTry` flow preserved its error channel, or that application code avoided falling back to
`throw`, raw `await`, and broad `try/catch` patterns. General-purpose linters do not understand those
contracts without Resultar-specific rules.

`resultar-check` turns those contracts into executable project policy. One package provides:

- a **CLI** that runs TypeScript first and then applies every enabled Resultar rule over the same
  project;
- a **TypeScript language-service plugin** for the same diagnostics in the editor;
- an **Oxlint JavaScript plugin** for optional fast, syntax-only feedback;
- equivalent AST-only adapters for **ESLint** and **Deno Lint**.

Use the CLI as the project and CI quality gate, and use the TypeScript language server for feedback
while editing. Oxlint, ESLint, and Deno Lint are optional AST-only integrations for existing lint
stacks. All surfaces use stable `resultar/*` rule IDs.

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
- **Adopt incrementally.** Start with the CLI and TypeScript language server, then add the nine
  syntax-only rules through Oxlint, ESLint, or Deno Lint when those hosts are useful.

### Deterministic Guardrails For AI-Assisted Code

AI coding tools can generate valid TypeScript while falling back to common JavaScript patterns such
as `throw new Error`, unhandled return values, raw Promise awaits, or generic `try/catch`. Those
patterns may be reasonable in another codebase but violate a Resultar architecture.

Resultar Check gives that probabilistic workflow a deterministic correction loop:

1. The agent writes or refactors code.
2. `resultar-check` verifies type-aware contracts across the project.
3. The TypeScript language server reports the same rules beside editor type errors.
4. Optional lint adapters report syntax-only issues in the project's existing lint stack.
5. The agent receives a stable rule ID and an actionable diagnostic instead of relying on reviewer
   memory.

This works with any coding agent that can run project commands; no model-specific integration is
required. It does not replace tests or review. It makes the architecture explicit enough for humans
and agents to validate the same rules repeatedly.

## Recommended Workflow

| Stage | Tool | What it catches | Why use it |
| --- | --- | --- | --- |
| CI, release, and explicit project checks | `resultar-check` CLI | TypeScript diagnostics plus all configured Resultar rules | Authoritative project-wide gate |
| Editor | TypeScript language-service plugin | Full Resultar diagnostics beside TypeScript errors | Problems appear where code is written |
| Write, save, staged files | Oxlint + Resultar plugin | Nine syntax-only Resultar rules | Optional low-latency structural feedback |
| Existing lint stack | ESLint or Deno Lint adapter | Same nine AST-only rules | Adopt Resultar policy without replacing the host |

The recommended default is **`resultar-check` for project and CI checks plus the TypeScript
language-service plugin for editor diagnostics**. Add Oxlint, ESLint, or Deno Lint only when their
AST-only feedback fits the surrounding toolchain; none replaces the full checker.

## Requirements

- Node.js 24+
- TypeScript 7+ for the CLI and language-service plugin
- ESM or CommonJS projects; `resultar-check` publishes both module formats

## Quick Start With the CLI

Install Resultar Check and a project-local TypeScript >=7:

```sh
pnpm add -D resultar-check "typescript@>=7"
```

```sh
npm install --save-dev resultar-check "typescript@>=7"
```

Add the CLI to the project scripts:

```json
{
  "scripts": {
    "check": "resultar-check"
  }
}
```

Run the full project check with:

```sh
pnpm exec resultar-check
```

```sh
npx resultar-check
```

The CLI defaults to `tsconfig.json`, runs TypeScript with no emit, and then applies the configured
Resultar rules. Use the same project-local TypeScript and plugin configuration for editor
diagnostics; the setup is described below.

## Add The Full Type-Aware Gate

The CLI quick start is enough to run the default gate. Add the plugin options below when the project
needs to enable or tune specific type-aware rules. `resultar-check` passes `--noEmit` to TypeScript
unless a `--noEmit` flag is already present.

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
        "noThrow": "error",
        "noTryCatch": "error",
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
| `resultar/no-try-catch`                         | `noTryCatch`                       | Disallow project-wide `try/catch`; use typed Resultar catch boundaries instead.    |
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
`noThrow` and `noTryCatch` default to `"off"` because they are strict migration rules. Enable them
when expected domain/application failures should always stay in typed Resultar channels.
`noTryCatch` reports only `try` statements with a `catch`; `try/finally` remains available for
cleanup. The narrower `noTryCatchInSafeTry` remains enabled by default to protect `safeTry`
composition. `noThrow` reports all `throw` statements in inspected source files, including throws
inside `tryResultAsync` boundaries; use `ignoreFilePatterns` for test, script, or process-boundary
files that intentionally use terminal exception control flow.

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

## Optional AST-Only Lint Adapters

Add a lint adapter only after the CLI and TypeScript language server are working. These adapters
provide fast syntax-only feedback through an existing lint host, but they cannot run rules that need
TypeScript type information. Keep `resultar-check` as the authoritative project and CI gate.

The adapters expose the same nine structural rules:

| Rule                                            | Checks                                                |
| ----------------------------------------------- | ----------------------------------------------------- |
| `resultar/no-await-in-safe-try`                 | `await` inside `safeTry` bodies                       |
| `resultar/no-tagged-error-constructor-override` | constructor overrides on `createTaggedError` classes  |
| `resultar/no-throw`                             | raw `throw` statements                                |
| `resultar/no-try-catch`                         | project-wide `try/catch` blocks                       |
| `resultar/no-try-catch-in-safe-try`             | raw `try/catch` inside `safeTry` bodies               |
| `resultar/prefer-tagged-error`                  | native `Error` classes, `err(new Error(...))`, throws |
| `resultar/tagged-error-name-match`              | tagged error runtime name and class name mismatch     |
| `resultar/typed-catch-mapper`                   | missing catch mapper on Resultar try helpers          |
| `resultar/yield-star-in-safe-try`               | plain `yield` inside `safeTry` bodies                 |

Rule IDs stay under the `resultar/` namespace across the CLI and every lint host.

### Oxlint

Install Oxlint alongside Resultar Check:

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
    "resultar/no-try-catch": "error",
    "resultar/no-try-catch-in-safe-try": "error",
    "resultar/prefer-tagged-error": "error",
    "resultar/tagged-error-name-match": "error",
    "resultar/typed-catch-mapper": "error",
    "resultar/yield-star-in-safe-try": "error"
  }
}
```

Add an optional script:

```json
{
  "scripts": {
    "lint:resultar": "oxlint --config oxlint.config.json"
  }
}
```

Oxlint loads the packaged JavaScript rule modules through `jsPlugins`. The `$schema` entry provides
completion for the host configuration; the plugin registers the Resultar rules.

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
      "resultar/no-try-catch": "error",
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
        "resultar/no-try-catch",
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

For executable parity checks across Oxlint, ESLint, and the CLI, see the
[lint adapter example](https://github.com/inaiat/resultar/tree/main/examples/lint). It deliberately
configures the CLI with only this AST-only subset so the reported rule counts can be compared.
