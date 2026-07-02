# Resultar Workspace

If you are evaluating or using the main library, start here:

- [resultar package README](packages/resultar/README.md)
- [full Resultar guide](DOCUMENTATION.md)
- [API map](DOCUMENTATION.md#api-map)

Resultar is a small TypeScript toolkit for explicit error handling. The workspace contains the core
library and TypeScript 7 compiler-backed diagnostics for projects that want Resultar values to be
difficult to ignore.

## Packages

| Package                    | Purpose                                                                                                                            | Documentation                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `resultar`                 | Core `Result<T, E>` and `ResultAsync<T, E>` library with tagged errors, typed async helpers, redaction, and strict result aliases. | [package README](packages/resultar/README.md), [full guide](DOCUMENTATION.md) |
| `resultar-check`           | TypeScript 7 `tsc` plus Resultar diagnostics.                                                                                      | [check README](packages/resultar-check/README.md)                             |
| `resultar-request`         | Fetch-first JSON request helper with Resultar errors, validation, retry, and error mapping.                                        | [request README](packages/resultar-request/README.md)                         |
| `resultar-request-typebox` | TypeBox adapter for `resultar-request`.                                                                                            | [TypeBox adapter README](packages/resultar-request-typebox/README.md)         |
| `resultar-request-zod`     | Zod adapter for `resultar-request`.                                                                                                | [Zod adapter README](packages/resultar-request-zod/README.md)                 |
| `resultar-tsgo`            | Deprecated compatibility wrapper for older `resultar-check` installs.                                                              | [deprecated README](packages/resultar-tsgo/README.md)                         |

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

- `Result<T, E>` and `ResultAsync<T, E>`
- `StrictResult<T, E extends Error>` and `StrictResultAsync<T, E extends Error>`
- `createTaggedError`, `taggedEnum`, and redacted error props
- reusable `pipe` combinators for `Result` and `ResultAsync`
- `ResultAsync.timeout`, `retry`, `retryOrElse`, `race`, `raceAll`, and `withResource`
- `safeTry`, `matchTags`, local recovery, and boundary response mapping

## Documentation Map

Use the full guide when you need a specific recipe:

| Topic                          | Link                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| Core model                     | [The Model](DOCUMENTATION.md#the-model)                                                     |
| Tagged errors                  | [Tagged Errors](DOCUMENTATION.md#tagged-errors)                                             |
| Redacted error props           | [Redacted Error Props](DOCUMENTATION.md#redacted-error-props)                               |
| Catching and recovering errors | [Catching And Recovering Errors](DOCUMENTATION.md#catching-and-recovering-errors)           |
| Async wrapping                 | [Wrapping Throwing Or Rejecting Code](DOCUMENTATION.md#wrapping-throwing-or-rejecting-code) |
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

Use `resultar-check` as the canonical Resultar diagnostics command. It runs the TypeScript 7 native
compiler first, then runs Resultar diagnostics over the same `tsconfig.json`.

```sh
pnpm add -D resultar-check typescript@rc
```

```json
{
  "scripts": {
    "check": "resultar-check"
  }
}
```

`resultar-check` defaults to `tsconfig.json` and runs TypeScript with no emit.

Configure the Resultar rules in `tsconfig.json`:

```json
{
  "$schema": "./node_modules/resultar-check/schema.json",
  "compilerOptions": {
    "plugins": [
      {
        "name": "resultar-check",
        "ignoreFilePatterns": ["*.test.ts"],
        "noDiscard": "error"
      }
    ]
  }
}
```

The package-local schema provides editor completion and validation for `resultar-check` plugin
options.

See [packages/resultar-check/README.md](packages/resultar-check/README.md) for rule configuration.
Oxlint is intentionally not part of the Resultar rules path.

For editor diagnostics, use the same `compilerOptions.plugins` entry and configure your editor to use
the workspace TypeScript version. The check package guide includes copy-paste setup for VS Code, Zed
`vtsls`, and Zed `typescript-language-server`.
If a project cannot replace its `typescript` package yet and only needs the CLI path, install
`typescript-7@npm:typescript@rc` instead.

## Examples

| Example                                                | Surface                     | What it validates                                                                 |
| ------------------------------------------------------ | --------------------------- | --------------------------------------------------------------------------------- |
| [examples/resultar](examples/resultar)                 | Core Resultar cookbook      | Sync validation, `safeTry`, tagged errors, async resilience, and resource cleanup |
| [examples/lint](examples/lint)                         | TypeScript 7 Resultar check | `resultar-check` plus the full Resultar rule set                                  |
| [examples/resultar-request](examples/resultar-request) | Request helpers             | Fetch-style JSON calls with TypeBox and Zod adapters                              |

The deprecated `resultar-tsgo` package remains only as a compatibility wrapper.

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
- TypeScript 7 RC for the canonical `resultar-check` workflow
- ESM-only core package

The root package is private. Published package metadata and README content live in each package
directory.
