# Resultar Check

Native, type-aware Resultar diagnostics powered by TypeScript-Go.

`resultar-check` opens a TypeScript project once, reports compiler errors, and runs all enabled
Resultar diagnostics over the same typed program. Version 3 is native-only: the npm package contains
a small Node launcher and selects the matching Go binary for the current platform.

## Highlights

- Type-aware rules for `Result`, `ResultTask`, opt-in `ResultAsync` (`resultar/async`), tagged errors, and safe generators;
- TypeScript compiler and Resultar diagnostics from one `tsconfig.json` project pass;
- human, JSON Lines, SARIF 2.1.0, and JUnit output for local development and CI;
- per-rule severities, file overrides, line suppressions, and configurable failure policy;
- stdio LSP diagnostics, safe composition quick fixes, `--fix` / `--fix-dry-run` auto-repair, and `migrate-v5` codemod;
- `init` and `doctor` commands for portable Zed, VS Code, and Cursor setup (`--editor zed|vscode|cursor|all`);
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
| ---------------- | ------------- |
| macOS            | ARM64, x64    |
| Linux            | ARM64, x64    |
| Windows          | ARM64, x64    |

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
        "noPromiseResultar": "error",
        "noPromiseInResultSuccess": "warning",
        "preferResultAsync": "off",
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

### Strict Task project preset

To opt into stricter checking, enable `"diagnosticSeverity": "error"`. The example disables
the optional eager-boundary policy for a Task project. Broad unsafe-await checking also
affects framework bootstrap and driver callbacks; configure those boundaries explicitly.

```json
{
  "$schema": "./node_modules/resultar-check/schema.json",
  "compilerOptions": {
    "plugins": [
      {
        "name": "resultar-check",
        "diagnosticSeverity": "error",
        "noDiscardMode": "must-use",
        "noPromiseResultar": "error",
        "noUnsafeAwaitMode": "all",
        "preferResultAsync": "off",
        "failOn": "error",
        "ignoreFilePatterns": ["tests/**", "vite.config.ts"]
      }
    ]
  }
}
```

For repair guidance, severity thresholds, and suppression semantics, see the [checker guide](../../skills/resultar/references/anti-patterns.md). The diagnostic table below is the complete rule reference. A strict preset does not prove absence of runtime defects.

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
  --fix                               Apply safe correction fixes in place (never intentional-discard).
  --fix-dry-run                       Preview safe correction fixes without modifying files.
  --file <path>                       Filter overview, quickfixes, or --fix by source file.
  --mode <direct|must-use>            Override noDiscardMode.
  -p, --project <path>                TypeScript project (default: tsconfig.json).
  --format <human|json|sarif|junit>   Diagnostic output format (default: human).
  --json                              Alias for --format json.
  --fail-on <severity>                Exit 1 at or above this severity (default: message).
  -h, --help                          Show help.
