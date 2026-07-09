# Resultar Lint Adapter Example

This package demonstrates the AST-only Resultar rules exposed by `resultar-check` through three
surfaces:

- Oxlint JavaScript plugin
- ESLint flat config plugin
- `resultar-check` CLI with an AST-only rule config

The example is intentionally split into two TypeScript files:

- `src/index.ts` is a diagnostics catalog. It still includes the broader `resultar-check` rule
  examples used by the benchmark fixture, but this smoke asserts only the AST-only rules.
- `src/resultar-clean.ts` is the matching style guide. It shows the accepted Resultar pattern for
  the same AST-only situations and should stay free of Resultar diagnostics.

Run it from the repository root:

```sh
pnpm --filter resultar-oxlint-example smoke
```

The smoke runs the three check surfaces, expects each command to fail on `src/index.ts`, and then
asserts that they report the same per-rule Resultar diagnostic counts.

The `check` script runs:

```sh
pnpm run check:oxlint
```

The three explicit check scripts are:

| Script                  | Host                  | Config file                       |
| ----------------------- | --------------------- | --------------------------------- |
| `check:oxlint`          | Oxlint JS plugin      | `oxlint.config.json`              |
| `check:eslint`          | ESLint flat config    | `eslint.config.mjs`               |
| `check:resultar-check`  | `resultar-check` CLI  | `tsconfig.resultar-check.json`    |

All three are expected to return the same Resultar diagnostic count for this fixture because they
enable the same AST-only rule subset. The smoke test normalizes the different reporter formats:

- Oxlint: `resultar(rule-name)`
- ESLint: `resultar/rule-name`
- `resultar-check` CLI: `resultar/rule-name`

The expected count is 12 diagnostics:

| Rule                                            | Count |
| ----------------------------------------------- | ----: |
| `resultar/no-await-in-safe-try`                 |     1 |
| `resultar/no-tagged-error-constructor-override` |     1 |
| `resultar/no-throw`                             |     3 |
| `resultar/no-try-catch-in-safe-try`             |     1 |
| `resultar/prefer-tagged-error`                  |     3 |
| `resultar/tagged-error-name-match`              |     1 |
| `resultar/typed-catch-mapper`                   |     1 |
| `resultar/yield-star-in-safe-try`               |     1 |

## 1. Oxlint

Oxlint is the fastest adapter path and is the default `check` script for this example. The local
`oxlint.config.json` loads the workspace-built adapter:

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
    "eslint/require-yield": "off",
    "resultar/no-await-in-safe-try": "error",
    "resultar/no-tagged-error-constructor-override": "error",
    "resultar/no-throw": "error",
    "resultar/no-try-catch-in-safe-try": "error",
    "resultar/prefer-tagged-error": "error",
    "resultar/tagged-error-name-match": "error",
    "resultar/typed-catch-mapper": "error",
    "resultar/yield-star-in-safe-try": "error"
  }
}
```

The config keeps `eslint/require-yield` disabled so the fixture reports only Resultar diagnostics.

## 2. ESLint

The local ESLint config loads the same Resultar rule modules through the package export:

```js
import resultar from "resultar-check/eslint";

export default [
  {
    plugins: { resultar },
    rules: {
      "resultar/no-await-in-safe-try": "error",
      "resultar/no-tagged-error-constructor-override": "error",
      "resultar/no-throw": "error",
      "resultar/no-try-catch-in-safe-try": "error",
      "resultar/prefer-tagged-error": "error",
      "resultar/tagged-error-name-match": "error",
      "resultar/typed-catch-mapper": "error",
      "resultar/yield-star-in-safe-try": "error"
    }
  }
];
```

## 3. TypeScript Plugin + CLI

The normal TypeScript plugin plus CLI path is the full Resultar checker. For this parity fixture,
`tsconfig.resultar-check.json` enables only the matching AST-only subset for the CLI. That keeps the
CLI comparable with Oxlint and ESLint instead of reporting extra type-aware diagnostics.

```json
{
  "$schema": "./node_modules/resultar-check/schema.json",
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "plugins": [
      {
        "name": "resultar-check",
        "noAwaitInSafeTry": "error",
        "noDiscard": "off",
        "noTaggedErrorConstructorOverride": "error",
        "noThrow": "error",
        "noTryCatchInSafeTry": "error",
        "noUnsafeAwait": "off",
        "noUselessRecovery": "off",
        "preferAndThen": "off",
        "preferMapErr": "off",
        "preferTaggedError": "error",
        "taggedErrorNameMatch": "error",
        "typedCatchMapper": "error",
        "unsafeResultTypeAssertion": "off",
        "yieldStarInSafeTry": "error"
      }
    ]
  }
}
```

These adapter rules can be checked from syntax alone: safeTry generator misuse, native
`throw`/`Error` use, tagged error shape, and missing `tryResult` catch mappers.

The full type-aware Resultar checker remains in `packages/resultar-check`; use the TypeScript plugin
or `resultar-check` CLI when you need rules such as no-discard, no-unsafe-await, prefer-map-err,
prefer-and-then, unsafe-result-type-assertion, or no-useless-recovery.
