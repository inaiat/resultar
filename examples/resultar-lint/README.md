# Resultar Language Service Example

This example intentionally discards two Resultar values and leaves one assigned Resultar value
unhandled in `src/index.ts`.

The `tsconfig.json` enables editor diagnostics:

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "resultar-lint", "noDiscard": "error" }]
  }
}
```

This example copies the Effect language-service setup pattern: `prepare` patches the local
TypeScript install, and `check` is plain `tsc`.

For day-to-day project DX, use the lint-like command:

```sh
pnpm --filter resultar-lint-example lint:resultar
```

Run the full build-time smoke from the repository root:

```sh
pnpm run example:language-service
```

To see the Resultar error printed by `tsc`, run the prepare step first:

```sh
pnpm --filter resultar-lint-example run prepare
pnpm --filter resultar-lint-example check
```

The smoke script verifies:

- unpatched `tsc` passes because TypeScript plugins are editor-only by default
- the lint-like `resultar-lint check` command fails with `no-discard-result`
- `resultar-lint patch` is idempotent
- patched `tsc` fails with `[resultar/noDiscard]` for ignored and assigned-but-unhandled values
- `resultar-lint unpatch` restores the original `tsc` behavior

Manual commands:

```sh
pnpm --filter resultar build
pnpm --filter resultar-lint build
pnpm --filter resultar-lint-example lint:resultar
pnpm --filter resultar-lint-example check
pnpm --filter resultar-lint-example run prepare
pnpm --filter resultar-lint-example check
pnpm --filter resultar-lint-example exec resultar-lint unpatch
```