```

Additional commands:

| Command                                                                    | Purpose                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `resultar-check --fix --project tsconfig.json`                             | Apply safe `kind: "correction"` fixes in place and re-verify diagnostics  |
| `resultar-check --fix-dry-run --project tsconfig.json`                     | Preview how many safe correction fixes would be applied without writing   |
| `resultar-check migrate-v5 --project tsconfig.json`                        | Preview v4 -> v5 mechanical edits and manual review items without writing |
| `resultar-check migrate-v5 --fix --project tsconfig.json`                  | Apply safe v4 -> v5 mechanical migration edits in place                   |
| `resultar-check overview --project tsconfig.json --json`                   | Inventory exported Resultar functions/values, tagged errors, and services |
| `resultar-check quickfixes --project tsconfig.json --file src/workflow.ts` | Preview diagnostics with proposed edits without writing files             |
| `resultar-check lsp --project tsconfig.json`                               | Run the stdio language server                                             |
| `resultar-check init --editor zed\|vscode\|cursor\|all`                    | Create portable Zed LSP, VS Code/Cursor tasks, and Cursor rule setup      |
| `resultar-check init --force`                                              | Refresh generated Resultar entries while preserving other editor settings |
| `resultar-check doctor --editor zed\|vscode\|cursor\|all`                  | Check the project, launcher, pnpm, and configured editor setup            |
| `resultar-check --version`                                                 | Print the launcher package version                                        |

Compiler diagnostics are always included. Resultar diagnostics use their configured severity, and
the process exits with status `1` when a compiler error or a diagnostic at or above `failOn` exists.

`--fix` applies only non-overlapping `kind: "correction"` edits (it **never** auto-applies
`kind: "intentional-discard"` edits such as `void expr`), converges over multiple passes if needed,
writes the fix summary to stderr (keeping `--json` / `--format sarif` / `--format junit` stdout
machine-readable), and re-analyzes the project so the exit code reflects remaining diagnostics.

`overview`, `quickfixes`, and `--fix` / `--fix-dry-run` support `--file` (relative to the project directory).
`overview` and `quickfixes` also support `--format human|json` and `--json`. `overview --json` emits one document with
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

| Format      | Command                         | Intended consumer                    |
| ----------- | ------------------------------- | ------------------------------------ |
| Human       | `resultar-check`                | Terminals and local development      |
| JSON Lines  | `resultar-check --json`         | Streaming scripts and custom tooling |
| SARIF 2.1.0 | `resultar-check --format sarif` | Code scanning and security platforms |
| JUnit       | `resultar-check --format junit` | CI test report viewers               |

`--json` emits one JSON object per line. SARIF and JUnit emit one complete document. Use
`--fail-on warning`, for example, to keep suggestions visible while failing CI only on warnings and
errors.

JSONL `fixes` include `kind: "correction"` or `kind: "intentional-discard"`. The latter is
an explicit decision to ignore a value, not an error-handling or execution repair: `void task`
does not run a lazy ResultTask. Each discard suggestion includes an explanation. LSP code actions
preserve these fields in `data.kind` and `data.description`. Recheck compilation and behavior
after applying a correction; a local edit can require follow-up changes in the surrounding code.

## Editor And LSP Setup

- `resultar-check lsp --project tsconfig.json` runs the native stdio language server (works directly in Zed via `resultar-check init`, or in VS Code / Cursor via the official thin [VS Code & Cursor extension](../../editors/vscode/README.md)).
- `resultar-check init --editor vscode|cursor|all` writes `.vscode/tasks.json` (problemMatcher for `resultar-check` and `resultar-check: fix`), recommends `inaiat.resultar-check` in `.vscode/extensions.json`, and (for `cursor` / `all`) creates `.cursor/rules/resultar-check.mdc`.

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
- replacing `await task` with `await task.runResult()` when a narrowed, requirement-free `ResultTask` is awaited where a `Result` is expected;
- replacing `yield` or `await` with `yield*` for Resultar values inside `Result.gen` / `Result.fn` / `ResultAsync.gen` / `ResultAsync.fn` / legacy `safeTry`;
- replacing plain `yield` with `yield*` inside `ResultTask.gen` or `ResultTask.fn`;
- replacing `return` / plain `yield*` on an always-failing error inside a generator with `return yield*`;
- unwrapping single-argument `pipe(x)`.

The LSP also offers `refactor.rewrite` actions for:

- a generator that only delegates to an already initialized constant task;
- converting `(...args) => ResultTask.gen(function* () { ... })` / `(...args) => Result.gen(function* () { ... })` into `ResultTask.fn` / `Result.fn`;
- converting between `pipe(value, ...steps)` and `value.pipe(...steps)` on Resultar values;
- tag-based Task `orElse` branches;
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
set the baseline severity for all 43 rules at once, or a rule map accepting `"*"` as a wildcard plus
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
throw expectedBoundaryError;

await runLegacyBoundary(); // resultar-check-disable-line no-unsafe-await
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

| Rule                                   | Option                             | Default      | What it checks                                                                                                                                                                                     |
| -------------------------------------- | ---------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no-await-in-result-task-gen`          | `noAwaitInResultTaskGen`           | `warning`    | Prevents `await` from breaking laziness and typing inside `ResultTask.gen` / `ResultTask.fn`                                                                                                       |
| `no-await-in-safe-try`                 | `noAwaitInSafeTry`                 | `error`      | Prevents `await` from unwrapping Resultar control flow inside `Result.gen` / `Result.fn` / `ResultAsync.gen` / `ResultAsync.fn` / legacy `safeTry`                                                 |
| `no-await-result-task`                 | `noAwaitResultTask`                | `error`      | Prevents awaiting a lazy `ResultTask` / `StrictResultTask` directly without calling `.runResult()`, `.runPromise()`, `.runExit()`, or using `yield*` inside a task generator                       |
| `no-discard`                           | `noDiscard`                        | `error`      | Requires `Result`, `ResultAsync`, `ResultTask`, and `MatchMatcher` values to be handled, returned, or explicitly discarded                                                                         |
| `no-fn-iife`                           | `noFnIife`                         | `warning`    | Replaces immediately invoked `ResultTask.fn(...)()` / `Result.fn(...)()` with `ResultTask.gen(...)` / `Result.gen(...)`                                                                            |
| `no-invalid-lifetime`                  | `noInvalidLifetime`                | `warning`    | Rejects dependencies a longer-lived service cannot capture, such as a singleton on a scoped service                                                                                                |
| `no-promise-in-result-success`         | `noPromiseInResultSuccess`         | `warning`    | Prevents Promises inside synchronous `Result` or lazy `ResultTask` success channels                                                                                                                |
| `no-promise-resultar`                  | `noPromiseResultar`                | `error`      | Rejects native `Promise<ResultTask>` / `Promise<StrictResultTask>` contracts and inferred async wrappers, recommending direct `ResultTask` returns (allows `Promise<Result>` execution boundaries) |
| `no-result-in-task-gen`                | `noResultInTaskGen`                | `warning`    | Requires `ResultTask.gen` / `ResultTask.fn` and `Result.gen` / `Result.fn` bodies to return plain success values instead of nested `ok`/`err` results                                              |
| `no-run-inside-gen`                    | `noRunInsideGen`                   | `warning`    | Prevents executing task runners (`runPromise`, `runResult`, `runExit`, `runFork`) or `_unsafeUnwrap` / `unwrapOrThrow` inside a Resultar generator                                                 |
| `no-tagged-error-constructor-override` | `noTaggedErrorConstructorOverride` | `warning`    | Protects the constructor generated by `createTaggedError`                                                                                                                                          |
| `no-throw`                             | `noThrow`                          | `off`        | Reports throw-based expected-failure control flow                                                                                                                                                  |
| `no-throw-in-task-sync`                | `noThrowInTaskSync`                | `warning`    | Reports `throw` inside `ResultTask.sync`, where failures become defects instead of typed errors                                                                                                    |
| `no-try-catch`                         | `noTryCatch`                       | `off`        | Reports broad `try`/`catch` where a typed Resultar boundary is preferred                                                                                                                           |
| `no-try-catch-in-safe-try`             | `noTryCatchInSafeTry`              | `warning`    | Keeps throwing APIs outside `Result.gen` / `Result.fn` / `ResultAsync.gen` / `ResultAsync.fn` / legacy `safeTry` generators                                                                        |
| `no-unnecessary-err-wrap-in-gen`       | `noUnnecessaryErrWrapInGen`        | `suggestion` | Prefers `TaggedError.err(...)` / `TaggedError.taskErr(...)` over wrapping `new TaggedError(...)` in `err(...)` / `ResultTask.err(...)` inside a generator                                          |
| `no-unsafe-await`                      | `noUnsafeAwait`                    | `off`        | Reports Promise awaits that can reject outside a typed Resultar boundary                                                                                                                           |
| `no-unknown-result-error`              | `noUnknownResultError`             | `suggestion` | Rejects `unknown` or `any` Resultar error channels                                                                                                                                                 |
| `no-unknown-task-requirements`         | `noUnknownTaskRequirements`        | `suggestion` | Rejects `unknown` or `any` task requirements, including type aliases                                                                                                                               |
| `unused-suppression`                   | `unusedSuppression`                | `suggestion` | Reports unknown suppression IDs and unused entries for enabled rules                                                                                                                               |
| `no-unscoped-acquire-release`          | `noUnscopedAcquireRelease`         | `warning`    | Checks ownership of `acquireRelease` / `acquireDisposable`; accepts factories propagating `ResultTaskScope` to callers                                                                             |
| `no-useless-recovery`                  | `noUselessRecovery`                | `warning`    | Removes recovery operators from infallible error channels                                                                                                                                          |
| `prefer-acquire-disposable`            | `preferAcquireDisposable`          | `suggestion` | Prefers `ResultTask.acquireDisposable` when `acquireRelease` only calls `[Symbol.dispose]` / `[Symbol.asyncDispose]`                                                                               |
| `prefer-and-then`                      | `preferAndThen`                    | `warning`    | Replaces `map` callbacks that return Resultar values with fallible chaining                                                                                                                        |
| `prefer-as-void`                       | `preferAsVoid`                     | `suggestion` | Replaces `.map(() => undefined)` with `.asVoid()` on `ResultTask`                                                                                                                                  |
| `prefer-catch-reason`                  | `preferCatchReason`                | `warning`    | Uses reason-aware recovery instead of manually checking nested reason tags                                                                                                                         |
| `prefer-filter-or-else`                | `preferFilterOrElse`               | `suggestion` | Replaces `andThen` callbacks that only branch on a predicate to return the input or an error with `filterOrElse`                                                                                   |
| `prefer-first-success-of`              | `preferFirstSuccessOf`             | `warning`    | Replaces long independent fallback chains with ordered candidates (`ResultTask.firstSuccessOf` / `firstSuccessOf`)                                                                                 |
| `prefer-map`                           | `preferMap`                        | `warning`    | Replaces fallible chaining that only wraps a plain success value                                                                                                                                   |
| `prefer-map-err`                       | `preferMapErr`                     | `warning`    | Replaces recovery that only transforms an error into another error                                                                                                                                 |
| `prefer-or-else-succeed`               | `preferOrElseSucceed`              | `suggestion` | Replaces `orElse` callbacks that unconditionally wrap a fallback in `ok` / `ResultTask.ok` with `orElseSucceed`                                                                                    |
| `prefer-result-async`                  | `preferResultAsync`                | `off`        | Opt-in eager-contract policy (`resultar/async`): reports `Promise<Result>` and `Promise<StrictResult>` contracts and inferred function returns; mode `all` also reports raw Promise contracts      |
| `prefer-result-for-each`               | `preferResultForEach`              | `warning`    | Replaces map-then-combine allocation with Resultar collection helpers (`Result.forEach`, `ResultTask.forEach`)                                                                                     |
| `prefer-tagged-error`                  | `preferTaggedError`                | `warning`    | Encourages stable tagged domain errors over plain `Error` values                                                                                                                                   |
| `prefer-tap`                           | `preferTap`                        | `suggestion` | Replaces `map` / `andThen` side-effect callbacks that return their input unchanged with `tap` (`ResultTask`) or `inspect` (`Result` / `ResultAsync`)                                               |
| `prefer-tap-error`                     | `preferTapError`                   | `suggestion` | Replaces `orElse` side-effect callbacks that re-wrap the same error with `tapError` (`ResultTask`) or `inspectError` (`Result` / `ResultAsync`)                                                    |
| `require-return-yield-star`            | `requireReturnYieldStar`           | `warning`    | Requires `return yield*` when yielding an always-failing error (`Err<never, E>` / `ResultTask<never, E, R>`) so TypeScript narrows control flow                                                    |
| `tagged-error-name-match`              | `taggedErrorNameMatch`             | `warning`    | Keeps the generated runtime tag equal to the TypeScript class name                                                                                                                                 |
| `typed-catch-mapper`                   | `typedCatchMapper`                 | `warning`    | Requires throwing and rejecting boundaries to map causes into concrete errors                                                                                                                      |
| `unnecessary-pipe`                     | `unnecessaryPipe`                  | `suggestion` | Reports single-argument `pipe(x)` and zero-argument `.pipe()` calls                                                                                                                                |
| `unsafe-result-type-assertion`         | `unsafeResultTypeAssertion`        | `warning`    | Prevents assertions that remove Resultar failures, task services, or deferred scope errors (including unknown bridges)                                                                             |
| `yield-star-in-result-task-gen`        | `yieldStarInResultTaskGen`         | `warning`    | Requires `yield*` for tasks and services inside `ResultTask.gen` / `ResultTask.fn`                                                                                                                 |
| `yield-star-in-safe-try`               | `yieldStarInSafeTry`               | `warning`    | Requires `yield*` to compose Resultar values inside `Result.gen` / `Result.fn` / `ResultAsync.gen` / `ResultAsync.fn` / legacy `safeTry`                                                           |

