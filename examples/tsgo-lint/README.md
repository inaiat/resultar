# Resultar TypeScript 7 Lint Example

This example uses the local `resultar-tsgo` wrapper. Its `tsgo` binary runs `typescript@rc` through
the `typescript-7` alias, then runs Resultar lint validation over the same `tsconfig.json`. The
example installs `typescript-7` directly so the project controls the TS7 version.

The `tsconfig.json` includes the Resultar language-service plugin config:

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "resultar-lint",
        "noDiscard": "error",
        "preferMapErr": "error",
        "preferAndThen": "error",
        "typedCatchMapper": "error"
      }
    ]
  }
}
```

The local example config enables every current Resultar rule as an error.

Run it from the repository root:

```sh
pnpm run example:tsgo-lint
```

Or run the lint-like command directly:

```sh
pnpm --filter resultar-tsgo-lint-example run prepare
pnpm --filter resultar-tsgo-lint-example lint:resultar
```

The source intentionally contains ignored `Result` and `ResultAsync` calls, one
assigned-but-unhandled Resultar value, untyped catch conversion, `safeTry` misuse, unsafe
error-channel assertions, tagged-error definition mistakes, and useless recovery calls. The smoke
test verifies that `lint:resultar` fails after `tsgo` type-checks successfully and reports every
`resultar/*` rule.
