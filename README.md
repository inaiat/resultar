# Resultar Workspace

Resultar makes expected failures visible in TypeScript signatures and keeps them composable through
sync, async, retry, timeout, concurrency, cleanup, and exhaustive boundary workflows. The workspace
contains the core library, HTTP request adapters, compiler-backed diagnostics, and runnable examples.

If you are evaluating or using the main library, start with:

- [resultar package README](packages/resultar/README.md)
- [full Resultar guide](DOCUMENTATION.md)
- [API map](DOCUMENTATION.md#api-map)

## Packages

| Package                    | Purpose                                                                                                                                                             | Documentation                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `resultar`                 | Core `Result<T, E>`, lazy `ResultTask<T, E, R>`, and `ResultAsync<T, E>` library with tagged errors, typed services, async policies, redaction, and strict aliases. | [package README](packages/resultar/README.md), [full guide](DOCUMENTATION.md) |
| `resultar-check`           | Native TypeScript 7 compiler checks plus type-aware Resultar diagnostics.                                                                                           | [check README](packages/check/README.md)                                      |
| `resultar-request`         | Fetch-first JSON request helper with Resultar errors, validation, retry, and error mapping.                                                                         | [request README](packages/request/README.md)                                  |
| `resultar-request-typebox` | TypeBox adapter for `resultar-request`.                                                                                                                             | [TypeBox adapter README](packages/request-typebox/README.md)                  |
| `resultar-request-zod`     | Zod adapter for `resultar-request`.                                                                                                                                 | [Zod adapter README](packages/request-zod/README.md)                          |

## Main Library

Install the core package when you want expected failures in function signatures instead of hidden
behind `throw`, rejected promises, nullable returns, or ad hoc `T | Error` unions.

```sh
pnpm add resultar
```

```sh
npm install resultar
```

The npm package README is [packages/resultar/README.md](packages/resultar/README.md). It covers the
selling points and quick-start examples for:

- `Result<T, E>`, lazy `ResultTask<T, E>`, and `ResultAsync<T, E>`
- explicit `ResultTask` execution with typed services, generator composition, defects, and cleanup
- `StrictResult<T, E extends Error>` and `StrictResultAsync<T, E extends Error>`
- `createTaggedError`, `taggedEnum`, and redacted error props
- reusable `pipe` combinators for `Result` and `ResultAsync`
- `ResultAsync.timeout`, `retry`, `retryOrElse`, `race`, `raceAll`, and `withResource`
- `Result.gen`/`safeTry`, `matchTags`, local recovery, and boundary response mapping

## Documentation Map

Use the full guide when you need a specific recipe:

| Topic                          | Link                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| Core model                     | [The Model](DOCUMENTATION.md#the-model)                                                     |
| Tagged errors                  | [Tagged Errors](DOCUMENTATION.md#tagged-errors)                                             |
| Redacted error props           | [Redacted Error Props](DOCUMENTATION.md#redacted-error-props)                               |
| Catching and recovering errors | [Catching And Recovering Errors](DOCUMENTATION.md#catching-and-recovering-errors)           |
| Async wrapping                 | [Wrapping Throwing Or Rejecting Code](DOCUMENTATION.md#wrapping-throwing-or-rejecting-code) |
| Lazy workflows                 | [ResultTask core RFC](packages/resultar/RESULT-TASK-CORE-RFC.md)                            |
| Local recovery                 | [Recovering Tagged Errors Locally](DOCUMENTATION.md#recovering-tagged-errors-locally)       |
| Async racing and timeouts      | [Concurrent Racing And Timeouts](DOCUMENTATION.md#concurrent-racing-and-timeouts)           |
| Async retry policies           | [Retrying Async Work](DOCUMENTATION.md#retrying-async-work)                                 |
| Bounded async mapping          | [Async Concurrency Mapping](DOCUMENTATION.md#async-concurrency-mapping)                     |
| Resource cleanup               | [Resourceful Async Iterables](DOCUMENTATION.md#resourceful-async-iterables)                 |
| Safe linear result code        | [Safe Try](DOCUMENTATION.md#safe-try)                                                       |
| Validation error recipes       | [Validation Error Recipes](DOCUMENTATION.md#validation-error-recipes)                       |
| No-discard diagnostics         | [No-Discard Validation](DOCUMENTATION.md#no-discard-validation)                             |
| Public exports                 | [Public Entry Point](DOCUMENTATION.md#public-entry-point)                                   |

## Resultar Check

Use `resultar-check` as the canonical Resultar diagnostics command. Its native TypeScript-Go backend
runs the compiler first, then runs every enabled Resultar diagnostic over the same `tsconfig.json`.

```sh
pnpm add -D resultar-check
```

```json
{ "scripts": { "check": "resultar-check" } }
```

`resultar-check` defaults to `tsconfig.json` and runs TypeScript with no emit.

Version 3 is native-only: a small Node launcher selects a platform package, then the TypeScript-Go
binary performs compiler diagnostics and all 22 Resultar rules in one project pass. It also exposes:

- human, JSON Lines, SARIF 2.1.0, and JUnit output;
- configurable severities, file overrides, suppressions, and CI `failOn` policy;
- a stdio LSP server with diagnostics and safe composition quick fixes;
- `init` and `doctor` commands for a portable Zed setup;
- macOS, Linux, and Windows binaries for ARM64 and x64.

See [packages/check/README.md](packages/check/README.md) for the recommended `noDiscard`, `noThrow`,
and `noTryCatch` configuration, every diagnostic, output formats, editor setup, and the v3 migration
guide.

## Examples

| Example                                | Surface                | What it validates                                                                 |
| -------------------------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| [examples/resultar](examples/resultar) | Core Resultar cookbook | Sync validation, `safeTry`, tagged errors, async resilience, and resource cleanup |
| [examples/check](examples/check)       | Native diagnostics     | Exact findings for all 22 rules plus a zero-diagnostic clean project              |
| [examples/request](examples/request)   | Request helpers        | Fetch-style JSON calls with TypeBox and Zod adapters                              |

Run all example smokes with:

```sh
pnpm test:examples
```

## Development

Common workspace checks:

```sh
pnpm check:full
pnpm build
pnpm smoke:package
pnpm test:examples
```

Release metadata is managed with Changesets. Add a changeset with the feature or fix:

```sh
pnpm changeset
```

After the change merges to `main`, the `Release` workflow opens or updates a `Version packages` PR.
When that PR is merged, CI publishes npm and JSR from the versioned package metadata.

Dry-run publish checks:

```sh
pnpm run release:npm -- --dry-run
pnpm run release:jsr -- --dry-run
```

## Requirements

- Node.js 24+
- ESM-only core package

The root package is private. Published package metadata and README content live in each package
directory.