Rules understand both method, static data-first, and curried `pipe` composition forms where applicable (including `Semaphore.withPermit` / `withPermits`, `Fiber` operations, `Match` finalizers, and static `Result` / `ResultAsync` / `ResultTask` helpers). In `no-discard`, `Promise<Result>` / `Promise.all(...).then(...)` and array `.map` / `.forEach` / `.flatMap` chains are tracked through callback targets—including curried/static Resultar consumers, transformers, and tuple combiners (`Result.all`, `Result.combine`, `Result.validateAll`), `.bind(...)`, conditional callbacks, object-literal property callbacks, and higher-order callback factories—when the outer Promise or mapped collection is consumed or returned. ResultTask-aware checks
cover ignored tasks, unknown or narrowed error and requirements channels, nested tasks returned from `map`, Promises
stored in task successes, useless recovery, and generator composition. Task checks and recovery refactors
prefer `ok` / `err`, `mapErr`, `andThen`, and `orElse`. The checker also recognizes the retained
deprecated Task aliases `succeed` / `fail`, `mapError`, `flatMap`, and `catchAll`. Prefer
`RetryPolicy` for retry configuration and `{ ok, err }` for object-form matching; existing forms
remain supported during migration.

Generator rules also cover `Result.gen`, `Result.fn`, `ResultAsync.gen`, `ResultAsync.fn`, and `ResultTask.fn`. Static ResultTask, Result, and ResultAsync namespace recognition and
generator recognition resolve imported symbols, including renamed imports, namespace imports,
and barrel reexports. Rule IDs retain the `safe-try` spelling for `Result.gen`, `Result.fn`, `ResultAsync.gen`, `ResultAsync.fn`, and legacy `safeTry`.

