# Resultar Language Service Example

This example contains both sides of the `resultar-lint` rules:

- `src/index.ts` intentionally violates every rule.
- `src/resultar-clean.ts` uses the corresponding correct Resultar patterns and should not report
  diagnostics.

This package covers both supported TypeScript 6 linting surfaces:

| Command                                             | Tooling surface                                        |
| --------------------------------------------------- | ------------------------------------------------------ |
| `pnpm --filter resultar-lint-example check`         | Vite+ / Oxlint `jsPlugins` with `resultar-lint/oxlint` |
| `pnpm --filter resultar-lint-example check-ts`      | Plain TypeScript with the `resultar-lint` plugin       |
| `pnpm --filter resultar-lint-example lint:resultar` | Resultar CLI diagnostics                               |

The TypeScript 7 native preview wrapper remains in [`../tsgo-lint`](../tsgo-lint).

Run every lint example surface from the repository root with `pnpm test:language-service`.

The `tsconfig.json` enables editor diagnostics:

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "resultar-lint",
        "noDiscard": "error",
        "preferAndThen": "error",
        "typedCatchMapper": "error"
      }
    ]
  }
}
```

The `check` script runs Vite+ / Oxlint. The `check-ts` script is plain `tsc`, and the `prepare`
script patches the local TypeScript install when you want build-time Resultar diagnostics from
TypeScript.

The failing file covers:

- `resultar/no-discard`
- `resultar/prefer-map-err`
- `resultar/prefer-and-then`
- `resultar/typed-catch-mapper`
- `resultar/no-try-catch-in-safe-try`
- `resultar/yield-star-in-safe-try`
- `resultar/unsafe-result-type-assertion`
- `resultar/prefer-tagged-error`
- `resultar/tagged-error-name-match`
- `resultar/no-tagged-error-constructor-override`
- `resultar/no-useless-recovery`

The clean file shows:

- handling all `Result` and `ResultAsync` values
- using `andThen` for fallible composition
- using `mapErr` for error transformations
- providing typed catch mappers for `tryResult` and `fromPromise`
- using `yield*` inside `safeTry`
- using `createTaggedError` classes with matching names and generated constructors

For day-to-day project DX, use the lint-like command:

```sh
pnpm --filter resultar-lint-example lint:resultar
```

To run the Vite+ / Oxlint surface:

```sh
pnpm --filter resultar-lint-example check
```

Run the full build-time smoke from the repository root:

```sh
pnpm run example:lint
```

To see the Resultar error printed by `tsc`, run the prepare step first:

```sh
pnpm --filter resultar-lint-example run prepare
pnpm --filter resultar-lint-example check-ts
```

The smoke script verifies:

- unpatched `check-ts` passes because TypeScript plugins are editor-only by default
- the lint-like `resultar-lint check` command fails with every Resultar rule name
- `src/resultar-clean.ts` has no lint diagnostics
- `vp check` fails with every Resultar rule name through `resultar-lint/oxlint`
- `resultar-lint patch` is idempotent
- patched `check-ts` fails with every enabled Resultar rule from `tsconfig.json`
- `resultar-lint unpatch` restores the original TypeScript behavior

The TypeScript patch supports TypeScript 6.x and delegates to the installed `resultar-lint` runtime,
so build-time diagnostics stay aligned with the CLI and editor plugin.

Manual commands:

```sh
pnpm --filter resultar build
pnpm --filter resultar-lint build
pnpm --filter resultar-lint-example lint:resultar
pnpm --filter resultar-lint-example check
pnpm --filter resultar-lint-example run prepare
pnpm --filter resultar-lint-example check-ts
pnpm --filter resultar-lint-example exec resultar-lint unpatch
```
