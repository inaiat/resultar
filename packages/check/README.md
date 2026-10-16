# Resultar Check

Native, type-aware Resultar diagnostics powered by TypeScript-Go.

`resultar-check` opens a TypeScript project once, reports compiler errors, and runs all enabled
Resultar diagnostics over the same typed program. Version 3 is native-only: the npm package contains
a small Node launcher and selects the matching Go binary for the current platform.

## Highlights

- Type-aware rules for `Result`, `ResultAsync`, `ResultTask`, tagged errors, and safe generators;
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

The `$schema` combines the standard [SchemaStore tsconfig schema](https://json.schemastore.org/tsconfig.json)
with Resultar options. Editors can complete and validate both TypeScript options such as `strict`,
`target`, and `moduleResolution`, and Resultar rule severities. The editor needs access to SchemaStore
or a cached copy to resolve the standard schema. This schema does not select a compiler version;
the native checker validates the project with its bundled TypeScript-Go compiler.

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
| `resultar-check overview --project tsconfig.json --json` | Inventory exported Resultar functions/values, tagged errors, and services |
| `resultar-check quickfixes --project tsconfig.json --file src/workflow.ts` | Preview diagnostics with proposed edits without writing files |
| `resultar-check lsp --project tsconfig.json` | Run the stdio language server |
| `resultar-check init --project tsconfig.json` | Create the portable Zed LSP configuration |
| `resultar-check init --force` | Refresh the Resultar Zed entry while preserving other settings |
| `resultar-check doctor --project tsconfig.json` | Check the project, launcher, pnpm, and Zed setup |
| `resultar-check --version` | Print the launcher package version |

Compiler diagnostics are always included. Resultar diagnostics use their configured severity, and
the process exits with status `1` when a compiler error or a diagnostic at or above `failOn` exists.

`overview` and `quickfixes` support `--file` (relative to the project directory),
`--format human|json`, and `--json`. `overview --json` emits one document with
`schemaVersion: 1` and sorted `entries`, containing declaration/export locations and
`success`, `error`, and `requirements` channels where applicable. Reexports retain the
original declaration and the exporting module. Services include identifier/contract;
tagged error constructors include their tag.

`quickfixes --json` emits diagnostic JSONL with fix titles, kinds, explanations, and text
edits. Human output shows the old/new snippets. Preview commands exit `0` after successful
analysis, even when fixes exist; project/compiler failures exit `1` and go to stderr.
They never apply changes. Use the default command for the CI diagnostic gate.

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

JSONL `fixes` include `kind: "correction"` or `kind: "intentional-discard"`. The latter is
an explicit decision to ignore a value, not an error-handling or execution repair: `void task`
does not run a lazy ResultTask. Each discard suggestion includes an explanation. LSP code actions
preserve these fields in `data.kind` and `data.description`. Recheck compilation and behavior
after applying a correction; a local edit can require follow-up changes in the surrounding code.

## Editor And LSP Setup

Run the native stdio server directly from any editor that supports a custom language server:

```sh
pnpm exec resultar-check lsp --project tsconfig.json
```

The server overlays all open buffers on the project filesystem, including new files matched
by the project configuration. Diagnostics reflect unsaved changes in imported dependencies.
Changes are debounced for 150 ms; hover and code-action requests analyze the latest accepted
version immediately. Stale document versions are ignored. Save, close, and watched-file events
refresh the snapshot; closing a buffer restores its disk contents.

Hover separates success `T`, errors `E`, and requirements `R`, including `yield*` task
operands. Match hover shows its input, remaining cases, and matched output. Service hover shows its identifier and contract. Quick fixes and refactors use UTF-16
ranges from the analyzed text and versioned document edits, so editors can reject stale actions.

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
- replacing `yield` or `await` with `yield*` for Resultar values inside `safeTry` / `Result.gen` / `Result.fn`;
- replacing plain `yield` with `yield*` inside `ResultTask.gen` or `ResultTask.fn`;
- replacing `return` / plain `yield*` on an always-failing error inside a generator with `return yield*`;
- unwrapping single-argument `pipe(x)`.

The LSP also offers `refactor.rewrite` actions for:

- a generator that only delegates to an already initialized constant task;
- converting `(...args) => ResultTask.gen(function* () { ... })` / `(...args) => Result.gen(function* () { ... })` into `ResultTask.fn` / `Result.fn`;
- converting between `pipe(value, ...steps)` and `value.pipe(...steps)` on Resultar values;
- tag-based `catchAll` branches;
- consecutive `catchTag` calls with stable handlers.

It declines generators with `finally` and recovery combinations whose first handler could introduce the next handled error. Review the editor preview before applying it.

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
`diagnosticSeverity` accepts either a single severity string (e.g. `"diagnosticSeverity": "error"`) to
set the baseline severity for all 41 rules at once, or a rule map accepting `"*"` as a wildcard plus
camelCase, kebab-case, or the full `resultar/<rule>` ID. Explicit rule properties (either inside
`diagnosticSeverity` alongside `"*"` or at the plugin root) override the wildcard baseline. Overrides are
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

`unused-suppression` tracks each entry against enabled findings before filtering them.
A partially used directive can remove just its unused rule; disabled rules do not produce
unused-entry warnings. Empty/wildcard directives are reported when they suppress nothing,
and unknown IDs are diagnosed. Removal fixes retain trailing justification comments.
The new requirements and suppression rules default to `suggestion`; the default
`failOn: "message"` includes them in CI failures. Configure per-rule severities or raise
`failOn` when adopting them gradually.

## Diagnostics

| Rule | Option | Default | What it checks |
| --- | --- | --- | --- |
| `no-await-in-result-task-gen` | `noAwaitInResultTaskGen` | `warning` | Prevents `await` from breaking laziness and typing inside `ResultTask.gen` / `ResultTask.fn` |
| `no-await-in-safe-try` | `noAwaitInSafeTry` | `error` | Prevents `await` from unwrapping Resultar control flow inside `safeTry` / `Result.gen` / `Result.fn` |
| `no-discard` | `noDiscard` | `error` | Requires `Result`, `ResultAsync`, `ResultTask`, and `MatchMatcher` values to be handled, returned, or explicitly discarded |
| `no-fn-iife` | `noFnIife` | `warning` | Replaces immediately invoked `ResultTask.fn(...)()` / `Result.fn(...)()` with `ResultTask.gen(...)` / `Result.gen(...)` |
| `no-invalid-lifetime` | `noInvalidLifetime` | `warning` | Rejects dependencies a longer-lived service cannot capture, such as a singleton on a scoped service |
| `no-promise-in-result-success` | `noPromiseInResultSuccess` | `warning` | Prevents Promises inside synchronous `Result` or lazy `ResultTask` success channels |
| `no-result-in-task-gen` | `noResultInTaskGen` | `warning` | Requires `ResultTask.gen` / `ResultTask.fn` and `Result.gen` / `Result.fn` bodies to return plain success values instead of nested `ok`/`err` results |
| `no-run-inside-gen` | `noRunInsideGen` | `warning` | Prevents executing task runners (`runPromise`, `runResult`, `runExit`, `runFork`, `toResultAsync`, `ResultAsync.fromTask`) or `_unsafeUnwrap` / `unwrapOrThrow` inside a Resultar generator |
| `no-tagged-error-constructor-override` | `noTaggedErrorConstructorOverride` | `warning` | Protects the constructor generated by `createTaggedError` |
| `no-throw` | `noThrow` | `off` | Reports throw-based expected-failure control flow |
| `no-throw-in-task-sync` | `noThrowInTaskSync` | `warning` | Reports `throw` inside `ResultTask.sync`, where failures become defects instead of typed errors |
| `no-try-catch` | `noTryCatch` | `off` | Reports broad `try`/`catch` where a typed Resultar boundary is preferred |
| `no-try-catch-in-safe-try` | `noTryCatchInSafeTry` | `warning` | Keeps throwing APIs outside `safeTry` / `Result.gen` / `Result.fn` generators |
| `no-unnecessary-err-wrap-in-gen` | `noUnnecessaryErrWrapInGen` | `suggestion` | Prefers `TaggedError.err(...)` / `TaggedError.taskErr(...)` over wrapping `new TaggedError(...)` in `err(...)` / `ResultTask.err(...)` inside a generator |
| `no-unsafe-await` | `noUnsafeAwait` | `off` | Reports Promise awaits that can reject outside a typed Resultar boundary |
| `no-unknown-result-error` | `noUnknownResultError` | `suggestion` | Rejects `unknown` or `any` Resultar error channels |
| `no-unknown-task-requirements` | `noUnknownTaskRequirements` | `suggestion` | Rejects `unknown` or `any` task requirements, including type aliases |
| `unused-suppression` | `unusedSuppression` | `suggestion` | Reports unknown suppression IDs and unused entries for enabled rules |
| `no-unscoped-acquire-release` | `noUnscopedAcquireRelease` | `warning` | Requires `acquireRelease` / `acquireDisposable` workflows in `ResultTask.gen` / `ResultTask.fn` to run under `ResultTask.scoped` |
| `no-useless-recovery` | `noUselessRecovery` | `warning` | Removes recovery operators from infallible error channels |
| `prefer-acquire-disposable` | `preferAcquireDisposable` | `suggestion` | Prefers `ResultTask.acquireDisposable` when `acquireRelease` only calls `[Symbol.dispose]` / `[Symbol.asyncDispose]` |
| `prefer-and-then` | `preferAndThen` | `warning` | Replaces `map` callbacks that return Resultar values with fallible chaining |
| `prefer-as-void` | `preferAsVoid` | `suggestion` | Replaces `.map(() => undefined)` with `.asVoid()` on `ResultTask` |
| `prefer-catch-reason` | `preferCatchReason` | `warning` | Uses reason-aware recovery instead of manually checking nested reason tags |
| `prefer-filter-or-else` | `preferFilterOrElse` | `suggestion` | Replaces `andThen` / `flatMap` callbacks that only branch on a predicate to return the input or an error with `filterOrElse` |
| `prefer-first-success-of` | `preferFirstSuccessOf` | `warning` | Replaces long independent fallback chains with ordered candidates (`firstSuccessOf` / `ResultTask.firstSuccessOf`) |
| `prefer-map` | `preferMap` | `warning` | Replaces fallible chaining that only wraps a plain success value |
| `prefer-map-err` | `preferMapErr` | `warning` | Replaces recovery that only transforms an error into another error |
| `prefer-or-else-succeed` | `preferOrElseSucceed` | `suggestion` | Replaces `orElse` / `catchAll` callbacks that unconditionally wrap a fallback in `ok` / `ResultTask.ok` with `orElseSucceed` |
| `prefer-result-async` | `preferResultAsync` | `warning` | Reports `Promise<Result>` and `Promise<StrictResult>` contracts and inferred function returns; mode `all` also reports raw Promise contracts |
| `prefer-result-for-each` | `preferResultForEach` | `warning` | Replaces map-then-combine allocation with Resultar collection helpers (`forEachResult`, `forEachResultAsync`, `ResultTask.forEach`) |
| `prefer-tagged-error` | `preferTaggedError` | `warning` | Encourages stable tagged domain errors over plain `Error` values |
| `prefer-tap` | `preferTap` | `suggestion` | Replaces `map` / `andThen` callbacks that perform a side effect and return their input unchanged with `tap` |
| `prefer-tap-error` | `preferTapError` | `suggestion` | Replaces `orElse` / `catchAll` callbacks that perform a side effect and re-wrap the same error with `tapError` |
| `require-return-yield-star` | `requireReturnYieldStar` | `suggestion` | Requires `return yield*` when yielding an always-failing error (`Err<never, E>` / `ResultTask<never, E, R>`) so TypeScript narrows control flow |
| `tagged-error-name-match` | `taggedErrorNameMatch` | `warning` | Keeps the generated runtime tag equal to the TypeScript class name |
| `typed-catch-mapper` | `typedCatchMapper` | `warning` | Requires throwing and rejecting boundaries to map causes into concrete errors |
| `unnecessary-pipe` | `unnecessaryPipe` | `suggestion` | Reports single-argument `pipe(x)` and zero-argument `.pipe()` calls |
| `unsafe-result-type-assertion` | `unsafeResultTypeAssertion` | `warning` | Prevents assertions that remove Resultar failures, task services, or deferred scope errors (including unknown bridges) |
| `yield-star-in-result-task-gen` | `yieldStarInResultTaskGen` | `warning` | Requires `yield*` for tasks and services inside `ResultTask.gen` / `ResultTask.fn` |
| `yield-star-in-safe-try` | `yieldStarInSafeTry` | `warning` | Requires `yield*` to compose Resultar values inside `safeTry` / `Result.gen` / `Result.fn` |

Rules understand both method, static data-first, and curried `pipe` composition forms where applicable (including `Semaphore.withPermit` / `withPermits`, `Fiber` operations, `Match` finalizers, and static `Result` / `ResultAsync` / `ResultTask` helpers). ResultTask-aware checks
cover ignored tasks, unknown or narrowed error and requirements channels, nested tasks returned from `map`, Promises
stored in task successes, useless recovery, and generator composition. Task checks and recovery refactors
understand both `mapError` / `flatMap` / `catchAll` and `mapErr` / `andThen` / `orElse`, so existing
workflows remain valid during gradual adoption of the consistent method names.

Generator rules also cover `Result.gen`, `Result.fn`, and `ResultTask.fn`. Static ResultTask and Result namespace recognition and
generator recognition resolve imported symbols, including renamed imports, namespace imports,
and barrel reexports. Rule IDs retain the `safe-try` spelling for `safeTry`, `Result.gen`, and `Result.fn`.

`prefer-result-async` checks type references (including aliases, interface properties and methods)
and inferred function returns. `preferResultAsyncMode` controls its scope:

- `result` (default): reports `Promise<Result>` and `Promise<StrictResult>`. Ordinary promises and
  unrelated types named `Result` remain valid.
- `all`: also reports raw `Promise<T>` contracts such as a repository returning
  `Promise<User | undefined>`, including Promise members of unions and intersections. Removing an
  annotation does not bypass the rule: inferred Promise-returning functions are checked too.

Both modes leave `ResultAsync`, `StrictResultAsync`, `ResultTask`, `PromiseLike` interoperability
contracts and unrelated types named `Promise` alone. The rule provides migration guidance instead
of an annotation-only fix: an `async` function still returns a native Promise even when its body
returns a `ResultAsync`.

Return the composed operation directly and capture external failures where they originate:

```ts
import { tryResultAsync, type StrictResultAsync } from 'resultar'

const load = (): StrictResultAsync<User, LoadError> =>
  tryResultAsync(fetchUser, cause => new LoadError({ cause }))
```

Set `"preferResultAsync": "error"` to enforce the convention. To require typed async results for
repositories and services even when their current contract has no Result, also set
`"preferResultAsyncMode": "all"`, as in the Fastify example. Map driver failures in the repository
adapter and compose that result in the service instead of wrapping the repository again.

Deliberate native execution or interoperability boundaries can use a line suppression for this
rule, or a file severity override for dedicated boundary files. This includes Fastify's native
bootstrap/handler contracts and Promise-returning driver callbacks passed to conversion helpers;
the rule does not automatically exempt callbacks. Keep suppressions at the conversion boundary,
with the reason documented, so application contracts stay checked.

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
