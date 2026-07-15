# Resultar Workspace

Resultar makes expected failures visible in TypeScript signatures and keeps them composable through
sync, async, retry, timeout, concurrency, cleanup, and exhaustive boundary workflows. The workspace
contains the core library, HTTP request adapters, compiler-backed diagnostics, and runnable examples.

If you are evaluating or using the main library, start with:

- [resultar package README](packages/resultar/README.md)
- [full Resultar guide](DOCUMENTATION.md)
- [API map](DOCUMENTATION.md#api-map)

## Packages

| Package                    | Purpose                                                                                                                            | Documentation                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `resultar`                 | Core `Result<T, E>` and `ResultAsync<T, E>` library with tagged errors, typed async helpers, redaction, and strict result aliases. | [package README](packages/resultar/README.md), [full guide](DOCUMENTATION.md) |
| `resultar-check`           | `tsc` plus Resultar diagnostics for TypeScript >=7, with AST-only adapters for Oxlint, ESLint, and Deno Lint.                      | [check README](packages/check/README.md)                                      |
| `resultar-request`         | Fetch-first JSON request helper with Resultar errors, validation, retry, and error mapping.                                        | [request README](packages/request/README.md)                                  |
| `resultar-request-typebox` | TypeBox adapter for `resultar-request`.                                                                                            | [TypeBox adapter README](packages/request-typebox/README.md)                  |
| `resultar-request-zod`     | Zod adapter for `resultar-request`.                                                                                                | [Zod adapter README](packages/request-zod/README.md)                          |

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

Use `resultar-check` as the canonical Resultar diagnostics command. It requires TypeScript >=7, runs
the compiler first, then runs every enabled Resultar diagnostic over the same `tsconfig.json`.

```sh
pnpm add -D resultar-check "typescript@>=7"
```

```json
{
  "scripts": {
    "check": "resultar-check"
  }
}
```

`resultar-check` defaults to `tsconfig.json` and runs TypeScript with no emit.

Use the TypeScript language-service plugin for the same enabled diagnostics while editing. Once the
CLI and language server are working, optionally add Oxlint, ESLint, or Deno Lint for the nine rules
that can run without type information.

See [packages/check/README.md](packages/check/README.md) for the recommended `noDiscard`, `noThrow`,
and `noTryCatch` configuration, every rule, editor setup, ignore patterns, and lint adapters.

## Examples

| Example                                | Surface                | What it validates                                                                 |
| -------------------------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| [examples/resultar](examples/resultar) | Core Resultar cookbook | Sync validation, `safeTry`, tagged errors, async resilience, and resource cleanup |
| [examples/lint](examples/lint)         | Lint adapter parity    | AST-only Resultar rules compared across Oxlint, ESLint, and `resultar-check` CLI  |
| [examples/request](examples/request)   | Request helpers        | Fetch-style JSON calls with TypeBox and Zod adapters                              |

Run all example smokes with:

```sh
pnpm test:examples
```

The lint example also exposes the individual parity commands:

```sh
pnpm --filter resultar-oxlint-example check:oxlint
pnpm --filter resultar-oxlint-example check:eslint
pnpm --filter resultar-oxlint-example check:resultar-check
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
- TypeScript >=7 for the canonical `resultar-check` workflow
- ESM-only core package

The root package is private. Published package metadata and README content live in each package
directory.
