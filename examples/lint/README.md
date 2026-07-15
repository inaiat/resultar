# Resultar Lint Adapter Example

This package verifies that the nine syntax-only Resultar rules produce equivalent diagnostics through
three surfaces:

- the Oxlint JavaScript plugin;
- the ESLint flat-config plugin;
- the `resultar-check` CLI configured with only the matching AST-only rules.

The authoritative project gate remains the full `resultar-check` CLI with the normal project
`tsconfig.json`. This fixture narrows the CLI configuration only so its output can be compared with
lint hosts that do not have TypeScript type information.

## Run the parity smoke

From the repository root:

```sh
pnpm --filter resultar-oxlint-example smoke
```

The smoke expects every checker to reject the diagnostics fixture, then verifies that each surface
reports the same per-rule counts.

Run an individual surface with:

```sh
pnpm --filter resultar-oxlint-example check:oxlint
pnpm --filter resultar-oxlint-example check:eslint
pnpm --filter resultar-oxlint-example check:resultar-check
```

| Script                 | Host                      | Configuration                                                  |
| ---------------------- | ------------------------- | -------------------------------------------------------------- |
| `check:oxlint`         | Oxlint JavaScript plugin  | [`oxlint.config.json`](oxlint.config.json)                     |
| `check:eslint`         | ESLint flat-config plugin | [`eslint.config.mjs`](eslint.config.mjs)                       |
| `check:resultar-check` | `resultar-check` CLI      | [`tsconfig.resultar-check.json`](tsconfig.resultar-check.json) |

## Fixtures

- [`src/index.ts`](src/index.ts) is the diagnostics catalog. It includes broader checker examples,
  but this smoke asserts only the AST-only subset.
- [`src/resultar-clean.ts`](src/resultar-clean.ts) demonstrates accepted Resultar patterns for the
  same situations and must remain free of Resultar diagnostics.
- [`scripts/smoke.ts`](scripts/smoke.ts) normalizes output from the three reporters and compares the
  per-rule counts.

Reporter rule IDs differ only in formatting:

- Oxlint: `resultar(rule-name)`
- ESLint: `resultar/rule-name`
- `resultar-check`: `resultar/rule-name`

## Expected diagnostics

The fixture currently produces 14 diagnostics:

| Rule                                            | Count |
| ----------------------------------------------- | ----: |
| `resultar/no-await-in-safe-try`                 |     1 |
| `resultar/no-tagged-error-constructor-override` |     1 |
| `resultar/no-throw`                             |     3 |
| `resultar/no-try-catch`                         |     2 |
| `resultar/no-try-catch-in-safe-try`             |     1 |
| `resultar/prefer-tagged-error`                  |     3 |
| `resultar/tagged-error-name-match`              |     1 |
| `resultar/typed-catch-mapper`                   |     1 |
| `resultar/yield-star-in-safe-try`               |     1 |

See the [Resultar Check guide](../../packages/check/README.md) for the recommended workflow: CLI
first, TypeScript language-server diagnostics second, and optional lint adapters afterward.
