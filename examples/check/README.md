# Resultar Check Example

This package exercises the native TypeScript-Go implementation of `resultar-check`.

It deliberately keeps two independent projects:

- [`src/index.ts`](src/index.ts) is a catalog of invalid Resultar patterns and must fail with every
  supported diagnostic rule;
- [`src/resultar-clean.ts`](src/resultar-clean.ts) contains the corresponding recommended patterns
  and must pass without compiler or Resultar diagnostics.

## Run

From the repository root:

```sh
pnpm example:check
```

To inspect the human-readable diagnostics:

```sh
pnpm --filter resultar-check-example check
```

To inspect JSON Lines output or only verify the clean fixture:

```sh
pnpm --filter resultar-check-example check:json
pnpm --filter resultar-check-example check:clean
```

The smoke test builds the Resultar package, the `resultar-check` launcher, and the native binary for
the current platform. It then verifies that:

- the diagnostics catalog fails;
- all 22 native rules report their exact expected finding counts;
- every configured severity is `error`;
- TypeScript-Go reports no compiler diagnostics;
- the clean fixture exits successfully.

Rule configuration lives in [`tsconfig.json`](tsconfig.json). The
[`tsconfig.clean.json`](tsconfig.clean.json) project inherits the same configuration and changes only
the included source file.