For v5 application code, prefer lazy `ResultTask` workflows and explicit runners (`task.runResult()` returns a native `Promise<Result<T, E>>`). Opt-in `ResultAsync`
and `StrictResultAsync` live in `"resultar/async"` for legacy eager, single-execution contracts.

`noAwaitResultTask` defaults to `"error"`: awaiting a `ResultTask` or `StrictResultTask` directly does not execute it because tasks are lazy and have no `.then`. Call `.runResult()`, `.runPromise()`, or `.runExit()` at an imperative boundary, or use `yield*` inside `ResultTask.gen` / `ResultTask.fn`. When the operand is narrowed to a requirement-free `ResultTask` and the surrounding context expects a `Result`, `resultar-check` offers a safe `.runResult()` autofix.

`noPromiseResultar` defaults to `"error"`, including when `"preferResultAsync": "off"`.
These contracts fail validation even with `"failOn": "error"`:

- `Promise<ResultTask<T, E, R>>` -> return `ResultTask<T, E, R>` directly without an `async` wrapper (or compose external Promise work inside `ResultTask.tryPromise`);
- `Promise<StrictResultTask<T, E, R>>` -> return `StrictResultTask<T, E, R>` directly without an `async` wrapper;
- Promise unions containing `ResultTask` / `StrictResultTask` -> keep the workflow lazy and return `ResultTask` directly.

