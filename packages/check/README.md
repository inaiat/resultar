# Resultar Check

Native, type-aware Resultar diagnostics powered by TypeScript-Go.

`resultar-check` opens a TypeScript project once, reports compiler errors, and runs all enabled
Resultar diagnostics over the same typed program. Version 3 is native-only: the npm package contains
a small Node launcher and selects the matching Go binary for the current platform.

## Highlights

- 22 type-aware rules for `Result`, `ResultAsync`, `ResultTask`, tagged errors, and safe generators;
- TypeScript compiler and Resultar diagnostics from one `tsconfig.json` project pass;
- human, JSON Lines, SARIF 2.1.0, and JUnit output for local development and CI;
- per-rule severities, file overrides, line suppressions, and configurable failure policy;
- stdio LSP diagnostics and safe composition quick fixes;
- `init` and `doctor` commands for portable project-local Zed setup;
- native packages for macOS, Linux, and Windows on ARM64 and x64.

## Install

```sh
pnpm add -D resultar-check
```

```sh
npm install --save-dev resultar-check
```

Keep optional dependencies enabled. The launcher installs one matching native package:

| Operating system | Architectures |
| --- | --- |
| macOS | ARM64, x64 |
| Linux | ARM64, x64 |
| Windows | ARM64, x64 |

Node.js 24 or newer is required by the launcher. A separate TypeScript installation is not required.
If the platform package is missing, the command reports an installation error; version 3 has no
JavaScript or TypeScript fallback.

## Quick Start

Add the command to the project scripts:

```json
{
  "scripts": {
    "check": "resultar-check"
  }
}
```

Configure rules in the TypeScript project:

```json
{
  "$schema": "./node_modules/resultar-check/schema.json",
  "compilerOptions": {
    "plugins": [
      {
        "name": "resultar-check",
        "noDiscard": "error",
        "noPromiseInResultSuccess": "warning",
        "yieldStarInResultTaskGen": "error"
      }
    ]
  }
}
```

Then run:

```sh
pnpm check
```

The `plugins` entry is configuration consumed by the native CLI and LSP server. It does not install
a TypeScript language-service plugin or editor extension.

## Command Line

With no subcommand, `resultar-check` analyzes the project and writes diagnostics:

```text
Usage: resultar-check

Flags:
  --mode <direct|must-use>            Override noDiscardMode.
  -p, --project <path>                TypeScript project (default: tsconfig.json).
  --format <human|json|sarif|junit>   Diagnostic output format (default: human).
  --json                              Alias for --format json.
  --fail-on <severity>                Exit 1 at or above this severity (default: message).
  -h, --help                          Show help.
```

Additional commands:

| Command | Purpose |
| --- | --- |
| `resultar-check lsp --project tsconfig.json` | Run the stdio language server |
| `resultar-check init --project tsconfig.json` | Create the portable Zed LSP configuration |
| `resultar-check init --force` | Refresh the Resultar Zed entry while preserving other settings |
| `resultar-check doctor --project tsconfig.json` | Check the project, launcher, pnpm, and Zed setup |
| `resultar-check --version` | Print the launcher package version |

Compiler diagnostics are always included. Resultar diagnostics use their configured severity, and
the process exits with status `1` when a compiler error or a diagnostic at or above `failOn` exists.

## Output Formats

The same findings can feed local development, scripts, and CI systems:

| Format | Command | Intended consumer |
| --- | --- | --- |
| Human | `resultar-check` | Terminals and local development |
| JSON Lines | `resultar-check --json` | Streaming scripts and custom tooling |
| SARIF 2.1.0 | `resultar-check --format sarif` | Code scanning and security platforms |
| JUnit | `resultar-check --format junit` | CI test report viewers |

`--json` emits one JSON object per line. SARIF and JUnit emit one complete document. Use
`--fail-on warning`, for example, to keep suggestions visible while failing CI only on warnings and
errors.

## Editor And LSP Setup

Run the native stdio server directly from any editor that supports a custom language server:

```sh
pnpm exec resultar-check lsp --project tsconfig.json
```

The server publishes diagnostics on open, change, and save events and reuses the last project
analysis until a save or watched-file event invalidates it. TypeScript-Go currently opens the
project from disk, so unsaved buffers retain the last disk-backed diagnostics until saved.

For Zed, the project-local setup is generated and checked with:

```sh
pnpm exec resultar-check init --project tsconfig.json
pnpm exec resultar-check doctor --project tsconfig.json
```

`init` creates `.zed/settings.json` with a project-local
`pnpm exec resultar-check lsp --project tsconfig.json` command. Existing settings are left untouched
unless `--force` is passed; forced updates merge the Resultar entries with unrelated settings.

The LSP offers quick fixes for:

- explicitly discarding a directly ignored Resultar value with `void`;
- replacing `yield` or `await` with `yield*` for Resultar values inside `safeTry`;
- replacing plain `yield` with `yield*` inside `ResultTask.gen`.

Findings that require an application-specific error mapper, such as a raw Promise `await`, remain
guided diagnostics instead of unsafe automatic rewrites.

## Configuration

A complete configuration can combine global policy, individual rule options, and file overrides:

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "resultar-check",
        "ignoreFilePatterns": ["**/*.generated.ts", "scripts/**"],
        "failOn": "warning",
        "noDiscard": "error",
        "noDiscardMode": "must-use",
        "noThrow": "warning",
        "noTryCatch": "warning",
        "noUnsafeAwait": "warning",
        "noUnsafeAwaitMode": "resultar-context",
        "noUnsafeAwaitIgnoreCalls": ["fastify.ready"],
        "diagnosticSeverity": {
          "prefer-map": "off",
          "resultar/yield-star-in-result-task-gen": "error"
        },
        "overrides": [
          {
            "include": ["src/**/*.test.ts"],
            "options": {
              "diagnosticSeverity": {
                "no-throw": "off"
              }
            }
          }
        ]
      }
    ]
  }
}
```

Rule severities are `error`, `warning`, `suggestion`, `message`, or `off`.
`diagnosticSeverity` accepts camelCase, kebab-case, or the full `resultar/<rule>` ID. Overrides are
applied in declaration order, so later matching entries take precedence.

`noDiscardMode` supports:

- `must-use` (default): reports direct discards and assigned Resultar values that are never handled,
  returned, or explicitly discarded;
- `direct`: reports only directly discarded expressions.

`noUnsafeAwaitMode` supports:

- `resultar-context` (default): checks raw Promise awaits in functions and generators that return a
  Resultar type;
- `all`: checks raw Promise awaits in every analyzed async context.

`noUnsafeAwaitIgnoreCalls` accepts exact source call paths such as `fastify.ready`. Entries are not
wildcards: allowing `fastify.ready` does not allow `app.ready` or every method on `fastify`.

For an intentional exception, suppress one line with:

```ts
// resultar-check-disable-next-line no-throw
throw expectedBoundaryError

