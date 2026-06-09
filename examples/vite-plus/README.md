# Resultar Vite+ Example

This example proves `vp check` can enforce Resultar no-discard diagnostics through Oxlint
`jsPlugins`.

`vite.config.ts` loads `resultar-ls/oxlint` and enables `resultar/no-discard`. The rule calls
Resultar's TypeScript-backed checker internally, so it reports ignored `Result` and `ResultAsync`
values even though Oxlint custom JS rules do not expose TypeScript services.

Run the smoke from the repository root:

```sh
pnpm run example:vite-plus
```

Manual commands:

```sh
pnpm --filter resultar build
pnpm --filter resultar-ls build
pnpm --filter resultar-vite-plus-example check
```