An `async` function returning a `ResultTask` resolves only the lazy Task description without executing it. `no-promise-resultar` inspects both explicit contract annotations (including aliases, methods, and Promise payload unions) and unannotated `async` factories using Resultar symbol identity, while **allowing** `Promise<Result<T, E>>`, `Promise<StrictResult<T, E>>`, `Promise<Exit<T, E>>` runner boundaries, and raw `Promise<T>` SDK inputs.

The opt-in rule `prefer-result-async` defaults to `"off"` in v5 and is retained for teams enforcing an existing `"resultar/async"` eager boundary policy. Set `"preferResultAsync": "warning"` or `"error"` only if your project enforces eager `ResultAsync` contracts.

The rule checks type references (including aliases, interface properties and methods) and
inferred function returns. `preferResultAsyncMode` controls its scope:

- `result` (default): reports `Promise<Result>` and `Promise<StrictResult>`. Ordinary promises and
  unrelated types named `Result` remain valid.
- `all`: also reports raw `Promise<T>` contracts such as a repository returning
  `Promise<User | undefined>`, including Promise members of unions and intersections. Removing an
  annotation does not bypass the rule: inferred Promise-returning functions are checked too.

Both modes leave `ResultAsync`, `StrictResultAsync`, `ResultTask`, `PromiseLike` interoperability
contracts and unrelated types named `Promise` alone. The rule provides migration guidance instead
of an annotation-only fix: an `async` function still returns a native Promise even when its body
returns a `ResultAsync`.

For new async code, return a Task and capture external failures where they originate:

```ts
import { ResultTask } from "resultar";

const load = (): ResultTask<User, LoadError> =>
  ResultTask.tryPromise({
    try: fetchUser,
    catch: (cause) => new LoadError({ cause }),
  });

const result = await load().runResult();
```

