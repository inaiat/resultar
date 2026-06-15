# Resultar Workspace

If you are evaluating or using the main library, start here:

- [resultar package README](packages/resultar/README.md)
- [full Resultar guide](DOCUMENTATION.md)
- [API map](DOCUMENTATION.md#api-map)

Resultar is a small TypeScript toolkit for explicit error handling. The workspace contains the core
library, compiler-backed diagnostics, and a TypeScript native-preview wrapper for projects that want
Resultar values to be difficult to ignore.

## Packages

| Package | Purpose | Documentation |
| --- | --- | --- |
| `resultar` | Core `Result<T, E>` and `ResultAsync<T, E>` library with tagged errors, typed async helpers, redaction, and strict result aliases. | [package README](packages/resultar/README.md), [full guide](DOCUMENTATION.md) |
| `resultar-lint` | TypeScript compiler-backed diagnostics for discarded `Result` / `ResultAsync` values and Resultar-specific code patterns. | [lint README](packages/resultar-lint/README.md) |
| `resultar-tsgo` | Wrapper around `@typescript/native-preview` that runs native `tsgo` and then Resultar lint validation. | [tsgo README](packages/resultar-tsgo/README.md) |

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
- `ResultAsync.timeout`, `retry`, `retryOrElse`, `race`, `raceAll`, and `withResource`
- `safeTry`, `matchTags`, local recovery, and boundary response mapping

## Documentation Map

Use the full guide when you need a specific recipe:

| Topic | Link |
| --- | --- |
| Core model | [The Model](DOCUMENTATION.md#the-model) |
| Tagged errors | [Tagged Errors](DOCUMENTATION.md#tagged-errors) |
| Redacted error props | [Redacted Error Props](DOCUMENTATION.md#redacted-error-props) |
| Catching and recovering errors | [Catching And Recovering Errors](DOCUMENTATION.md#catching-and-recovering-errors) |
| Async wrapping | [Wrapping Throwing Or Rejecting Code](DOCUMENTATION.md#wrapping-throwing-or-rejecting-code) |
| Local recovery | [Recovering Tagged Errors Locally](DOCUMENTATION.md#recovering-tagged-errors-locally) |
| Async racing and timeouts | [Concurrent Racing And Timeouts](DOCUMENTATION.md#concurrent-racing-and-timeouts) |
| Async retry policies | [Retrying Async Work](DOCUMENTATION.md#retrying-async-work) |
| Bounded async mapping | [Async Concurrency Mapping](DOCUMENTATION.md#async-concurrency-mapping) |
| Resource cleanup | [Resourceful Async Iterables](DOCUMENTATION.md#resourceful-async-iterables) |
| Safe linear result code | [Safe Try](DOCUMENTATION.md#safe-try) |
| Validation error recipes | [Validation Error Recipes](DOCUMENTATION.md#validation-error-recipes) |
| No-discard diagnostics | [No-Discard Validation](DOCUMENTATION.md#no-discard-validation) |
| Public exports | [Public Entry Point](DOCUMENTATION.md#public-entry-point) |

## Diagnostics Packages

Install `resultar-lint` when ignored results should fail editor, lint, or build checks.

```sh
pnpm add -D resultar-lint typescript
```

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "resultar-lint", "noDiscard": "error" }]
  }
}
```

For CI-style checks:

```json
{
  "scripts": {
    "lint:resultar": "resultar-lint check --project tsconfig.json"
  }
}
```

See [packages/resultar-lint/README.md](packages/resultar-lint/README.md) for all rules, Oxlint
integration, TypeScript patching, and CLI options.

Install `resultar-tsgo` only for TypeScript 7 native-preview projects that use `tsgo`:

```sh
pnpm add -D resultar-lint resultar-tsgo @typescript/native-preview
```

See [packages/resultar-tsgo/README.md](packages/resultar-tsgo/README.md) for wrapper behavior.

## Examples

| Example | Surface | What it validates |
| --- | --- | --- |
| [examples/resultar](examples/resultar) | Core Resultar cookbook | Sync validation, `safeTry`, tagged errors, async resilience, and resource cleanup |
| [examples/lint](examples/lint) | TypeScript plugin, `resultar-lint check`, patched `tsc`, Vite+ / Oxlint `jsPlugins` | Full Resultar rule set across CLI, build-time, and Vite+ diagnostics |
| [examples/tsgo-lint](examples/tsgo-lint) | TypeScript 7 native preview | `resultar-tsgo` wrapper plus full Resultar lint validation |

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

Release metadata is managed with Changesets:

```sh
pnpm changeset
pnpm run version:packages
```

Dry-run publish checks:

```sh
pnpm run release:npm -- --dry-run
pnpm run release:jsr -- --dry-run
```

## Requirements

- Node.js 24+
- TypeScript 6+ for the current packages
- ESM-only core package

The root package is private. Published package metadata and README content live in each package
directory.
