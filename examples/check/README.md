# Resultar Check Example

This package exercises the native TypeScript-Go implementation of `resultar-check`.

It deliberately keeps three independent projects:

- [`src/index.ts`](src/index.ts) is a catalog of invalid Resultar patterns and must fail with every
  supported diagnostic rule;
- [`src/resultar-clean.ts`](src/resultar-clean.ts) contains the corresponding recommended patterns
  and must pass without compiler or Resultar diagnostics;
- [`src/contracts.ts`](src/contracts.ts) enables `preferResultAsyncMode: "all"` and rejects raw
  Promise repository contracts and inferred implementations while accepting `StrictResultAsync`
  and explicit native boundary suppressions.

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

The same fixture can demonstrate CI formats directly:

```sh
pnpm --filter resultar-check-example exec resultar-check --project tsconfig.json --format sarif
pnpm --filter resultar-check-example exec resultar-check --project tsconfig.json --format junit
```

The diagnostics catalog covers:

- must-use handling for `Result`, `ResultAsync`, and lazy `ResultTask` values;
- safe sync, async, and generator boundaries;
- `map`, `andThen`, recovery, fallback, and collection simplifications;
- concrete error channels, safe type assertions, and typed catch mappers;
- tagged-error construction and naming conventions;
- Promise safety, `ResultAsync` service contracts, raw `await`, and exact ignored-call paths;
- `yield*` composition in both `safeTry` and `ResultTask.gen`;
- DI lifetimes, `acquireRelease` scope ownership, plain `gen` returns, and typed `sync` failures.

The smoke test builds the Resultar package, the `resultar-check` launcher, and the native binary for
the current platform. It then verifies that:

- all 28 native rules report their exact expected finding counts;
- every configured severity is `error`;
- TypeScript-Go reports no compiler diagnostics;
- the clean fixture exits successfully.
- the all-mode contract fixture reports exactly two errors.

Rule configuration lives in [`tsconfig.json`](tsconfig.json). The
[`tsconfig.clean.json`](tsconfig.clean.json) project inherits the same configuration and changes only
the included source file.
[`tsconfig.contracts.json`](tsconfig.contracts.json) enables the stricter async contract policy.

## Limitations

This is a diagnostics fixture, not application code: `src/index.ts` is intentionally invalid and
must keep failing, while only `src/resultar-clean.ts` shows the recommended patterns. The catalog
covers the 28 implemented native rules; it does not promise future rules, auto-fixes, or IDE
integrations.