await runLegacyBoundary() // resultar-check-disable-line no-unsafe-await
```

Omitting the rule ID disables all Resultar rules for that line. TypeScript compiler diagnostics are
not suppressed by Resultar comments.

## Diagnostics

| Rule | Option | Default | What it checks |
| --- | --- | --- | --- |
| `no-await-in-safe-try` | `noAwaitInSafeTry` | `error` | Prevents `await` from unwrapping Resultar control flow inside `safeTry` |
| `no-discard` | `noDiscard` | `error` | Requires `Result`, `ResultAsync`, and `ResultTask` values to be handled, returned, or explicitly discarded |
| `no-promise-in-result-success` | `noPromiseInResultSuccess` | `warning` | Prevents Promises inside synchronous `Result` or lazy `ResultTask` success channels |
| `no-tagged-error-constructor-override` | `noTaggedErrorConstructorOverride` | `warning` | Protects the constructor generated by `createTaggedError` |
| `no-throw` | `noThrow` | `off` | Reports throw-based expected-failure control flow |
| `no-try-catch` | `noTryCatch` | `off` | Reports broad `try`/`catch` where a typed Resultar boundary is preferred |
| `no-try-catch-in-safe-try` | `noTryCatchInSafeTry` | `warning` | Keeps throwing APIs outside `safeTry` generators |
| `no-unsafe-await` | `noUnsafeAwait` | `off` | Reports Promise awaits that can reject outside a typed Resultar boundary |
| `no-unknown-result-error` | `noUnknownResultError` | `suggestion` | Rejects `unknown` or `any` Resultar error channels |
| `no-useless-recovery` | `noUselessRecovery` | `warning` | Removes recovery operators from infallible error channels |
| `prefer-and-then` | `preferAndThen` | `warning` | Replaces `map` callbacks that return Resultar values with fallible chaining |
| `prefer-catch-reason` | `preferCatchReason` | `warning` | Uses reason-aware recovery instead of manually checking nested reason tags |
| `prefer-first-success-of` | `preferFirstSuccessOf` | `warning` | Replaces long independent fallback chains with ordered candidates |
| `prefer-map` | `preferMap` | `warning` | Replaces fallible chaining that only wraps a plain success value |
| `prefer-map-err` | `preferMapErr` | `warning` | Replaces recovery that only transforms an error into another error |
| `prefer-result-for-each` | `preferResultForEach` | `warning` | Replaces map-then-combine allocation with Resultar collection helpers |
| `prefer-tagged-error` | `preferTaggedError` | `warning` | Encourages stable tagged domain errors over plain `Error` values |
| `tagged-error-name-match` | `taggedErrorNameMatch` | `warning` | Keeps the generated runtime tag equal to the TypeScript class name |
| `typed-catch-mapper` | `typedCatchMapper` | `warning` | Requires throwing and rejecting boundaries to map causes into concrete errors |
| `unsafe-result-type-assertion` | `unsafeResultTypeAssertion` | `warning` | Prevents assertions that narrow away possible Resultar failures |
| `yield-star-in-result-task-gen` | `yieldStarInResultTaskGen` | `warning` | Requires `yield*` for tasks and services inside `ResultTask.gen` |
| `yield-star-in-safe-try` | `yieldStarInSafeTry` | `warning` | Requires `yield*` to compose Resultar values inside `safeTry` |

Rules understand both method and static composition forms where applicable. ResultTask-aware checks
cover ignored tasks, unknown or narrowed error channels, nested tasks returned from `map`, Promises
stored in task successes, useless `catchAll`, and generator composition.

## Migrating To Version 3

Version 3 intentionally removes the legacy JavaScript checker surface. Applications upgrading from
version 2 should account for these breaking changes:

- use the `resultar-check` CLI or stdio LSP instead of importing a JavaScript diagnostics API;
- remove ESLint, Deno, TypeScript language-service, and syntax-only Resultar adapters;
- keep the `compilerOptions.plugins` entry only as native checker configuration;
- allow optional npm dependencies so the platform binary can be installed;
- remove the standalone TypeScript peer dependency if nothing else in the project needs it;
- update CI integrations to consume human, JSON Lines, SARIF, or JUnit output;
- use Node.js 24 or newer for the launcher.

There is no fallback implementation. This keeps CLI, CI, and editor diagnostics on the same typed
TypeScript-Go analyzer and avoids rule drift between hosts.

## Package Shape

The npm package exposes:

- the `resultar-check` executable, including `lsp`, `init`, and `doctor`;
- `resultar-check/schema.json` for editor completion and configuration validation;
- one optional native package for the current operating system and architecture.

It does not expose a JavaScript diagnostics API, editor extension, TypeScript plugin implementation,
or JSR package. The Node entry point only selects and executes the matching native binary.

For backend architecture, local Go commands, and TypeScript-Go revision details, see the
[native backend README](native/README.md). For an executable catalog of every rule, see the
[Resultar Check example](../../examples/check/README.md).

## License

MIT