Task has no `.then`; `map` is synchronous, and `match` produces another Task to run. Match the
`Result` above for an immediate boundary response. To preserve an existing eager `"resultar/async"` contract,
return the composed operation directly instead of declaring the wrapper `async`:

```ts
import { tryResultAsync, type StrictResultAsync } from "resultar/async";

const load = (): StrictResultAsync<User, LoadError> =>
  tryResultAsync(fetchUser, (cause) => new LoadError({ cause }));
```

Set `"preferResultAsync": "error"` only when enforcing that eager compatibility convention.
`"preferResultAsyncMode": "all"` extends it to raw Promise repository and service contracts;
the Fastify compatibility fixture demonstrates this optional policy. Map driver failures in the
repository adapter and compose the result in the service. In a new Task workflow, adapt an existing
Async method with `ResultTask.fromResultAsync(() => legacyRepository.findById(id))`; the factory
creates a fresh eager operation on each Task run instead of reusing an already-started value.

Deliberate native execution or interoperability boundaries can use a line suppression for this
rule, or a file severity override for dedicated boundary files. This includes Fastify's native
bootstrap/handler contracts and Promise-returning driver callbacks passed to conversion helpers;
the rule does not automatically exempt callbacks. Keep suppressions at the conversion boundary,
with the reason documented, so application contracts stay checked.

## Rule Analysis Boundaries

### Resource scopes (`no-unscoped-acquire-release`)

Resource factories may return a task carrying `ResultTaskScope<E>` and compose across files.
The caller can use `ResultTask.scoped`, a root `run*` boundary (which creates and closes its own
scope), or an explicit scope owner. The scope requirement also tracks pending release errors;
its presence alone does not imply a leak. `no-unscoped-acquire-release` retains its syntactic
fallback when a generator's type does not expose a scope requirement. Requirement-erasing
assertions remain covered by `unsafe-result-type-assertion`.

### Cause recovery (`no-useless-recovery`)

`no-useless-recovery` uses the typed failure channel for typed-only recovery methods.
It does not flag `catchCause` merely because `E` is `never`: runtime defects can still reach cause
recovery. This applies to instance, static and curried calls. External interruption keeps its
runtime semantics and cannot be swallowed by this diagnostic correction.

### Promise defect boundaries

`ResultTask.fromPromise(signal => operation(signal))` defers a raw Promise factory
until each run and returns `ResultTask<A, never, never>`. Throws and rejections
become runtime defects; `runResult()` rejects for these failures. Use
`tryPromise({ try, catch })` for expected errors and `fromResultAsync` for existing
Result-producing operations. Unlike eager `ResultAsync.fromPromise`, this factory
accepts no error mapper or already-started Promise.

Cancellation waits for settlement. Register resource ownership directly with
`acquireRelease` before composing transformations so late acquisitions are released.
The checker recognizes async factories as explicit defect boundaries for
`no-unsafe-await`; `catchCause` remains meaningful even when `E = never`.

### Static lifetime graph boundaries (`no-invalid-lifetime`)

`no-invalid-lifetime` follows immutable `createModule()` chains and const aliases,
known `merge` inputs and value `override` operations. It reads named dependencies
and token/class `make` task requirements. Each composition has its own graph;
identically named services in separate roots are unrelated. Findings include the
direct consumer → dependency edge, both lifetimes, and both registration locations
in the existing message field. The JSON/CLI/LSP diagnostic schema is unchanged.
No fix automatically promotes a dependency to singleton.

Dynamic factories, mutable aliases, computed registration names/dependency arrays,
and unknown merge inputs are analysis boundaries. The rule does not invent edges
across them. A direct invalid edge explains a longer invalid path; runtime DI
validation remains authoritative for graphs the static checker cannot establish.

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

- the `resultar-check` executable, including `migrate-v5`, `overview`, `quickfixes`, `lsp`, `init`, and `doctor`;
- `resultar-check/schema.json` for editor completion and configuration validation;
- one optional native package for the current operating system and architecture.

It does not expose a JavaScript diagnostics API, editor extension, TypeScript plugin implementation,
or JSR package. The Node entry point only selects and executes the matching native binary.

For backend architecture, local Go commands, and TypeScript-Go revision details, see the
[native backend README](native/README.md). For an executable catalog of every rule, see the
[Resultar Check example](../../examples/check/README.md).

## License

MIT
