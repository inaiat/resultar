# Resultar Check

Native, type-aware Resultar diagnostics powered by TypeScript-Go.

`resultar-check` opens the selected TypeScript project, reports compiler errors, and then runs all
enabled Resultar diagnostics over the same compiler program. The Go analyzer is the only
implementation of the rules.

## Install

```sh
pnpm add -D resultar-check
```

The package installs the native executable for the current platform as an optional dependency. Keep
optional dependencies enabled.

Supported targets:

- macOS ARM64 and x64
- Linux ARM64 and x64
- Windows ARM64 and x64

Node.js 24 or newer is required by the small package launcher. A separate TypeScript installation is
not required.

## Command Line

```json
{
  "scripts": {
    "check": "resultar-check"
  }
}
```

The command reads `tsconfig.json` from the current directory by default:

```sh
pnpm check
```

Available flags:

```text
Usage: resultar-check

Flags:
  --mode <direct|must-use>  Override noDiscardMode.
  -p, --project <path>      TypeScript project. Defaults to tsconfig.json.
  --format <human|json|sarif|junit>  Diagnostic output format (default: human).
  --json                    Alias for --format json (JSON lines).
  --fail-on <severity>      Exit 1 at or above this severity (default: message).
  -h, --help                Show this help.
```

The process exits with status `1` when compiler or Resultar diagnostics are present.

For editor integration, run `resultar-check lsp` as a stdio language server. It publishes
diagnostics on `textDocument/didOpen`, `textDocument/didChange`, and `textDocument/didSave`.
Repeated requests reuse the last project analysis; a save or watched-file event invalidates it.
Unsaved `didChange` buffers are tracked and keep the last disk-backed diagnostics until the file is
saved, because TypeScript-Go currently opens the project from disk.

For a portable Zed setup, run these commands from the project root:

```sh
pnpm exec resultar-check init --project tsconfig.json
pnpm exec resultar-check doctor --project tsconfig.json
```

`init` creates or refreshes `.zed/settings.json` with a project-local `pnpm exec resultar-check lsp`
command. Existing settings are preserved unless `--force` is passed. `doctor` checks the project,
local binary, pnpm, and the configured Zed LSP entry.

`--format json` emits one JSON object per line. `sarif` emits SARIF 2.1.0 and `junit` emits a JUnit
test suite, so CI systems can consume the same analyzer results without another adapter.

## Configuration

Configuration lives in the project's `tsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "resultar-check",
        "ignoreFilePatterns": ["**/*.test.ts", "scripts/**"],
        "failOn": "warning",
        "noDiscard": "error",
        "noDiscardMode": "must-use",
        "noThrow": "warning",
        "noTryCatch": "warning",
        "diagnosticSeverity": {
          "prefer-map": "off",
          "resultar/no-unsafe-await": "error"
        },
        "overrides": [
          {
            "include": ["src/**/*.test.ts"],
            "options": {
              "diagnosticSeverity": { "no-throw": "off" }
            }
          }
        ]
      }
    ]
  }
}
```

The `plugins` entry is configuration consumed by the native CLI and the stdio LSP server; it does
not install an editor extension.

Rule severities are `error`, `warning`, `suggestion`, `message`, or `off`.

The LSP offers quick fixes for directly discarded Resultar values (`void `), for `yield`/`await` of
Resultar values inside `safeTry` (`yield*`), and for plain `yield` inside `ResultTask.gen` (`yield*`).
Assigned values in `must-use` mode and unsafe raw
Promise `await` findings are left as guided diagnostics because an automatic wrapper would need
application-specific error handling.

`noDiscardMode` supports:

- `must-use` (default): reports direct discards and assigned Resultar values that are never handled,
  returned, or explicitly discarded;
- `direct`: reports only directly discarded expressions.

`noUnsafeAwaitMode` supports `resultar-context` (default) and `all`.
`noUnsafeAwaitIgnoreCalls` accepts exact call paths such as `fastify.ready`.

`diagnosticSeverity` accepts stable rule ids in camelCase, kebab-case, or `resultar/<rule>` form.
An `overrides` entry has `include` globs and an `options.diagnosticSeverity` map. Matching entries
are applied in declaration order, with later entries taking precedence.

For an intentional exception, suppress one line with a comment such as
`// resultar-check-disable-next-line no-throw` or append
`// resultar-check-disable-line no-throw` to the offending line. Omitting the rule disables all
Resultar rules for that line.

## Diagnostics

| Option                             | Default      |
| ---------------------------------- | ------------ |
| `noAwaitInSafeTry`                 | `error`      |
| `noDiscard`                        | `error`      |
| `noPromiseInResultSuccess`         | `warning`    |
| `noTaggedErrorConstructorOverride` | `warning`    |
| `noThrow`                          | `off`        |
| `noTryCatch`                       | `off`        |
| `noTryCatchInSafeTry`              | `warning`    |
| `noUnsafeAwait`                    | `off`        |
| `noUnknownResultError`             | `suggestion` |
| `noUselessRecovery`                | `warning`    |
| `preferAndThen`                    | `warning`    |
| `preferCatchReason`                | `warning`    |
| `preferFirstSuccessOf`             | `warning`    |
| `preferMap`                        | `warning`    |
| `preferMapErr`                     | `warning`    |
| `preferResultForEach`              | `warning`    |
| `preferTaggedError`                | `warning`    |
| `taggedErrorNameMatch`             | `warning`    |
| `typedCatchMapper`                  | `warning`    |
| `unsafeResultTypeAssertion`         | `warning`    |
| `yieldStarInResultTaskGen`          | `warning`    |
| `yieldStarInSafeTry`                | `warning`    |

## Package Shape

The npm package exposes:

- the `resultar-check` command, including its stdio LSP mode;
- `resultar-check/schema.json`;
- one optional native package for the current operating system and CPU architecture.

It does not expose a JavaScript diagnostics API or editor extension. If the native package is
unavailable, the command reports an installation error instead of switching implementations.

## License

MIT
