# Resultar TypeScript 7 Native Preview Example

This example uses the local `resultar-tsgo` wrapper. Its `tsgo` binary runs the TypeScript 7 native
preview compiler, then runs Resultar no-discard validation over the same `tsconfig.json`.
The example installs `@typescript/native-preview` directly so the project controls the TS7 version.

The `tsconfig.json` includes the Resultar language-service plugin config:

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "resultar-lint", "noDiscard": "error" }]
  }
}
```

Run it from the repository root:

```sh
pnpm run example:tsgo
```

Or run the lint-like command directly:

```sh
pnpm --filter resultar-tsgo-example run prepare
pnpm --filter resultar-tsgo-example lint:resultar
```

The source intentionally contains ignored `Result` and `ResultAsync` calls plus one
assigned-but-unhandled Resultar value, so `lint:resultar` fails after `tsgo` type-checks
successfully and reports the no-discard and must-use diagnostics.
