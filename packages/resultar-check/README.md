# Resultar Check

TypeScript 7 diagnostics for Resultar.

`resultar-check` is the canonical Resultar diagnostics package and command. It runs TypeScript 7
first, then runs Resultar diagnostics over the same `tsconfig.json`. Oxlint integration and TS6
patching are no longer shipped as public lint surfaces.

Until TypeScript 7 exposes the stable programmatic type-checker API Resultar needs, the package keeps
a TypeScript 6 diagnostics API as an internal bridge. Projects should still standardize on the
TypeScript 7 `resultar-check` command.

## Install

For editor diagnostics and CLI checks, install `resultar-check` with a project-local TypeScript RC:

```sh
pnpm add -D resultar-check typescript@rc
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

`resultar-check` resolves a project-local `typescript@7` first, then `typescript-7`. If a project
cannot replace its `typescript` package yet and only needs the CLI path, use the compatibility alias:

```sh
pnpm add -D resultar-check typescript-7@npm:typescript@rc
```

## Editor Integration

`resultar-check` is a TypeScript language-service plugin. Editors must run a TypeScript server that
can resolve the local `resultar-check` package and see the `compilerOptions.plugins` entry above.

Use `typescript@rc` for editor integration. The `typescript-7` alias is only for projects that need
the CLI compatibility path and cannot replace their `typescript` package yet.

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

## Deprecated Packages

`resultar-lint` and `resultar-tsgo` are compatibility wrappers. New projects should install
`resultar-check` directly and use plugin name `"resultar-check"`.
